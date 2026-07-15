import { describe, expect, it } from "@effect/vitest";
import { parseChannelId } from "../../src/domain/identifiers";
import {
  TestNow,
  expectRight,
  makeActivity,
  makeDatabaseHarness,
  makeSubscriptionInput,
  runStore,
} from "../helpers/database";

/** 构造连续 Snowflake 测试动态。 */
const makeActivities = (count: number) =>
  Array.from({ length: count }, (_, index) => makeActivity(String(101 + index)));

/** 构造第 21 条唯一动态所需的最小恢复边界。 */
const makeOverflowBoundary = (id: string) => {
  const activity = makeActivity(id);
  return {
    id: activity.id,
    createdAtEpochMillis: activity.createdAtEpochMillis,
  };
};

describe("恢复批次提交", () => {
  it("20 条以内逐条创建消息并推进账号与订阅水位", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const activities = makeActivities(20);

      await runStore(
        harness.store.commitRecovery({
          account: subscription.account,
          activities,
          newestId: activities.at(-1)!.id,
          overflow: false,
          overflowBoundary: null,
          consumeRecoveryDue: false,
          now: TestNow,
        }),
      );

      const deliveries = await harness.ctx.database.get(
        "x_watcher_delivery",
        {},
        { sort: { id: "asc" } },
      );
      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const subscriptions = await harness.ctx.database.get(
        "x_watcher_subscription",
        {},
      );
      expect(deliveries).toHaveLength(20);
      expect(deliveries.every((row) => row.plan.kind === "post")).toBe(true);
      expect(accounts[0]?.cursor).toBe("120");
      expect(subscriptions[0]?.cursor).toBe("120");
    } finally {
      await harness.close();
    }
  });

  it("检测到第 21 条时仅创建一条摘要并推进到最新水位", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const activities = makeActivities(21).slice(1);

      await runStore(
        harness.store.commitRecovery({
          account: subscription.account,
          activities,
          newestId: activities.at(-1)!.id,
          overflow: true,
          overflowBoundary: makeOverflowBoundary("101"),
          consumeRecoveryDue: false,
          now: TestNow,
        }),
      );

      const deliveries = await harness.ctx.database.get("x_watcher_delivery", {});
      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const subscriptions = await harness.ctx.database.get(
        "x_watcher_subscription",
        {},
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.plan.kind).toBe("recovery-summary");
      expect(deliveries[0]?.dedupeKey).toBe("recovery:121");
      expect(accounts[0]?.cursor).toBe("121");
      expect(subscriptions[0]?.cursor).toBe("121");
    } finally {
      await harness.close();
    }
  });

  it("共享账号基线请求失败时不会向新频道补订阅前历史", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const existing = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const subscribedAt = new Date(TestNow.getTime() + 1_000);
      const recent = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput({
          channelId: expectRight(parseChannelId("channel-b")),
          baselineId: null,
          baselineKnown: false,
          now: subscribedAt,
        })),
      );
      const beforeWatch = makeActivity("101");
      const afterWatch = makeActivity("102", {
        createdAtEpochMillis: subscribedAt.getTime() + 1,
      });
      await runStore(harness.store.commitRecovery({
        account: existing.account,
        activities: [beforeWatch, afterWatch],
        newestId: afterWatch.id,
        overflow: false,
        overflowBoundary: null,
        consumeRecoveryDue: false,
        now: new Date(subscribedAt.getTime() + 2),
      }));

      const oldChannel = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: existing.id },
      );
      const newChannel = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: recent.id },
      );
      expect(oldChannel).toHaveLength(2);
      expect(newChannel.map((row) => row.dedupeKey)).toEqual(["activity:102"]);
    } finally {
      await harness.close();
    }
  });

  it("共享账号恢复溢出时不会向新频道发送订阅前历史摘要", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const existing = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const subscribedAt = new Date(TestNow.getTime() + 1_000);
      const recent = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput({
          channelId: expectRight(parseChannelId("channel-b")),
          baselineId: null,
          baselineKnown: false,
          now: subscribedAt,
        })),
      );
      const activities = makeActivities(21).slice(1);
      await runStore(harness.store.commitRecovery({
        account: existing.account,
        activities,
        newestId: activities.at(-1)!.id,
        overflow: true,
        overflowBoundary: makeOverflowBoundary("101"),
        consumeRecoveryDue: false,
        now: new Date(subscribedAt.getTime() + 1),
      }));

      const oldChannel = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: existing.id },
      );
      const newChannel = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: recent.id },
      );
      const subscriptions = await harness.ctx.database.get(
        "x_watcher_subscription",
        {},
      );
      expect(oldChannel.map((row) => row.plan.kind)).toEqual([
        "recovery-summary",
      ]);
      expect(newChannel).toHaveLength(0);
      expect(subscriptions.every((row) => row.cursor === "121")).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("共享账号溢出批次只向新频道逐条发送订阅后的详情", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const existing = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const subscribedAt = new Date(TestNow.getTime() + 110);
      const recent = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput({
          channelId: expectRight(parseChannelId("channel-b")),
          baselineId: null,
          baselineKnown: false,
          now: subscribedAt,
        })),
      );
      const activities = makeActivities(21).slice(1);
      await runStore(harness.store.commitRecovery({
        account: existing.account,
        activities,
        newestId: activities.at(-1)!.id,
        overflow: true,
        overflowBoundary: makeOverflowBoundary("101"),
        consumeRecoveryDue: false,
        now: new Date(subscribedAt.getTime() + 20),
      }));

      const oldChannel = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: existing.id },
      );
      const newChannel = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: recent.id },
        { sort: { id: "asc" } },
      );
      expect(oldChannel.map((row) => row.plan.kind)).toEqual([
        "recovery-summary",
      ]);
      expect(newChannel.map((row) => row.dedupeKey)).toEqual(
        Array.from({ length: 12 }, (_, index) => `activity:${110 + index}`),
      );
    } finally {
      await harness.close();
    }
  });

  it("普通启动恢复保留未到期的 Account Stream 激活补拉", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput({
          baselineId: null,
          baselineKnown: false,
        })),
      );
      const dueAt = new Date(TestNow.getTime() + 20 * 60_000);
      await harness.ctx.database.set(
        "x_watcher_account",
        { id: subscription.account.id },
        { reconcileAt: dueAt },
      );

      await runStore(harness.store.initializeAccount(
        subscription.account.id,
        makeActivity("150").id,
        false,
        TestNow,
      ));

      const account = (await harness.ctx.database.get("x_watcher_account", {}))[0];
      expect(account?.reconcileAt).toEqual(dueAt);
    } finally {
      await harness.close();
    }
  });

  it("只有到期补拉成功提交后才消费持久化计划", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const dueAt = new Date(TestNow.getTime() + 20 * 60_000);
      await harness.ctx.database.set(
        "x_watcher_account",
        { id: subscription.account.id },
        { reconcileAt: dueAt },
      );
      const [account] = await runStore(harness.store.listActiveAccounts());
      if (account === undefined) throw new Error("缺少测试账号");
      const base = {
        account,
        activities: [],
        newestId: null,
        overflow: false,
        overflowBoundary: null,
        now: TestNow,
      } as const;

      await runStore(harness.store.commitRecovery({
        ...base,
        consumeRecoveryDue: false,
      }));
      const preserved = (await harness.ctx.database.get("x_watcher_account", {}))[0];
      expect(preserved?.reconcileAt).toEqual(dueAt);

      await runStore(harness.store.commitRecovery({
        ...base,
        consumeRecoveryDue: true,
      }));
      const consumed = (await harness.ctx.database.get("x_watcher_account", {}))[0];
      expect(consumed?.reconcileAt).toBeNull();
    } finally {
      await harness.close();
    }
  });
});
