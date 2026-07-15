import * as Option from "effect/Option";
import type { Context } from "koishi";
import { randomUUID } from "node:crypto";
import type { XActivity } from "../../domain/activity";
import type { RawRealtimeEvent } from "../../ports/source";
import type { StoredRawEvent } from "../../ports/storage";
import { runTransaction } from "./database-effect";
import { toStoredRawEvent } from "./mapping";
import { routeRealtimeActivity } from "./routing";
import type { RawEventRow } from "./rows-queue";

/** 原始事件 worker 的固定租约时长。 */
const RAW_EVENT_LEASE_MILLIS = 60_000;

/** 判断原始事件是否已到执行时间且没有有效租约。 */
const isRawEventEligible = (row: RawEventRow, now: Date): boolean => {
  if (row.availableAt.getTime() > now.getTime()) return false;
  if (row.status === "pending") return true;
  return row.status === "processing" && row.leaseUntil !== null &&
    row.leaseUntil.getTime() <= now.getTime();
};

/** 幂等持久化实时原始事件，未知作者也必须先可靠入队。 */
export const persistRawEvent = (ctx: Context, event: RawRealtimeEvent) =>
  runTransaction(ctx, "persistRawEvent", async (database) => {
    const existing = await database.get(
      "x_watcher_raw_event",
      { eventKey: event.eventKey },
      { limit: 1 },
    );
    if (existing.length > 0) return;
    const accountXUserId = Option.getOrNull(event.accountId);
    const accounts = accountXUserId === null
      ? []
      : await database.get(
          "x_watcher_account",
          { xUserId: accountXUserId },
          { limit: 1 },
        );
    const account = accounts[0];
    const receivedAt = new Date(event.receivedAtEpochMillis);
    await database.create("x_watcher_raw_event", {
      eventKey: event.eventKey,
      accountId: account === undefined ? null : account.id,
      accountXUserId,
      activityId: Option.getOrNull(event.activityId),
      provider: event.provider,
      reduced: event.reduced,
      payloadJson: event.payloadJson,
      receivedAt,
      status: "pending",
      attempts: 0,
      availableAt: receivedAt,
      leaseUntil: null,
      claimToken: null,
      lastError: null,
      completedAt: null,
      createdAt: receivedAt,
    });
  });

/** 原子领取一个到期原始事件，并给补全 worker 设置固定租约。 */
export const claimRawEvent = (ctx: Context, now: Date) =>
  runTransaction(
    ctx,
    "claimRawEvent",
    async (database): Promise<StoredRawEvent | null> => {
      const rows = await database.get(
        "x_watcher_raw_event",
        { $or: [{ status: "pending" }, { status: "processing" }] },
        { sort: { id: "asc" } },
      );
      const row = rows.find(
        (candidate) =>
          (candidate.status === "pending" || candidate.status === "processing") &&
          isRawEventEligible(candidate, now),
      );
      if (row === undefined) return null;
      const attempts = row.attempts + 1;
      const claimToken = randomUUID();
      const leaseUntil = new Date(now.getTime() + RAW_EVENT_LEASE_MILLIS);
      await database.set(
        "x_watcher_raw_event",
        {
          id: row.id,
          status: row.status,
          claimToken: row.claimToken === null ? { $exists: false } : row.claimToken,
        },
        {
          status: "processing",
          attempts,
          leaseUntil,
          claimToken,
          lastError: null,
        },
      );
      const claimed = await database.get(
        "x_watcher_raw_event",
        { id: row.id, status: "processing", claimToken },
        { limit: 1 },
      );
      return claimed[0] === undefined ? null
        : toStoredRawEvent(claimed[0], claimed[0].accountId, claimToken);
    },
  );

/** 原子路由补全动态并把原始事件标记为完成。 */
export const completeRawEvent = (
  ctx: Context,
  rawEventId: number,
  claimToken: string,
  activity: XActivity,
  now: Date,
) =>
  runTransaction(ctx, "completeRawEvent", async (database) => {
    const rows = await database.get(
      "x_watcher_raw_event",
      { id: rawEventId, status: "processing", claimToken },
      { limit: 1 },
    );
    const row = rows[0];
    if (row === undefined) return;
    const matchedAccounts = row.accountId === null
      ? await database.get(
          "x_watcher_account",
          { xUserId: activity.authorId },
          { limit: 1 },
        )
      : [];
    const accountId = row.accountId === null
      ? matchedAccounts[0] === undefined ? null : matchedAccounts[0].id
      : row.accountId;
    if (accountId !== null) {
      await routeRealtimeActivity(database, accountId, activity, row.receivedAt, now);
    }
    await database.set(
      "x_watcher_raw_event",
      { id: rawEventId, status: "processing", claimToken },
      {
        status: "completed",
        accountId,
        leaseUntil: null,
        claimToken: null,
        lastError: null,
        completedAt: now,
      },
    );
  });

/** 释放原始事件租约并安排下一次补全尝试。 */
export const retryRawEvent = (
  ctx: Context,
  rawEventId: number,
  claimToken: string,
  availableAt: Date,
  message: string,
) =>
  runTransaction(ctx, "retryRawEvent", async (database) => {
    await database.set(
      "x_watcher_raw_event",
      { id: rawEventId, status: "processing", claimToken },
      {
        status: "pending",
        availableAt,
        leaseUntil: null,
        claimToken: null,
        lastError: message,
      },
    );
  });
