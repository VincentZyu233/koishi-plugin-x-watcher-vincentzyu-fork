import type { Context } from "koishi";
import { randomUUID } from "node:crypto";
import type { ClaimedControl } from "../../ports/storage";
import { reconcileControlIntent } from "./control-intent";
import { runTransaction } from "./database-effect";
import { toClaimedControl } from "./mapping";
import type { ControlRow } from "./rows-queue";

/** 判断控制任务当前是否已到期且没有有效租约。 */
const isControlEligible = (row: ControlRow, now: Date): boolean => {
  if (row.availableAt.getTime() > now.getTime()) return false;
  if (row.status === "pending") return true;
  return row.status === "processing" &&
    row.leaseUntil !== null &&
    row.leaseUntil.getTime() <= now.getTime();
};

/** 按账号内的 outbox 顺序原子领取一个远端控制任务。 */
export const claimControl = (
  ctx: Context,
  now: Date,
  leaseUntil: Date,
) =>
  runTransaction(
    ctx,
    "claimControl",
    async (database): Promise<ClaimedControl | null> => {
      const rows = await database.get(
        "x_watcher_control",
        { $or: [{ status: "pending" }, { status: "processing" }] },
        { sort: { id: "asc" } },
      );
      const seen = new Set<number>();
      for (const row of rows) {
        if (row.status !== "pending" && row.status !== "processing") continue;
        if (seen.has(row.accountId)) continue;
        seen.add(row.accountId);
        if (!isControlEligible(row, now)) continue;
        const accounts = await database.get(
          "x_watcher_account",
          { id: row.accountId },
          { limit: 1 },
        );
        const account = accounts[0];
        if (account === undefined) {
          await database.set(
            "x_watcher_control",
            {
              id: row.id,
              status: row.status,
              claimToken: row.claimToken === null ? { $exists: false } : row.claimToken,
            },
            {
              status: "cancelled",
              leaseUntil: null,
              claimToken: null,
              completedAt: now,
            },
          );
          continue;
        }
        const active = await database.get(
          "x_watcher_subscription",
          { accountId: account.id, active: true },
          { limit: 1 },
        );
        const wantsRemote = active.length > 0 && account.remoteMonitoring;
        const obsolete =
          row.keyFingerprint !== account.remoteKeyFingerprint ||
          (row.operation === "add" && (!wantsRemote || account.remoteId !== null)) ||
          (row.operation === "remove" && (wantsRemote || account.remoteId === null));
        if (obsolete) {
          await database.set(
            "x_watcher_control",
            {
              id: row.id,
              status: row.status,
              claimToken: row.claimToken === null ? { $exists: false } : row.claimToken,
            },
            {
              status: "cancelled",
              leaseUntil: null,
              claimToken: null,
              completedAt: now,
            },
          );
          await reconcileControlIntent(database, account.id, now);
          continue;
        }
        const attempts = row.attempts + 1;
        const claimToken = randomUUID();
        await database.set(
          "x_watcher_control",
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
          "x_watcher_control",
          { id: row.id, status: "processing", claimToken },
          { limit: 1 },
        );
        if (claimed[0] === undefined) continue;
        return toClaimedControl(
          claimed[0],
          account,
          claimToken,
        );
      }
      return null;
    },
  );
