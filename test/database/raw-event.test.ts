import { describe, expect, it } from "@effect/vitest";
import { parseActivityId, parseXUserId } from "../../src/domain/identifiers";
import {
  TestNow,
  expectRight,
  makeActivity,
  makeDatabaseHarness,
  makeSharedDatabaseHarness,
  makeRawEvent,
  makeSubscriptionInput,
  runStore,
} from "../helpers/database";

describe("实时原始事件", () => {
  it("两个实例竞争领取时仅一个获得同一原始事件", async () => {
    const shared = await makeSharedDatabaseHarness();
    try {
      const activity = makeActivity("8001");
      await runStore(shared.primary.store.persistRawEvent(
        makeRawEvent(activity.id, activity.authorId, false),
      ));
      const primary = await runStore(
        shared.primary.store.claimRawEvent(TestNow),
      );
      const secondary = await runStore(
        shared.secondary.store.claimRawEvent(TestNow),
      );
      expect(primary).not.toBeNull();
      expect(secondary).toBeNull();
    } finally {
      await shared.close();
    }
  });

  it("原始事件续租后拒绝旧 worker 的重试与路由完成", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const activity = makeActivity("8002");
      await runStore(harness.store.persistRawEvent(
        makeRawEvent(activity.id, activity.authorId, false),
      ));
      const first = await runStore(harness.store.claimRawEvent(TestNow));
      const reclaimedAt = new Date(TestNow.getTime() + 60_001);
      const second = await runStore(harness.store.claimRawEvent(reclaimedAt));
      expect(second?.claimToken).not.toBe(first?.claimToken);

      await runStore(harness.store.retryRawEvent(
        first!.id,
        first!.claimToken,
        reclaimedAt,
        "stale",
      ));
      await runStore(harness.store.completeRawEvent(
        first!.id,
        first!.claimToken,
        activity,
        reclaimedAt,
      ));
      let row = (await harness.ctx.database.get(
        "x_watcher_raw_event",
        { id: first!.id },
      ))[0]!;
      expect([row.status, row.claimToken]).toEqual([
        "processing",
        second!.claimToken,
      ]);
      expect(await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: subscription.id },
      )).toHaveLength(0);

      await runStore(harness.store.completeRawEvent(
        second!.id,
        second!.claimToken,
        activity,
        reclaimedAt,
      ));
      row = (await harness.ctx.database.get(
        "x_watcher_raw_event",
        { id: first!.id },
      ))[0]!;
      expect(row.status).toBe("completed");
      expect(await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: subscription.id },
      )).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it("同一 Tweet ID 的 fast/full 事件只持久化一次", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const activityId = expectRight(parseActivityId("9001"));
      const accountId = expectRight(parseXUserId("1000"));

      await runStore(
        harness.store.persistRawEvent(makeRawEvent(activityId, accountId, true)),
      );
      await runStore(
        harness.store.persistRawEvent(makeRawEvent(activityId, accountId, false)),
      );

      const rows = await harness.ctx.database.get("x_watcher_raw_event", {});
      expect(rows).toHaveLength(1);
      expect(rows[0]?.eventKey).toBe("activity:9001");
      expect(rows[0]?.reduced).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("实时 Tweet ID 乱序时仍按唯一事件各投递一次且水位不回退", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const newer = makeActivity("202");
      const older = makeActivity("201");
      await runStore(harness.store.persistRawEvent(
        makeRawEvent(newer.id, newer.authorId, false),
      ));
      await runStore(harness.store.persistRawEvent({
        ...makeRawEvent(older.id, older.authorId, false),
        receivedAtEpochMillis: TestNow.getTime() + 1,
      }));
      const rows = await harness.ctx.database.get(
        "x_watcher_raw_event",
        {},
        { sort: { id: "asc" } },
      );
      await runStore(harness.store.completeRawEvent(
        rows[0]!.id,
        (await runStore(harness.store.claimRawEvent(TestNow)))!.claimToken,
        newer,
        new Date(TestNow.getTime() + 2),
      ));
      await runStore(harness.store.completeRawEvent(
        rows[1]!.id,
        (await runStore(
          harness.store.claimRawEvent(new Date(TestNow.getTime() + 2)),
        ))!.claimToken,
        older,
        new Date(TestNow.getTime() + 3),
      ));

      const deliveries = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: subscription.id },
      );
      const stored = await harness.store.listSubscriptions(
        subscription.platform,
        subscription.channelId,
        false,
      ).pipe(runStore);
      expect(deliveries.map((delivery) => delivery.dedupeKey).sort()).toEqual([
        "activity:201",
        "activity:202",
      ]);
      expect(stored[0]?.cursor).toBe("202");
    } finally {
      await harness.close();
    }
  });

  it("重新启用前收到但尚未处理的实时事件不会越过新基线", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const first = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      await runStore(
        harness.store.disableSubscription(
          first.id,
          new Date(TestNow.getTime() + 10),
        ),
      );
      const activity = makeActivity("250");
      await runStore(harness.store.persistRawEvent({
        ...makeRawEvent(activity.id, activity.authorId, false),
        receivedAtEpochMillis: TestNow.getTime() + 20,
      }));
      await runStore(harness.store.saveSubscription(makeSubscriptionInput({
        baselineId: expectRight(parseActivityId("300")),
        now: new Date(TestNow.getTime() + 30),
      })));
      const raw = (await harness.ctx.database.get("x_watcher_raw_event", {}))[0]!;
      const claimed = await runStore(
        harness.store.claimRawEvent(new Date(TestNow.getTime() + 40)),
      );
      await runStore(harness.store.completeRawEvent(
        raw.id,
        claimed!.claimToken,
        activity,
        new Date(TestNow.getTime() + 40),
      ));

      const deliveries = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: first.id },
      );
      expect(deliveries).toEqual([]);
    } finally {
      await harness.close();
    }
  });
});
