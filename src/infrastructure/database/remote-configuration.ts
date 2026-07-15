import type { Context } from "koishi";
import { reconcileControlIntent } from "./control-intent";
import { runTransaction, type XWatcherDatabase } from "./database-effect";
import { appendRemoteOrphan } from "./remote-orphan";
import type { AccountRow } from "./rows-domain";

/** 将一组全局远端配置应用到单个账号。 */
const configureAccount = async (
  database: XWatcherDatabase,
  account: AccountRow,
  enabled: boolean,
  fingerprint: string | null,
  now: Date,
): Promise<void> => {
  const changed =
    account.remoteMonitoring !== enabled ||
    account.remoteKeyFingerprint !== fingerprint;
  const currentKeyAvailable =
    fingerprint !== null && fingerprint === account.remoteKeyFingerprint;
  const mustOrphan = account.remoteId !== null && !currentKeyAvailable;
  const current = mustOrphan
    ? await appendRemoteOrphan(
        database,
        account,
        account.remoteId,
        account.remoteKeyFingerprint,
        now,
      )
    : account;
  if (changed || mustOrphan) {
    await database.set(
      "x_watcher_account",
      { id: account.id },
      {
        remoteMonitoring: enabled,
        remoteKeyFingerprint: fingerprint,
        remoteId: mustOrphan ? null : current.remoteId,
        remoteStatus: mustOrphan
          ? current.orphanedRemoteIds.length === 0
            ? "inactive"
            : "orphaned-manual-cleanup"
          : current.remoteId === null ? "inactive" : current.remoteStatus,
        reconcileAt: null,
        lastError: current.lastError,
        updatedAt: now,
      },
    );
  }
  await reconcileControlIntent(database, account.id, now);
};

/** 在 worker 启动前把全局实时模式与 key 指纹同步到全部既有账号。 */
export const configureRemoteMonitoring = (
  ctx: Context,
  enabled: boolean,
  fingerprint: string | null,
  now: Date,
) =>
  runTransaction(ctx, "configureRemoteMonitoring", async (database) => {
    const accounts = await database.get(
      "x_watcher_account",
      {},
      { sort: { id: "asc" } },
    );
    for (const account of accounts) {
      await configureAccount(database, account, enabled, fingerprint, now);
    }
  });
