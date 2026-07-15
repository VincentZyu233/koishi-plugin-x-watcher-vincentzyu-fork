import { describe, expect, it } from "@effect/vitest";
import {
  TestNow,
  makeDatabaseHarness,
  makeSharedDatabaseHarness,
  makeSubscriptionInput,
  runStore,
} from "../helpers/database";

/** 建立旧 key 下已经激活且持有远端 ID 的账号。 */
const activateRemoteAccount = async (
  harness: Awaited<ReturnType<typeof makeDatabaseHarness>>,
) => {
  const subscription = await runStore(
    harness.store.saveSubscription(
      makeSubscriptionInput({
        remoteMonitoring: true,
        remoteKeyFingerprint: "key-old",
      }),
    ),
  );
  const control = await runStore(
    harness.store.claimControl(
      TestNow,
      new Date(TestNow.getTime() + 60_000),
    ),
  );
  if (control === null) throw new Error("未生成 Account Stream add 控制任务");
  await runStore(
    harness.store.completeControl(
      control.id,
      control.claimToken,
      "remote-old",
      null,
      TestNow,
    ),
  );
  return subscription;
};

describe("远端监控配置", () => {
  it("两个实例竞争领取时仅一个获得同一控制任务", async () => {
    const shared = await makeSharedDatabaseHarness();
    try {
      await runStore(shared.primary.store.saveSubscription(makeSubscriptionInput({
        remoteMonitoring: true,
        remoteKeyFingerprint: "key-old",
      })));
      const lease = new Date(TestNow.getTime() + 60_000);
      const primary = await runStore(
        shared.primary.store.claimControl(TestNow, lease),
      );
      const secondary = await runStore(
        shared.secondary.store.claimControl(TestNow, lease),
      );
      expect(primary).not.toBeNull();
      expect(secondary).toBeNull();
    } finally {
      await shared.close();
    }
  });

  it("控制租约过期后旧 worker 不能覆盖新 worker 结果", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await runStore(harness.store.saveSubscription(makeSubscriptionInput({
        remoteMonitoring: true,
        remoteKeyFingerprint: "key-old",
      })));
      const first = await runStore(harness.store.claimControl(
        TestNow,
        new Date(TestNow.getTime() + 1_000),
      ));
      const reclaimedAt = new Date(TestNow.getTime() + 1_001);
      const second = await runStore(harness.store.claimControl(
        reclaimedAt,
        new Date(reclaimedAt.getTime() + 60_000),
      ));
      expect(second?.claimToken).not.toBe(first?.claimToken);

      await runStore(harness.store.retryControl(
        first!.id,
        first!.claimToken,
        reclaimedAt,
        "stale",
      ));
      await runStore(harness.store.completeControl(
        first!.id,
        first!.claimToken,
        "remote-stale",
        null,
        reclaimedAt,
      ));
      let control = (await harness.ctx.database.get(
        "x_watcher_control",
        { id: first!.id },
      ))[0]!;
      expect([control.status, control.claimToken]).toEqual([
        "processing",
        second!.claimToken,
      ]);

      await runStore(harness.store.completeControl(
        second!.id,
        second!.claimToken,
        "remote-current",
        null,
        reclaimedAt,
      ));
      control = (await harness.ctx.database.get(
        "x_watcher_control",
        { id: first!.id },
      ))[0]!;
      const account = (await harness.ctx.database.get("x_watcher_account", {}))[0]!;
      expect(control.status).toBe("completed");
      expect(account.remoteId).toBe("remote-current");
    } finally {
      await harness.close();
    }
  });

  it("同 key 切换轮询时会接住进行中 add 的结果并继续排队 remove", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await runStore(
        harness.store.saveSubscription(
          makeSubscriptionInput({
            remoteMonitoring: true,
            remoteKeyFingerprint: "key-old",
          }),
        ),
      );
      const adding = await runStore(
        harness.store.claimControl(
          TestNow,
          new Date(TestNow.getTime() + 60_000),
        ),
      );
      if (adding === null) throw new Error("未领取到 add 控制任务");
      const changedAt = new Date(TestNow.getTime() + 1_000);
      await runStore(
        harness.store.configureRemoteMonitoring(false, "key-old", changedAt),
      );
      await runStore(
        harness.store.completeControl(
          adding.id,
          adding.claimToken,
          "remote-late",
          null,
          new Date(changedAt.getTime() + 1),
        ),
      );

      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const controls = await harness.ctx.database.get(
        "x_watcher_control",
        {},
        { sort: { id: "asc" } },
      );
      expect(accounts[0]?.remoteId).toBe("remote-late");
      expect(accounts[0]?.orphanedRemoteIds).toEqual([]);
      expect(accounts[0]?.remoteStatus).toBe("pending-remove");
      expect(controls.map((row) => [row.operation, row.status])).toEqual([
        ["add", "completed"],
        ["remove", "pending"],
      ]);
    } finally {
      await harness.close();
    }
  });

  it("切换到同 key 的 REST 轮询时排队清理远端监控而不产生 orphan", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await activateRemoteAccount(harness);
      const changedAt = new Date(TestNow.getTime() + 1_000);
      await runStore(
        harness.store.configureRemoteMonitoring(false, "key-old", changedAt),
      );

      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const controls = await harness.ctx.database.get(
        "x_watcher_control",
        {},
        { sort: { id: "asc" } },
      );
      expect(accounts[0]?.remoteId).toBe("remote-old");
      expect(accounts[0]?.orphanedRemoteIds).toEqual([]);
      expect(accounts[0]?.remoteStatus).toBe("pending-remove");
      expect(controls.map((row) => [row.operation, row.status])).toEqual([
        ["add", "completed"],
        ["remove", "pending"],
      ]);

      const removal = await runStore(
        harness.store.claimControl(
          changedAt,
          new Date(changedAt.getTime() + 60_000),
        ),
      );
      expect(removal?.operation).toBe("remove");
      expect(removal?.remoteId).toBe("remote-old");
    } finally {
      await harness.close();
    }
  });

  it("切换 API key 时保留旧 remote ID 供人工清理并为新 key 排队", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await activateRemoteAccount(harness);
      const changedAt = new Date(TestNow.getTime() + 1_000);

      await runStore(
        harness.store.configureRemoteMonitoring(true, "key-new", changedAt),
      );

      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const controls = await harness.ctx.database.get(
        "x_watcher_control",
        {},
        { sort: { id: "asc" } },
      );
      const subscriptions = await runStore(
        harness.store.listSubscriptions(
          makeSubscriptionInput().platform,
          makeSubscriptionInput().channelId,
          false,
        ),
      );
      expect(accounts[0]?.remoteId).toBeNull();
      expect(accounts[0]?.remoteKeyFingerprint).toBe("key-new");
      expect(accounts[0]?.orphanedRemoteIds).toEqual(["remote-old"]);
      expect(controls.map((row) => [row.operation, row.status, row.keyFingerprint])).toEqual([
        ["add", "completed", "key-old"],
        ["remove", "cancelled", "key-old"],
        ["add", "pending", "key-new"],
      ]);
      expect(subscriptions[0]?.account.lastError).toContain("remote-old");
      expect(subscriptions[0]?.remoteStatus).toContain("orphan-manual-cleanup");
    } finally {
      await harness.close();
    }
  });

  it("相同远端配置重复应用不会复制 orphan 或控制任务", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await activateRemoteAccount(harness);
      await runStore(
        harness.store.configureRemoteMonitoring(true, "key-new", TestNow),
      );
      await runStore(
        harness.store.configureRemoteMonitoring(true, "key-new", TestNow),
      );

      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const controls = await harness.ctx.database.get("x_watcher_control", {});
      expect(accounts[0]?.orphanedRemoteIds).toEqual(["remote-old"]);
      expect(controls).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it("归属不确定的 add 进入人工协调且不会被普通 watch 静默重建", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const input = makeSubscriptionInput({
        remoteMonitoring: true,
        remoteKeyFingerprint: "key-old",
      });
      const subscription = await runStore(harness.store.saveSubscription(input));
      const control = await runStore(harness.store.claimControl(
        TestNow,
        new Date(TestNow.getTime() + 60_000),
      ));
      if (control === null) throw new Error("未领取到 add 控制任务");
      await runStore(harness.store.coordinateControlAdd(
        control.id,
        control.claimToken,
        ["uncertain-1"],
        "add 响应丢失",
        TestNow,
      ));

      await runStore(harness.store.saveSubscription({
        ...input,
        now: new Date(TestNow.getTime() + 1_000),
      }));
      let controls = await harness.ctx.database.get("x_watcher_control", {});
      let accounts = await harness.ctx.database.get("x_watcher_account", {});
      expect(controls.map((row) => row.status)).toEqual(["cancelled"]);
      expect(accounts[0]?.remoteStatus).toBe("ownership-uncertain");
      expect(accounts[0]?.lastError).toContain("uncertain-1");

      await runStore(harness.store.disableSubscription(
        subscription.id,
        new Date(TestNow.getTime() + 2_000),
      ));
      await runStore(harness.store.saveSubscription({
        ...input,
        now: new Date(TestNow.getTime() + 3_000),
      }));
      controls = await harness.ctx.database.get(
        "x_watcher_control",
        {},
        { sort: { id: "asc" } },
      );
      accounts = await harness.ctx.database.get("x_watcher_account", {});
      expect(controls.map((row) => [row.operation, row.status])).toEqual([
        ["add", "cancelled"],
        ["add", "pending"],
      ]);
      expect(accounts[0]?.remoteStatus).toBe("pending-add");
    } finally {
      await harness.close();
    }
  });
});
