import { sortActivitiesOldestFirst } from "../../domain/activity";
import {
  isActivityAfter,
  type ActivityId,
} from "../../domain/identifiers";
import { createRecoverySummaryPlan } from "../../domain/message";
import type { CommitRecoveryInput } from "../../ports/storage";
import { newestCursor } from "./cursor";
import type { XWatcherDatabase } from "./database-effect";
import { ensureDelivery } from "./delivery-write";
import { routeActivity } from "./routing";

/** 判断第 21 条边界动态是否仍位于订阅自己的恢复范围内。 */
const overflowBoundaryNeedsDelivery = (
  subscription: {
    readonly cursor: ActivityId | null;
    readonly activeSince: Date;
  },
  input: CommitRecoveryInput,
): boolean => {
  const boundary = input.overflowBoundary;
  if (boundary === null) return false;
  return boundary.createdAtEpochMillis >= subscription.activeSince.getTime() &&
    (subscription.cursor === null ||
      isActivityAfter(boundary.id, subscription.cursor));
};

/** 为真正达到恢复上限的订阅创建摘要并返回其订阅标识。 */
const routeRecoverySummary = async (
  database: XWatcherDatabase,
  input: CommitRecoveryInput,
): Promise<ReadonlySet<number>> => {
  const summarized = new Set<number>();
  const newestId = input.newestId;
  if (newestId === null) return summarized;
  const subscriptions = await database.get("x_watcher_subscription", {
    accountId: input.account.id,
    active: true,
  });
  for (const subscription of subscriptions) {
    if (!overflowBoundaryNeedsDelivery(subscription, input)) continue;
    await ensureDelivery(
      database,
      subscription.id,
      null,
      `recovery:${newestId}`,
      createRecoverySummaryPlan(
        input.account.handle,
        newestId,
        input.now.getTime(),
      ),
      input.now,
    );
    summarized.add(subscription.id);
  }
  return summarized;
};

/** 在同一事务内写入恢复活动、投递任务与单调最终水位。 */
export const commitRecoveryTransaction = async (
  database: XWatcherDatabase,
  input: CommitRecoveryInput,
): Promise<void> => {
  const newestId = input.newestId;
  if (newestId === null) {
    await database.set(
      "x_watcher_account",
      { id: input.account.id },
      {
        status: "ready",
        ...(input.consumeRecoveryDue ? { reconcileAt: null } : {}),
        updatedAt: input.now,
      },
    );
    return;
  }
  const activities = sortActivitiesOldestFirst(input.activities);
  if (input.overflow) {
    const summarized = await routeRecoverySummary(database, input);
    for (const activity of activities) {
      await routeActivity(
        database,
        input.account.id,
        activity,
        input.now,
        summarized,
      );
    }
  } else {
    for (const activity of activities) {
      await routeActivity(database, input.account.id, activity, input.now);
    }
  }
  const subscriptions = await database.get("x_watcher_subscription", {
    accountId: input.account.id,
    active: true,
  });
  for (const subscription of subscriptions) {
    await database.set(
      "x_watcher_subscription",
      { id: subscription.id },
      {
        cursor: newestCursor(subscription.cursor, newestId),
        updatedAt: input.now,
      },
    );
  }
  const accounts = await database.get(
    "x_watcher_account",
    { id: input.account.id },
    { limit: 1 },
  );
  const account = accounts[0];
  await database.set(
    "x_watcher_account",
    { id: input.account.id },
    {
      cursor: account === undefined
        ? newestId
        : newestCursor(account.cursor, newestId),
      status: "ready",
      ...(input.consumeRecoveryDue ? { reconcileAt: null } : {}),
      updatedAt: input.now,
    },
  );
};
