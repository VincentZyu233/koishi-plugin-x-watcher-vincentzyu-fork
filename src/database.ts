import type { Context } from "koishi";
import { failure, success, type Result } from "./domain";

/** 持久化的频道订阅。字段名保持与 0.1.x 数据库兼容。 */
export interface WatcherRecord {
  readonly id: number;
  readonly platform: string;
  readonly channelId: string;
  readonly userId: string;
  readonly botId: string;
  readonly twitter_fullname: string;
  readonly twitter_username: string;
  readonly twitter_id: string;
  readonly twitter_avatar_url?: string | null;
  readonly last_tweet_id: string | null;
  readonly filter_regexp: string | null;
  readonly media: boolean;
  readonly include_quote?: boolean;
  readonly include_retweet?: boolean;
  readonly active: boolean;
  readonly enabled_at?: Date | null;
  readonly create_at: Date;
  readonly update_at: Date;
}

declare module "koishi" {
  interface Tables {
    x_watcher: WatcherRecord;
  }
}

/** 在 Koishi 启动数据库同步前声明兼容旧版的表结构。 */
export function extendWatcherTable(ctx: Context): void {
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
      twitter_avatar_url: "string",
      last_tweet_id: "string",
      filter_regexp: "string",
      media: "boolean",
      include_quote: "boolean",
      include_retweet: "boolean",
      active: "boolean",
      enabled_at: "timestamp",
      create_at: "timestamp",
      update_at: "timestamp",
    },
    {
      primary: "id",
      autoInc: true,
    },
  );
}

/** 判断数据库时间值是否可作为订阅启用时间。 */
function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * 在 ready 生命周期幂等回填新增字段。
 *
 * 旧订阅统一采用“原创 + 回复”的新默认，原有水位和过滤设置不改动。
 */
export async function migrateWatcherTable(
  ctx: Context,
): Promise<Result<void, string>> {
  try {
    const watchers = await ctx.database.get("x_watcher", {});
    const migratedAt = new Date();
    for (const watcher of watchers) {
      const enabledAt = isValidDate(watcher.enabled_at)
        ? watcher.enabled_at
        : isValidDate(watcher.update_at)
          ? watcher.update_at
          : isValidDate(watcher.create_at)
            ? watcher.create_at
            : migratedAt;
      await ctx.database.set(
        "x_watcher",
        { id: watcher.id },
        {
          include_quote: watcher.include_quote === true,
          include_retweet: watcher.include_retweet === true,
          enabled_at: enabledAt,
        },
      );
    }
    return success(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }
}

/** 读取全部活跃订阅。 */
export function getActiveWatchers(ctx: Context): Promise<WatcherRecord[]> {
  return ctx.database.get("x_watcher", { active: true });
}

/** 读取当前频道的全部订阅，包括软取消记录。 */
export function getChannelWatchers(
  ctx: Context,
  platform: string,
  channelId: string,
): Promise<WatcherRecord[]> {
  return ctx.database.get("x_watcher", { platform, channelId });
}

/** 水位写入区分数据库故障与订阅被命令并发修改。 */
export interface CursorUpdateError {
  readonly kind: "conflict" | "database";
  readonly message: string;
}

/**
 * 使用读取时的水位和更新时间做乐观并发保护。
 * 命令若已取消、改规则或重新建立更高基线，旧 worker 绝不能覆盖新状态。
 */
export async function updateWatcherCursor(
  ctx: Context,
  watcher: WatcherRecord,
  lastTweetId: string,
): Promise<Result<void, CursorUpdateError>> {
  try {
    const update = { last_tweet_id: lastTweetId, update_at: new Date() };
    const result = watcher.last_tweet_id === null
      ? await ctx.database.set(
          "x_watcher",
          {
            id: watcher.id,
            active: true,
            last_tweet_id: { $exists: false },
            update_at: watcher.update_at,
          },
          update,
        )
      : await ctx.database.set(
          "x_watcher",
          {
            id: watcher.id,
            active: true,
            last_tweet_id: watcher.last_tweet_id,
            update_at: watcher.update_at,
          },
          update,
        );
    if (result.matched === 0) {
      return failure({
        kind: "conflict",
        message: "订阅已被并发更新",
      });
    }
    return success(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure({ kind: "database", message });
  }
}
