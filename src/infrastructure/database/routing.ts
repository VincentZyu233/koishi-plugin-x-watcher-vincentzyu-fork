import * as Either from "effect/Either";
import { buildSearchableText, type XActivity } from "../../domain/activity";
import { matchesFilter } from "../../domain/filter";
import { isActivityAfter } from "../../domain/identifiers";
import { createMessagePlan } from "../../domain/message";
import { newestCursor } from "./cursor";
import type { XWatcherDatabase } from "./database-effect";
import { ensureActivity, ensureDelivery } from "./delivery-write";
import type { SubscriptionRow } from "./rows-domain";

/** 动态路由时用于区分恢复水位与实时接收时间的策略。 */
type RoutingPolicy =
  | { readonly _tag: "Recovery" }
  | { readonly _tag: "Realtime"; readonly receivedAt: Date };

/** 判断动态是否满足订阅的类型与安全正则过滤规则。 */
const shouldDeliver = (
  subscription: SubscriptionRow,
  activity: XActivity,
): boolean => {
  if (!subscription.kinds.includes(activity.kind)) return false;
  const matched = matchesFilter(
    subscription.filterPattern,
    buildSearchableText(activity),
  );
  return Either.isRight(matched) && matched.right;
};

/** 判断订阅是否应接收当前来源的动态。 */
const shouldRoute = (
  subscription: SubscriptionRow,
  activity: XActivity,
  policy: RoutingPolicy,
): boolean => {
  if (activity.createdAtEpochMillis < subscription.activeSince.getTime()) {
    return false;
  }
  if (policy._tag === "Realtime") {
    return policy.receivedAt.getTime() >= subscription.activeSince.getTime();
  }
  return subscription.cursor === null || isActivityAfter(activity.id, subscription.cursor);
};

/** 按来源策略把单条动态幂等路由给当前有效订阅。 */
const routeWithPolicy = async (
  database: XWatcherDatabase,
  accountId: number,
  activity: XActivity,
  now: Date,
  policy: RoutingPolicy,
  excludedSubscriptionIds: ReadonlySet<number>,
): Promise<void> => {
  const activityRow = await ensureActivity(database, accountId, activity, now);
  const subscriptions = await database.get("x_watcher_subscription", {
    accountId,
    active: true,
  });
  for (const subscription of subscriptions) {
    if (excludedSubscriptionIds.has(subscription.id)) continue;
    if (!shouldRoute(subscription, activity, policy)) continue;
    if (shouldDeliver(subscription, activity)) {
      await ensureDelivery(
        database,
        subscription.id,
        activityRow.id,
        `activity:${activity.id}`,
        createMessagePlan(activity, subscription.includeMedia),
        now,
      );
    }
    await database.set(
      "x_watcher_subscription",
      { id: subscription.id },
      { cursor: newestCursor(subscription.cursor, activity.id), updatedAt: now },
    );
  }
  const accounts = await database.get("x_watcher_account", { id: accountId }, {
    limit: 1,
  });
  const account = accounts[0];
  if (account === undefined) return;
  await database.set(
    "x_watcher_account",
    { id: accountId },
    {
      handle: activity.authorHandle,
      displayName: activity.authorName,
      cursor: newestCursor(account.cursor, activity.id),
      updatedAt: now,
    },
  );
};

/** 把恢复动态路由给尚未越过其水位的有效订阅。 */
export const routeActivity = (
  database: XWatcherDatabase,
  accountId: number,
  activity: XActivity,
  now: Date,
  excludedSubscriptionIds: ReadonlySet<number> = new Set(),
): Promise<void> =>
  routeWithPolicy(
    database,
    accountId,
    activity,
    now,
    { _tag: "Recovery" },
    excludedSubscriptionIds,
  );

/** 按接收时间路由实时动态，允许 Tweet ID 小范围乱序。 */
export const routeRealtimeActivity = (
  database: XWatcherDatabase,
  accountId: number,
  activity: XActivity,
  receivedAt: Date,
  now: Date,
): Promise<void> =>
  routeWithPolicy(database, accountId, activity, now, {
    _tag: "Realtime",
    receivedAt,
  }, new Set());
