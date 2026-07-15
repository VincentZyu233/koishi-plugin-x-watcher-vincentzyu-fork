import type { Context } from "koishi";
import { uniqueIndex } from "./indexes";

/** 注册账号、订阅和动态审计三张领域表。 */
export const initializeDomainTables = (ctx: Context): void => {
  ctx.database.extend(
    "x_watcher_account",
    {
      id: "unsigned",
      xUserId: "string",
      handle: "string",
      displayName: "string",
      cursor: { type: "string", nullable: true, initial: null },
      status: "string",
      lastError: { type: "text", nullable: true, initial: null },
      remoteMonitoring: "boolean",
      remoteKeyFingerprint: { type: "string", nullable: true, initial: null },
      orphanedRemoteIds: { type: "json", initial: [] },
      remoteId: { type: "string", nullable: true, initial: null },
      remoteStatus: "string",
      reconcileAt: { type: "timestamp", nullable: true, initial: null },
      createdAt: "timestamp",
      updatedAt: "timestamp",
    },
    {
      primary: "id",
      autoInc: true,
      indexes: [
        uniqueIndex("x_watcher_account_x_user", { xUserId: "asc" }),
        "handle",
        ["remoteStatus", "reconcileAt"],
      ],
    },
  );
  ctx.database.extend(
    "x_watcher_subscription",
    {
      id: "unsigned",
      accountId: "unsigned",
      platform: "string",
      channelId: "string",
      guildId: { type: "string", nullable: true, initial: null },
      isDirect: "boolean",
      creatorId: "string",
      botId: "string",
      kinds: "json",
      filterPattern: { type: "text", nullable: true, initial: null },
      filterStatus: "string",
      includeMedia: "boolean",
      active: "boolean",
      activeSince: { type: "timestamp", initial: new Date(0) },
      cursor: { type: "string", nullable: true, initial: null },
      createdAt: "timestamp",
      updatedAt: "timestamp",
    },
    {
      primary: "id",
      autoInc: true,
      indexes: [
        uniqueIndex("x_watcher_subscription_target", {
          platform: "asc",
          channelId: "asc",
          accountId: "asc",
        }),
        ["platform", "channelId", "active"],
        ["accountId", "active"],
      ],
    },
  );
  ctx.database.extend(
    "x_watcher_activity",
    {
      id: "unsigned",
      accountId: "unsigned",
      activityId: "string",
      payloadJson: "text",
      createdAt: "timestamp",
      recordedAt: "timestamp",
    },
    {
      primary: "id",
      autoInc: true,
      indexes: [
        uniqueIndex("x_watcher_activity_account_activity", {
          accountId: "asc",
          activityId: "asc",
        }),
        ["accountId", "activityId"],
        "recordedAt",
      ],
    },
  );
};

/** 注册旧版单表结构，以便显式迁移能够安全读取历史数据。 */
export const initializeLegacyTable = (ctx: Context): void => {
  ctx.database.extend(
    "x_watcher",
    {
      id: "integer",
      platform: "string",
      channelId: "string",
      userId: "string",
      botId: "string",
      twitter_fullname: "string",
      twitter_username: "string",
      twitter_id: "string",
      last_tweet_id: "string",
      filter_regexp: "string",
      media: "boolean",
      active: "boolean",
      create_at: "timestamp",
      update_at: "timestamp",
    },
    { primary: "id", autoInc: true },
  );
};
