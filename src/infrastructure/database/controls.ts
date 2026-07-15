import type { Context } from "koishi";
import { reconcileControlIntent } from "./control-intent";
import { runTransaction } from "./database-effect";
import { appendRemoteOrphan, orphanCleanupMessage } from "./remote-orphan";

/** add 成功后默认触发一次补拉的延迟。 */
const REALTIME_RECOVERY_DELAY_MILLIS = 20 * 60_000;

/** 完成远端控制任务，持久化远端标识并重新收敛当前订阅意图。 */
export const completeControl = (
  ctx: Context,
  controlId: number,
  claimToken: string,
  remoteId: string | null,
  reconcileAt: Date | null,
  now: Date,
) =>
  runTransaction(ctx, "completeControl", async (database) => {
    const rows = await database.get(
      "x_watcher_control",
      { id: controlId, status: "processing", claimToken },
      { limit: 1 },
    );
    const row = rows[0];
    if (row === undefined) return;
    await database.set(
      "x_watcher_control",
      { id: controlId, status: "processing", claimToken },
      {
        status: "completed",
        remoteId: row.operation === "add" ? remoteId : row.remoteId,
        leaseUntil: null,
        claimToken: null,
        lastError: null,
        completedAt: now,
      },
    );
    const accounts = await database.get(
      "x_watcher_account",
      { id: row.accountId },
      { limit: 1 },
    );
    const account = accounts[0];
    const stale =
      account === undefined ||
      account.remoteKeyFingerprint !== row.keyFingerprint;
    if (stale) {
      if (row.operation === "add") {
        const message = remoteId === null
          ? "过期 key/mode 的 add 任务未返回远端 ID"
          : orphanCleanupMessage([remoteId]);
        await database.set(
          "x_watcher_control",
          { id: controlId },
          {
            status: "cancelled",
            claimToken: null,
            lastError: message,
            completedAt: now,
          },
        );
        if (account !== undefined && remoteId !== null) {
          await appendRemoteOrphan(
            database,
            account,
            remoteId,
            row.keyFingerprint,
            now,
          );
        }
      }
      if (account !== undefined) {
        await reconcileControlIntent(database, row.accountId, now);
      }
      return;
    }
    if (account === undefined) return;
    const orphan = orphanCleanupMessage(account.orphanedRemoteIds);
    if (row.operation === "add") {
      const due = reconcileAt === null
        ? new Date(now.getTime() + REALTIME_RECOVERY_DELAY_MILLIS)
        : reconcileAt;
      await database.set(
        "x_watcher_account",
        { id: row.accountId },
        {
          remoteId,
          remoteStatus: remoteId === null ? "error" : "active",
          reconcileAt: remoteId === null ? null : due,
          lastError: remoteId === null
            ? "远端 add 成功但未返回监控 ID"
            : orphan,
          updatedAt: now,
        },
      );
    } else {
      await database.set(
        "x_watcher_account",
        { id: row.accountId },
        {
          remoteId: null,
          remoteStatus: "inactive",
          reconcileAt: null,
          lastError: orphan,
          updatedAt: now,
        },
      );
    }
    await reconcileControlIntent(database, row.accountId, now);
  });

/** 释放失败控制任务的租约并记录账号可见错误。 */
export const retryControl = (
  ctx: Context,
  controlId: number,
  claimToken: string,
  availableAt: Date,
  message: string,
) =>
  runTransaction(ctx, "retryControl", async (database) => {
    const rows = await database.get(
      "x_watcher_control",
      { id: controlId, status: "processing", claimToken },
      { limit: 1 },
    );
    const row = rows[0];
    if (row === undefined) return;
    const accounts = await database.get(
      "x_watcher_account",
      { id: row.accountId },
      { limit: 1 },
    );
    const account = accounts[0];
    const orphan = account === undefined
      ? null
      : orphanCleanupMessage(account.orphanedRemoteIds);
    const accountError = orphan === null ? message : `${orphan}；最近错误：${message}`;
    await database.set(
      "x_watcher_control",
      { id: controlId, status: "processing", claimToken },
      {
        status: "pending",
        availableAt,
        leaseUntil: null,
        claimToken: null,
        lastError: message,
      },
    );
    await database.set(
      "x_watcher_account",
      { id: row.accountId },
      { remoteStatus: "error", lastError: accountError, updatedAt: availableAt },
    );
    await reconcileControlIntent(database, row.accountId, availableAt);
  });
