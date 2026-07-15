import type { MessagePlan } from "../../domain/message";
import type { XActivity } from "../../domain/activity";
import type { XWatcherDatabase } from "./database-effect";
import type { ActivityRow } from "./rows-domain";

/** 幂等写入规范化动态审计行并返回稳定主键。 */
export const ensureActivity = async (
  database: XWatcherDatabase,
  accountId: number,
  activity: XActivity,
  now: Date,
): Promise<ActivityRow> => {
  const existing = await database.get(
    "x_watcher_activity",
    { accountId, activityId: activity.id },
    { limit: 1 },
  );
  if (existing[0] !== undefined) return existing[0];
  return database.create("x_watcher_activity", {
    accountId,
    activityId: activity.id,
    payloadJson: JSON.stringify(activity),
    createdAt: new Date(activity.createdAtEpochMillis),
    recordedAt: now,
  });
};

/** 按订阅与去重键幂等创建投递任务。 */
export const ensureDelivery = async (
  database: XWatcherDatabase,
  subscriptionId: number,
  activityRecordId: number | null,
  dedupeKey: string,
  plan: MessagePlan,
  now: Date,
): Promise<void> => {
  const existing = await database.get(
    "x_watcher_delivery",
    { subscriptionId, dedupeKey },
    { limit: 1 },
  );
  if (existing.length > 0) return;
  await database.create("x_watcher_delivery", {
    subscriptionId,
    activityRecordId,
    dedupeKey,
    plan,
    status: "pending",
    stage: "mixed",
    partIndex: 0,
    attempts: 0,
    availableAt: now,
    leaseUntil: null,
    claimToken: null,
    lastError: null,
    createdAt: now,
    completedAt: null,
  });
};
