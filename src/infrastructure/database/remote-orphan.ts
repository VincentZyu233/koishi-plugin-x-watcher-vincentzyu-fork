import type { XWatcherDatabase } from "./database-effect";
import type { AccountRow } from "./rows-domain";

/** 格式化必须由旧 key 手工清理的远端 ID 提示。 */
export const orphanCleanupMessage = (
  ids: ReadonlyArray<string>,
): string | null =>
  ids.length === 0
    ? null
    : `需使用旧 API key 手动清理远端监控 ID：${ids.join(", ")}`;

/** 合并 orphan 提示与账号最近一次普通错误。 */
export const visibleAccountError = (account: AccountRow): string | null => {
  const orphan = orphanCleanupMessage(account.orphanedRemoteIds);
  if (orphan === null) return account.lastError;
  if (account.lastError === null || account.lastError.startsWith("需使用旧 API key")) {
    return orphan;
  }
  return `${orphan}；最近错误：${account.lastError}`;
};

/** 为订阅列表生成包含 orphan ID 的可见远端状态。 */
export const visibleRemoteStatus = (account: AccountRow): string =>
  account.orphanedRemoteIds.length === 0
    ? account.remoteStatus
    : `${account.remoteStatus}-with-orphan-manual-cleanup:${account.orphanedRemoteIds.join(",")}`;

/** 持久化一个不可跨 key 自动清理的远端 ID 及终态审计。 */
export const appendRemoteOrphan = async (
  database: XWatcherDatabase,
  account: AccountRow,
  remoteId: string,
  keyFingerprint: string | null,
  now: Date,
): Promise<AccountRow> => {
  const known = account.orphanedRemoteIds.includes(remoteId);
  const orphanedRemoteIds = known
    ? [...account.orphanedRemoteIds]
    : [...account.orphanedRemoteIds, remoteId];
  const message = orphanCleanupMessage(orphanedRemoteIds);
  if (!known) {
    await database.create("x_watcher_control", {
      accountId: account.id,
      operation: "remove",
      keyFingerprint,
      remoteId,
      status: "cancelled",
      attempts: 0,
      availableAt: now,
      leaseUntil: null,
      claimToken: null,
      lastError: message,
      createdAt: now,
      completedAt: now,
    });
  }
  const updated: AccountRow = {
    ...account,
    orphanedRemoteIds,
    remoteId: account.remoteId === remoteId ? null : account.remoteId,
    remoteStatus: "orphaned-manual-cleanup",
    reconcileAt: null,
    lastError: message,
    updatedAt: now,
  };
  await database.set("x_watcher_account", { id: account.id }, {
    orphanedRemoteIds,
    remoteId: updated.remoteId,
    remoteStatus: updated.remoteStatus,
    reconcileAt: null,
    lastError: message,
    updatedAt: now,
  });
  return updated;
};
