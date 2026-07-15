import * as Either from "effect/Either";
import type { Context } from "koishi";
import { ActivityKinds } from "../../domain/activity";
import { runDatabase, type XWatcherDatabase } from "./database-effect";
import { oldestCursor } from "./cursor";
import { legacyFilter, parseLegacyRow } from "./legacy-values";
import type { LegacyWatcherRow } from "./rows-domain";
import { initializeDatabase } from "./schema";

/** 幂等迁移一条旧订阅，已有新表订阅永不被旧值覆盖。 */
const migrateLegacyRow = async (
  database: XWatcherDatabase,
  row: LegacyWatcherRow,
): Promise<void> => {
  const parsed = parseLegacyRow(row);
  if (Either.isLeft(parsed)) {
    return Promise.reject(
      new Error(`旧订阅 ${row.id} 无法迁移：${parsed.left}`),
    );
  }
  const value = parsed.right;
  const accounts = await database.get(
    "x_watcher_account",
    { xUserId: value.xUserId },
    { limit: 1 },
  );
  const account = accounts[0] === undefined
    ? await database.create("x_watcher_account", {
        xUserId: value.xUserId,
        handle: value.handle,
        displayName: row.twitter_fullname,
        cursor: value.cursor,
        status: value.cursor === null ? "initializing" : "ready",
        lastError: null,
        remoteMonitoring: false,
        remoteKeyFingerprint: null,
        orphanedRemoteIds: [],
        remoteId: null,
        remoteStatus: "inactive",
        reconcileAt: null,
        createdAt: row.create_at,
        updatedAt: row.update_at,
      })
    : accounts[0];
  const subscriptions = await database.get(
    "x_watcher_subscription",
    {
      platform: value.platform,
      channelId: value.channelId,
      accountId: account.id,
    },
    { limit: 1 },
  );
  if (subscriptions.length > 0) return;
  if (row.active) {
    const cursor = oldestCursor(account.cursor, value.cursor);
    await database.set(
      "x_watcher_account",
      { id: account.id },
      {
        cursor,
        status: cursor === null ? "initializing" : account.status,
        updatedAt: row.update_at,
      },
    );
  }
  const filter = legacyFilter(row.filter_regexp);
  await database.create("x_watcher_subscription", {
    accountId: account.id,
    platform: value.platform,
    channelId: value.channelId,
    guildId: null,
    isDirect: false,
    creatorId: value.creatorId,
    botId: value.botId,
    kinds: ActivityKinds,
    filterPattern: filter.pattern,
    filterStatus: filter.status,
    includeMedia: row.media ?? false,
    active: row.active,
    activeSince: row.create_at,
    cursor: value.cursor,
    createdAt: row.create_at,
    updatedAt: row.update_at,
  });
};

/** 创建全部表并在单事务内显式、幂等迁移旧 x_watcher 数据。 */
export const migrateDatabase = (ctx: Context) =>
  runDatabase("migrate", async () => {
    initializeDatabase(ctx);
    await ctx.database.prepared();
    const legacyRows = await ctx.database.get("x_watcher", {});
    legacyRows.sort((left, right) => left.id - right.id);
    await ctx.database.withTransaction(async (database) => {
      for (const row of legacyRows) await migrateLegacyRow(database, row);
    });
  });
