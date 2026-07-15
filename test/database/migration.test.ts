import { describe, expect, it } from "@effect/vitest";
import type { Context } from "@koishijs/core";
import {
  TestNow,
  expectRight,
  makeDatabaseHarness,
  runStore,
} from "../helpers/database";
import { parseActivityId } from "../../src/domain/identifiers";

/** 创建完整且可由旧版模型持久化的历史订阅行。 */
const createLegacyRow = async (
  ctx: Context,
  id: number,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<void> => {
  await ctx.database.create("x_watcher", {
    id,
    platform: "test",
    channelId: `legacy-channel-${id}`,
    userId: `creator-${id}`,
    botId: "bot",
    twitter_fullname: `Legacy User ${id}`,
    twitter_username: `legacy${id}`,
    twitter_id: `${7000 + id}`,
    last_tweet_id: `${8000 + id}`,
    filter_regexp: "legacy",
    media: true,
    active: true,
    create_at: new Date(TestNow.getTime() - 1_000),
    update_at: TestNow,
    ...overrides,
  });
};

describe("旧表迁移", () => {
  it("重复执行保持新表唯一且不改写旧行", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await createLegacyRow(harness.ctx, 1);
      const before = await harness.ctx.database.get("x_watcher", {});

      await runStore(harness.store.migrate());
      await runStore(harness.store.migrate());

      const after = await harness.ctx.database.get("x_watcher", {});
      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const subscriptions = await harness.ctx.database.get(
        "x_watcher_subscription",
        {},
      );
      expect(after).toEqual(before);
      expect(accounts).toHaveLength(1);
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]?.filterPattern).toBe("legacy");
      expect(subscriptions[0]?.includeMedia).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("空 cursor 迁移后初始化到最新水位且不产生历史投递", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await createLegacyRow(harness.ctx, 2, { last_tweet_id: "" });
      await runStore(harness.store.migrate());

      const initializing = await harness.ctx.database.get(
        "x_watcher_account",
        {},
      );
      expect(initializing[0]?.status).toBe("initializing");
      expect(initializing[0]?.cursor).toBeNull();

      const latestId = expectRight(parseActivityId("9999"));
      await runStore(
        harness.store.initializeAccount(initializing[0]!.id, latestId, false, TestNow),
      );

      const accounts = await harness.ctx.database.get("x_watcher_account", {});
      const subscriptions = await harness.ctx.database.get(
        "x_watcher_subscription",
        {},
      );
      const deliveries = await harness.ctx.database.get("x_watcher_delivery", {});
      const activities = await harness.ctx.database.get("x_watcher_activity", {});
      expect(accounts[0]?.status).toBe("ready");
      expect(accounts[0]?.cursor).toBe("9999");
      expect(subscriptions[0]?.cursor).toBe("9999");
      expect(deliveries).toHaveLength(0);
      expect(activities).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("同账号已知与空 cursor 混合迁移时保留已知订阅水位", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await createLegacyRow(harness.ctx, 20, {
        twitter_id: "9020",
        twitter_username: "shared",
        last_tweet_id: "8120",
      });
      await createLegacyRow(harness.ctx, 21, {
        twitter_id: "9020",
        twitter_username: "shared",
        last_tweet_id: "",
      });
      await runStore(harness.store.migrate());
      const account = (await harness.ctx.database.get(
        "x_watcher_account",
        {},
      ))[0]!;
      await runStore(harness.store.initializeAccount(
        account.id,
        expectRight(parseActivityId("9999")),
        false,
        new Date(TestNow.getTime() + 1_000),
      ));

      const subscriptions = await harness.ctx.database.get(
        "x_watcher_subscription",
        {},
        { sort: { id: "asc" } },
      );
      expect(subscriptions.map((row) => row.cursor)).toEqual(["8120", "9999"]);
    } finally {
      await harness.close();
    }
  });

  it("任一旧行无效时整批回滚且旧表原样保留", async () => {
    const harness = await makeDatabaseHarness();
    try {
      await createLegacyRow(harness.ctx, 3);
      await createLegacyRow(harness.ctx, 4, { twitter_id: "invalid-id" });
      const before = await harness.ctx.database.get("x_watcher", {});

      await expect(runStore(harness.store.migrate())).rejects.toThrow(
        /旧订阅 4 无法迁移/,
      );

      expect(await harness.ctx.database.get("x_watcher", {})).toEqual(before);
      expect(await harness.ctx.database.get("x_watcher_account", {})).toHaveLength(0);
      expect(
        await harness.ctx.database.get("x_watcher_subscription", {}),
      ).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
