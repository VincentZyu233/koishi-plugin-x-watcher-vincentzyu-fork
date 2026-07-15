import type { Context } from "koishi";
import { reconcileControlIntent } from "./control-intent";
import { runTransaction } from "./database-effect";

/** 把无法证明归属的 add 任务终结为可见的人工协调状态。 */
export const coordinateControlAdd = (
  ctx: Context,
  controlId: number,
  claimToken: string,
  candidateRemoteIds: ReadonlyArray<string>,
  message: string,
  now: Date,
) =>
  runTransaction(ctx, "coordinateControlAdd", async (database) => {
    const rows = await database.get(
      "x_watcher_control",
      { id: controlId, status: "processing", claimToken, operation: "add" },
      { limit: 1 },
    );
    const row = rows[0];
    if (row === undefined) return;
    const suffix = candidateRemoteIds.length === 0
      ? "未发现可安全接管的远端 ID"
      : `候选远端 ID（归属未确认，禁止自动删除）：${candidateRemoteIds.join(", ")}`;
    const visibleMessage = `${message}；${suffix}`;
    await database.set(
      "x_watcher_control",
      { id: controlId, status: "processing", claimToken },
      {
        status: "cancelled",
        leaseUntil: null,
        claimToken: null,
        lastError: visibleMessage,
        completedAt: now,
      },
    );
    const accounts = await database.get(
      "x_watcher_account",
      { id: row.accountId },
      { limit: 1 },
    );
    const account = accounts[0];
    if (account === undefined) return;
    if (account.remoteKeyFingerprint !== row.keyFingerprint) {
      await database.set(
        "x_watcher_account",
        { id: row.accountId },
        { lastError: visibleMessage, updatedAt: now },
      );
      await reconcileControlIntent(database, row.accountId, now);
      return;
    }
    await database.set(
      "x_watcher_account",
      { id: row.accountId },
      {
        remoteId: null,
        remoteStatus: "ownership-uncertain",
        reconcileAt: null,
        lastError: visibleMessage,
        updatedAt: now,
      },
    );
  });
