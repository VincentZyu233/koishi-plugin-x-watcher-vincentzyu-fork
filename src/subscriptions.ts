import type { Context } from "koishi";
import type { XUser } from "./domain";
import type { WatcherRecord } from "./database";

/** watch 命令的完整覆盖选项。 */
export interface WatchOptions {
  readonly media: boolean;
  readonly quote: boolean;
  readonly retweet: boolean;
}

/** 命令执行所需的频道定位信息。 */
export interface SessionAddress {
  readonly platform: string;
  readonly channelId: string;
  readonly userId: string;
  readonly botId: string;
}


/** 从数据库订阅还原稳定用户资料。 */
export function userFromWatcher(watcher: WatcherRecord): XUser {
  const avatarUrl = watcher.twitter_avatar_url;
  if (avatarUrl === undefined || avatarUrl === null) {
    return {
      id: watcher.twitter_id,
      username: watcher.twitter_username,
      fullname: watcher.twitter_fullname,
    };
  }
  return {
    id: watcher.twitter_id,
    username: watcher.twitter_username,
    fullname: watcher.twitter_fullname,
    avatarUrl,
  };
}


/** 将 Account Stream 同步结果附加到用户可见回复。 */
export async function remoteSyncSuffix(
  synchronizeMonitors: (() => Promise<boolean>) | null,
): Promise<string> {
  if (synchronizeMonitors === null) return "";
  try {
    const synchronized = await synchronizeMonitors();
    return synchronized ? "" : "\n已保存，远端 Stream 同步待重试";
  } catch {
    return "\n已保存，远端 Stream 同步待重试";
  }
}


/** 更新当前频道中同一个稳定 X 用户的订阅设置。 */
export async function updateExistingWatcher(
  ctx: Context,
  address: SessionAddress,
  watcher: WatcherRecord,
  user: XUser,
  filter: string | null,
  options: WatchOptions,
  reactivate: boolean,
  baseline: string | null,
): Promise<void> {
  const now = new Date();
  const avatarUrl = user.avatarUrl;
  await ctx.database.set(
    "x_watcher",
    {
      platform: watcher.platform,
      channelId: watcher.channelId,
      twitter_id: watcher.twitter_id,
    },
    {
      userId: address.userId,
      botId: address.botId,
      twitter_username: user.username,
      twitter_fullname: user.fullname,
      ...(reactivate ? { last_tweet_id: baseline } : {}),
      filter_regexp: filter,
      media: options.media,
      include_quote: options.quote,
      include_retweet: options.retweet,
      active: true,
      enabled_at: reactivate ? now : watcher.enabled_at,
      update_at: now,
      ...(avatarUrl === undefined || avatarUrl.length === 0
        ? {}
        : { twitter_avatar_url: avatarUrl }),
    },
  );
}

/** 创建一个从当前最新水位开始的新频道订阅。 */
export async function createWatcher(
  ctx: Context,
  address: SessionAddress,
  user: XUser,
  baseline: string | null,
  filter: string | null,
  options: WatchOptions,
): Promise<void> {
  const now = new Date();
  await ctx.database.create("x_watcher", {
    platform: address.platform,
    channelId: address.channelId,
    userId: address.userId,
    botId: address.botId,
    twitter_fullname: user.fullname,
    twitter_username: user.username,
    twitter_id: user.id,
    twitter_avatar_url: user.avatarUrl ?? null,
    last_tweet_id: baseline,
    filter_regexp: filter,
    media: options.media,
    include_quote: options.quote,
    include_retweet: options.retweet,
    active: true,
    enabled_at: now,
    create_at: now,
    update_at: now,
  });
}


const locks = new WeakMap<Context, Promise<void>>();
/** 单实例内串行管理写入；不锁住等待用户确认的过程。 */
export async function withManagementLock<T>(ctx: Context, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(ctx) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(ctx, current);
  await previous;
  try { return await action(); }
  finally { release(); if (locks.get(ctx) === current) locks.delete(ctx); }
}

export function deactivateWatcher(ctx: Context, watcher: WatcherRecord) {
  return ctx.database.set("x_watcher", { id: watcher.id }, { active: false, update_at: new Date() });
}

export function deleteWatcher(ctx: Context, watcher: WatcherRecord, strict = false) {
  return ctx.database.remove("x_watcher", {
    id: watcher.id, platform: watcher.platform, channelId: watcher.channelId,
    ...(strict ? { active: watcher.active, update_at: watcher.update_at } : {}),
  });
}

/** 管理字段快照有意排除 worker 水位和更新时间。 */
export function managementRevision(row: WatcherRecord): string {
  return JSON.stringify([row.id, row.platform, row.channelId, row.twitter_id,
    row.twitter_username, row.botId, row.active, row.filter_regexp,
    row.media, row.include_quote === true, row.include_retweet === true,
    row.create_at, row.enabled_at]);
}
