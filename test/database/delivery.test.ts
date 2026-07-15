import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import { parseChannelId } from "../../src/domain/identifiers";
import {
  TestNow,
  expectRight,
  makeActivity,
  makeDatabaseHarness,
  makeSharedDatabaseHarness,
  makeSubscriptionInput,
  runStore,
} from "../helpers/database";

/** 为订阅提交指定恢复动态以生成可靠投递任务。 */
const enqueueActivities = async (
  harness: Awaited<ReturnType<typeof makeDatabaseHarness>>,
  count: number,
) => {
  const subscription = await runStore(
    harness.store.saveSubscription(makeSubscriptionInput()),
  );
  const activities = Array.from(
    { length: count },
    (_, index) => makeActivity(String(101 + index)),
  );
  await runStore(
    harness.store.commitRecovery({
      account: subscription.account,
      activities,
      newestId: activities.at(-1)?.id ?? null,
      overflow: false,
      overflowBoundary: null,
      consumeRecoveryDue: false,
      now: TestNow,
    }),
  );
  return subscription;
};

describe("投递队列", () => {
  it("两个实例竞争领取时仅一个获得同一投递", async () => {
    const shared = await makeSharedDatabaseHarness();
    try {
      await enqueueActivities(shared.primary, 1);
      const lease = new Date(TestNow.getTime() + 60_000);
      const primary = await runStore(
        shared.primary.store.claimDelivery(TestNow, lease),
      );
      const secondary = await runStore(
        shared.secondary.store.claimDelivery(TestNow, lease),
      );
      expect(primary).not.toBeNull();
      expect(secondary).toBeNull();
    } finally {
      await shared.close();
    }
  });

  it("租约过期后旧 worker 不能覆盖新 worker 的投递状态", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await enqueueActivities(harness, 1);
      const first = await runStore(harness.store.claimDelivery(
        TestNow,
        new Date(TestNow.getTime() + 1_000),
      ));
      const reclaimedAt = new Date(TestNow.getTime() + 1_001);
      const second = await runStore(harness.store.claimDelivery(
        reclaimedAt,
        new Date(reclaimedAt.getTime() + 60_000),
      ));
      expect(second?.claimToken).not.toBe(first?.claimToken);

      await runStore(harness.store.completeDelivery(
        first!.id,
        first!.claimToken,
        reclaimedAt,
      ));
      await runStore(harness.store.updateDeliveryProgress(
        first!.id,
        first!.claimToken,
        "split",
        1,
        reclaimedAt,
        "stale",
      ));
      let row = (await harness.ctx.database.get(
        "x_watcher_delivery",
        { id: first!.id },
      ))[0]!;
      expect([row.status, row.stage, row.claimToken]).toEqual([
        "processing",
        "mixed",
        second!.claimToken,
      ]);

      await runStore(harness.store.completeDelivery(
        second!.id,
        second!.claimToken,
        reclaimedAt,
      ));
      row = (await harness.ctx.database.get(
        "x_watcher_delivery",
        { id: first!.id },
      ))[0]!;
      expect(row.status).toBe("sent");
    } finally {
      await harness.close();
    }
  });

  it("同订阅头任务延后时阻塞后续任务但不阻塞其他订阅", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const first = await runStore(
        harness.store.saveSubscription(makeSubscriptionInput()),
      );
      const second = await runStore(
        harness.store.saveSubscription(
          makeSubscriptionInput({
            channelId: expectRight(parseChannelId("channel-b")),
          }),
        ),
      );
      const activities = [makeActivity("101"), makeActivity("102")];
      await runStore(
        harness.store.commitRecovery({
          account: first.account,
          activities,
          newestId: activities[1]!.id,
          overflow: false,
          overflowBoundary: null,
          consumeRecoveryDue: false,
          now: TestNow,
        }),
      );

      const lease = new Date(TestNow.getTime() + 60_000);
      const claimedFirst = await runStore(
        harness.store.claimDelivery(TestNow, lease),
      );
      expect(claimedFirst?.subscriptionId).toBe(first.id);
      await runStore(
        harness.store.updateDeliveryProgress(
          claimedFirst!.id,
          claimedFirst!.claimToken,
          "mixed",
          0,
          new Date(TestNow.getTime() + 3_600_000),
          "retry later",
        ),
      );

      const claimedSecond = await runStore(
        harness.store.claimDelivery(TestNow, lease),
      );
      expect(claimedSecond?.subscriptionId).toBe(second.id);
      const rows = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: first.id },
        { sort: { id: "asc" } },
      );
      expect(rows[0]?.status).toBe("pending");
      expect(rows[1]?.status).toBe("pending");
    } finally {
      await harness.close();
    }
  });

  it("unwatch 作废 pending 与 processing，旧 worker 不能完成任务", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await enqueueActivities(harness, 2);
      const claimed = await runStore(
        harness.store.claimDelivery(
          TestNow,
          new Date(TestNow.getTime() + 60_000),
        ),
      );
      expect(claimed).not.toBeNull();

      await runStore(harness.store.disableSubscription(subscription.id, TestNow));
      let rows = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: subscription.id },
        { sort: { id: "asc" } },
      );
      expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);

      await runStore(
        harness.store.completeDelivery(
          claimed!.id,
          claimed!.claimToken,
          TestNow,
        ),
      );
      rows = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: subscription.id },
        { sort: { id: "asc" } },
      );
      expect(rows.map((row) => row.status)).toEqual(["cancelled", "cancelled"]);
    } finally {
      await harness.close();
    }
  });

  it("unwatch 后重新 watch 不会让旧 processing 分片复活", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await enqueueActivities(harness, 1);
      const claimed = await runStore(harness.store.claimDelivery(
        TestNow,
        new Date(TestNow.getTime() + 60_000),
      ));
      await runStore(harness.store.disableSubscription(
        subscription.id,
        new Date(TestNow.getTime() + 1_000),
      ));
      await runStore(harness.store.saveSubscription(makeSubscriptionInput({
        now: new Date(TestNow.getTime() + 2_000),
      })));

      await runStore(harness.store.updateDeliveryProgress(
        claimed!.id,
        claimed!.claimToken,
        "split",
        1,
        new Date(TestNow.getTime() + 3_000),
        null,
      ));
      const rows = await harness.ctx.database.get(
        "x_watcher_delivery",
        { subscriptionId: subscription.id },
      );
      expect(rows).toHaveLength(1);
      expect([rows[0]?.status, rows[0]?.stage, rows[0]?.partIndex]).toEqual([
        "cancelled",
        "mixed",
        0,
      ]);
    } finally {
      await harness.close();
    }
  });

  it("入队消息计划不随后续订阅更新改变", async () => {
    const harness = await makeDatabaseHarness();
    try {
      const subscription = await runStore(
        harness.store.saveSubscription(
          makeSubscriptionInput({ includeMedia: false }),
        ),
      );
      const activity = makeActivity("101", {
        body: {
          text: "original text",
          expandedUrls: [],
          media: [
            {
              kind: "image",
              url: "https://example.test/image.jpg",
              previewUrl: Option.none(),
              order: 0,
            },
          ],
        },
      });
      await runStore(
        harness.store.commitRecovery({
          account: subscription.account,
          activities: [activity],
          newestId: activity.id,
          overflow: false,
          overflowBoundary: null,
          consumeRecoveryDue: false,
          now: TestNow,
        }),
      );
      const before = await harness.ctx.database.get("x_watcher_delivery", {});

      await runStore(
        harness.store.saveSubscription(
          makeSubscriptionInput({
            includeMedia: true,
            filter: { _tag: "Set", pattern: "updated" },
            now: new Date(TestNow.getTime() + 1_000),
          }),
        ),
      );
      const after = await harness.ctx.database.get("x_watcher_delivery", {});

      expect(after[0]?.plan).toEqual(before[0]?.plan);
      expect(after[0]?.plan.includeMedia).toBe(false);
      expect(after[0]?.plan.text).toBe("original text");
    } finally {
      await harness.close();
    }
  });
});
