import type { Context, Logger } from "koishi";
import type { PushActivityType } from "./config";
import {
  canonicalHandle,
  compareSnowflake,
  compileFilter,
  maxSnowflake,
  normalizeActivityOrder,
  snowflakeDate,
  type ActivityCursor,
  type XActivity,
  type XUser,
} from "./domain";
import {
  getActiveWatchers,
  updateWatcherCursor,
  type WatcherRecord,
} from "./database";
import { legacyMessageOutput, type MessageOutput } from "./output";
import type { XDataSourceService } from "./services";

type ContinueDelivery = () => boolean;

export interface DeliveryOptions {
  readonly output: MessageOutput;
  readonly activityTypes: ReadonlyArray<PushActivityType>;
  readonly maxPostCount: number;
  readonly maxReplyCount: number;
}

const defaultDeliveryOptions: DeliveryOptions = {
  output: legacyMessageOutput,
  activityTypes: ["post", "reply"],
  maxPostCount: 0,
  maxReplyCount: 0,
};

/** 从新到旧领取每类额度；返回集合外的旧动态仍会被消费并推进水位。 */
function deliverableActivityIds(
  activities: ReadonlyArray<XActivity>,
  delivery: DeliveryOptions,
): ReadonlySet<string> {
  const deliverable = new Set<string>();
  let posts = 0;
  let replies = 0;
  const newestFirst = [...normalizeActivityOrder(activities)].reverse();
  for (const activity of newestFirst) {
    if (activity.kind === "post") {
      if (delivery.maxPostCount > 0 && posts >= delivery.maxPostCount) continue;
      posts += 1;
    } else if (activity.kind === "reply") {
      if (delivery.maxReplyCount > 0 && replies >= delivery.maxReplyCount) continue;
      replies += 1;
    }
    deliverable.add(activity.id);
  }
  return deliverable;
}

/** 普通轮询不受连接代次约束。 */
function alwaysContinue(): boolean {
  return true;
}

/** 单订阅最近投递 ID 的有界去重器。 */
export interface DeliveryTracker {
  readonly has: (watcherId: number, activityId: string) => boolean;
  readonly add: (watcherId: number, activityId: string) => void;
}

/** 创建不会随进程运行时间无限增长的投递去重器。 */
export function createDeliveryTracker(limit = 4096): DeliveryTracker {
  const recent = new Map<string, true>();
  return {
    has: (watcherId, activityId) => recent.has(`${watcherId}:${activityId}`),
    add: (watcherId, activityId) => {
      const key = `${watcherId}:${activityId}`;
      recent.delete(key);
      recent.set(key, true);
      while (recent.size > limit) {
        const oldest = recent.keys().next();
        if (oldest.done) break;
        recent.delete(oldest.value);
      }
    },
  };
}

/** 判断订阅是否启用了某一种动态。 */
function isActivityEnabled(
  watcher: WatcherRecord,
  activity: XActivity,
  activityTypes: ReadonlyArray<PushActivityType>,
): boolean {
  if (activity.kind === "quote") return watcher.include_quote === true;
  if (activity.kind === "retweet") return watcher.include_retweet === true;
  return activityTypes.includes(activity.kind);
}

/** 获取迁移后可靠的订阅启用时间。 */
function watcherEnabledAt(watcher: WatcherRecord): Date {
  if (
    watcher.enabled_at !== undefined &&
    watcher.enabled_at instanceof Date &&
    !Number.isNaN(watcher.enabled_at.getTime())
  ) {
    return watcher.enabled_at;
  }
  return watcher.update_at;
}

/** 检查恢复动态是否位于当前订阅水位之后。 */
function isAfterWatcherCursor(
  watcher: WatcherRecord,
  activity: XActivity,
): boolean {
  if (watcher.last_tweet_id !== null && watcher.last_tweet_id.length > 0) {
    return compareSnowflake(activity.id, watcher.last_tweet_id) > 0;
  }
  return activity.createdAt.getTime() >= watcherEnabledAt(watcher).getTime();
}

/** 查找最初创建订阅时保存的机器人实例。 */
function findWatcherBot(ctx: Context, watcher: WatcherRecord) {
  return ctx.bots.find(
    (bot) =>
      bot.platform === watcher.platform && bot.selfId === watcher.botId,
  );
}

/**
 * 逐条处理一个订阅的动态。
 *
 * 过滤或类型关闭属于已消费；发送或水位写入失败会立即停止，避免越过失败项。
 */
async function processWatcherActivities(
  ctx: Context,
  logger: Logger,
  tracker: DeliveryTracker,
  watcher: WatcherRecord,
  activities: ReadonlyArray<XActivity>,
  canContinue: ContinueDelivery,
  delivery: DeliveryOptions,
): Promise<boolean> {
  const deliverableIds = deliverableActivityIds(activities, delivery);
  for (const activity of normalizeActivityOrder(activities)) {
    if (!canContinue()) return false;

    // 每条动态前重新读取订阅，完整覆盖规则与重新启用基线都立即生效。
    const refreshed = await ctx.database.get("x_watcher", {
      id: watcher.id,
      active: true,
    });
    const current = refreshed[0];
    if (current === undefined) return true;
    if (!isAfterWatcherCursor(current, activity)) continue;
    if (tracker.has(watcher.id, activity.id)) continue;

    const compiled = compileFilter(current.filter_regexp);
    if (!compiled.ok) {
      logger.error(
        `订阅 ${current.id} 的正则表达式无效，已按 fail-closed 跳过动态`,
      );
    }
    const shouldSend =
      compiled.ok &&
      deliverableIds.has(activity.id) &&
      isActivityEnabled(current, activity, delivery.activityTypes) &&
      (compiled.value === null || compiled.value.test(activity.text));

    if (shouldSend) {
      if (!canContinue()) return false;
      const bot = findWatcherBot(ctx, current);
      if (bot === undefined) {
        logger.error(
          `找不到推送机器人 ${current.platform}:${current.botId}，订阅 ${current.id} 暂停推进`,
        );
        return false;
      }
      try {
        const message = await delivery.output.activity(activity, current.media);
        await bot.sendMessage(current.channelId, message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`推送动态 ${activity.id} 失败：${message}`);
        return false;
      }
    }

    const nextCursor = maxSnowflake(current.last_tweet_id, activity.id);
    const updated = await updateWatcherCursor(ctx, current, nextCursor);
    if (!updated.ok) {
      if (updated.error.kind === "conflict") {
        logger.warn(`订阅 ${current.id} 已并发更新，停止使用旧快照推进水位`);
        return true;
      }
      logger.error(`更新订阅 ${current.id} 水位失败：${updated.error.message}`);
      return false;
    }
    tracker.add(watcher.id, activity.id);
  }
  return true;
}

/** 按稳定 X 用户 ID 合并多个频道订阅。 */
function groupWatchers(
  watchers: ReadonlyArray<WatcherRecord>,
): Map<string, WatcherRecord[]> {
  const groups = new Map<string, WatcherRecord[]>();
  for (const watcher of watchers) {
    const current = groups.get(watcher.twitter_id);
    if (current === undefined) groups.set(watcher.twitter_id, [watcher]);
    else current.push(watcher);
  }
  return groups;
}

/** 为共享抓取选择最早的订阅水位和启用时间。 */
function oldestCursor(watchers: ReadonlyArray<WatcherRecord>): ActivityCursor {
  let lastId: string | null = null;
  let hasEmptyCursor = false;
  let enabledAt: Date | null = null;
  for (const watcher of watchers) {
    const currentEnabledAt = watcherEnabledAt(watcher);
    if (
      watcher.last_tweet_id === null ||
      watcher.last_tweet_id.length === 0
    ) {
      hasEmptyCursor = true;
      if (enabledAt === null || currentEnabledAt < enabledAt) {
        enabledAt = currentEnabledAt;
      }
      continue;
    }
    // 只要组内存在空 ID，就必须退化为时间边界；有 ID 订阅也纳入其 Snowflake 时间。
    const cursorDate = snowflakeDate(watcher.last_tweet_id);
    const boundaryDate = cursorDate === null ? currentEnabledAt : cursorDate;
    if (enabledAt === null || boundaryDate < enabledAt) {
      enabledAt = boundaryDate;
    }
    if (
      lastId === null ||
      compareSnowflake(watcher.last_tweet_id, lastId) < 0
    ) {
      lastId = watcher.last_tweet_id;
    }
  }
  return {
    lastId: hasEmptyCursor ? null : lastId,
    enabledAt: enabledAt === null ? new Date() : enabledAt,
  };
}

/** 从订阅记录还原数据源查询所需的用户资料。 */
function watcherUser(watcher: WatcherRecord): XUser {
  return {
    id: watcher.twitter_id,
    username: watcher.twitter_username,
    fullname: watcher.twitter_fullname,
  };
}

/** 对给定订阅集合执行一次按用户合并的水位恢复。 */
async function recoverWatchers(
  ctx: Context,
  source: XDataSourceService,
  logger: Logger,
  tracker: DeliveryTracker,
  watchers: ReadonlyArray<WatcherRecord>,
  canContinue: ContinueDelivery,
  delivery: DeliveryOptions,
): Promise<boolean> {
  const groups = groupWatchers(watchers);
  let completed = true;
  for (const grouped of groups.values()) {
    if (!canContinue()) return false;
    const snapshot = grouped[0];
    if (snapshot === undefined) continue;

    // 轮次开始后订阅可能被取消、清库或重新启用；请求前按稳定用户 ID 刷新，
    // 避免开发热重载留下的旧轮次继续访问已经不存在的账号。
    const currentGroup = await ctx.database.get("x_watcher", {
      twitter_id: snapshot.twitter_id,
      active: true,
    });
    if (!canContinue()) return false;
    const first = currentGroup[0];
    if (first === undefined) continue;
    const fetched = await source.fetchAfter(
      watcherUser(first),
      oldestCursor(currentGroup),
      new Date(),
    );
    if (!canContinue()) return false;
    if (!fetched.ok) {
      // 请求期间最后一条订阅也可能被移除；这时错误已与当前配置无关，不再制造陈旧告警。
      const stillActive = await ctx.database.get("x_watcher", {
        twitter_id: first.twitter_id,
        active: true,
      });
      if (!canContinue()) return false;
      if (stillActive.length === 0) continue;
      logger.error(
        `获取 @${first.twitter_username} 动态失败 [${fetched.error.kind}]：${fetched.error.message}`,
      );
      completed = false;
      continue;
    }
    for (const watcher of currentGroup) {
      // 远端分页可能耗时较长，投递前重新读取订阅，避免取消或重新启用后使用旧水位。
      const refreshed = await ctx.database.get("x_watcher", {
        id: watcher.id,
        active: true,
      });
      const current = refreshed[0];
      if (current === undefined) continue;
      const delivered = await processWatcherActivities(
        ctx,
        logger,
        tracker,
        current,
        fetched.value.activities,
        canContinue,
        delivery,
      );
      if (!delivered) completed = false;
    }
  }
  return completed;
}

/**
 * 对全部活跃订阅执行一次水位恢复。
 *
 * 同一 X 用户只请求一次，各频道随后独立过滤和推进水位。
 */
export async function recoverActiveWatchers(
  ctx: Context,
  source: XDataSourceService,
  logger: Logger,
  tracker: DeliveryTracker,
  canContinue: ContinueDelivery = alwaysContinue,
  delivery: DeliveryOptions = defaultDeliveryOptions,
): Promise<boolean> {
  const watchers = await getActiveWatchers(ctx);
  return recoverWatchers(
    ctx,
    source,
    logger,
    tracker,
    watchers,
    canContinue,
    delivery,
  );
}

/** 仅为首次激活的远端 monitor 做一次补漏，不触碰其他账号。 */
export async function recoverActiveHandles(
  ctx: Context,
  source: XDataSourceService,
  logger: Logger,
  tracker: DeliveryTracker,
  handles: ReadonlySet<string>,
  canContinue: ContinueDelivery = alwaysContinue,
  delivery: DeliveryOptions = defaultDeliveryOptions,
): Promise<boolean> {
  const watchers = await getActiveWatchers(ctx);
  const matching = watchers.filter((watcher) =>
    handles.has(canonicalHandle(watcher.twitter_username))
  );
  return recoverWatchers(
    ctx,
    source,
    logger,
    tracker,
    matching,
    canContinue,
    delivery,
  );
}

/** 把实时事件路由到当前仍活跃且目标账号匹配的频道。 */
export async function routeLiveActivities(
  ctx: Context,
  logger: Logger,
  tracker: DeliveryTracker,
  activities: ReadonlyArray<XActivity>,
  canContinue: ContinueDelivery = alwaysContinue,
  delivery: DeliveryOptions = defaultDeliveryOptions,
): Promise<boolean> {
  if (!canContinue()) return false;
  const watchers = await getActiveWatchers(ctx);
  let completed = true;
  for (const watcher of watchers) {
    const matching = activities.filter(
      (activity) =>
        activity.authorId === watcher.twitter_id ||
        canonicalHandle(activity.username) ===
          canonicalHandle(watcher.twitter_username),
    );
    const delivered = await processWatcherActivities(
      ctx,
      logger,
      tracker,
      watcher,
      matching,
      canContinue,
      delivery,
    );
    if (!delivered) completed = false;
  }
  return completed;
}

/** 创建带非重入保护的轮询入口。 */
export function createPollingRunner(
  ctx: Context,
  source: XDataSourceService,
  logger: Logger,
  tracker: DeliveryTracker,
  canContinue: ContinueDelivery = alwaysContinue,
  delivery: DeliveryOptions = defaultDeliveryOptions,
): () => Promise<void> {
  let running = false;
  return async () => {
    if (!canContinue()) return;
    if (running) {
      logger.warn("上一轮 X 动态检查尚未结束，跳过本轮");
      return;
    }
    running = true;
    try {
      await recoverActiveWatchers(
        ctx,
        source,
        logger,
        tracker,
        canContinue,
        delivery,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`X 动态检查失败：${message}`);
    } finally {
      running = false;
    }
  };
}
