import type { Context } from "koishi";
import type { ActivityId } from "../../domain/identifiers";
import type { CommitRecoveryInput } from "../../ports/storage";
import { runTransaction } from "./database-effect";
import { commitRecoveryTransaction } from "./recovery-routing";

/** 为初始化中的账号及其订阅原子建立无历史基线。 */
export const initializeAccount = (
  ctx: Context,
  accountId: number,
  latestId: ActivityId | null,
  consumeRecoveryDue: boolean,
  now: Date,
) =>
  runTransaction(ctx, "initializeAccount", async (database) => {
    const accounts = await database.get(
      "x_watcher_account",
      { id: accountId },
      { limit: 1 },
    );
    const account = accounts[0];
    if (account === undefined || account.status === "ready") return;
    await database.set(
      "x_watcher_account",
      { id: accountId },
      {
        cursor: latestId,
        status: "ready",
        ...(consumeRecoveryDue ? { reconcileAt: null } : {}),
        updatedAt: now,
      },
    );
    await database.set(
      "x_watcher_subscription",
      { accountId, active: true, cursor: { $exists: false } },
      { cursor: latestId, updatedAt: now },
    );
  });

/** 原子提交恢复活动、投递任务、摘要和最终水位。 */
export const commitRecovery = (ctx: Context, input: CommitRecoveryInput) =>
  runTransaction(ctx, "commitRecovery", (database) =>
    commitRecoveryTransaction(database, input),
  );
