import type { XWatcherDatabase } from "./database-effect";
import type { AccountRow } from "./rows-domain";
import type { ControlRow } from "./rows-queue";

/** 取消尚未被 worker 领取的反向控制任务。 */
const cancelPending = async (
  database: XWatcherDatabase,
  rows: ReadonlyArray<ControlRow>,
  operation: ControlRow["operation"],
  now: Date,
): Promise<void> => {
  const ids = rows
    .filter((row) => row.operation === operation && row.status === "pending")
    .map((row) => row.id);
  if (ids.length === 0) return;
  await database.set(
    "x_watcher_control",
    { id: ids, status: "pending" },
    { status: "cancelled", completedAt: now, leaseUntil: null, claimToken: null },
  );
};

/** 创建一条远端监控控制 outbox 任务。 */
const createControl = async (
  database: XWatcherDatabase,
  account: AccountRow,
  operation: ControlRow["operation"],
  now: Date,
): Promise<void> => {
  await database.create("x_watcher_control", {
    accountId: account.id,
    operation,
    keyFingerprint: account.remoteKeyFingerprint,
    remoteId: operation === "remove" ? account.remoteId : null,
    status: "pending",
    attempts: 0,
    availableAt: now,
    leaseUntil: null,
    claimToken: null,
    lastError: null,
    createdAt: now,
    completedAt: null,
  });
};

/** 更新账号对外可见的远端同步状态。 */
const setRemoteStatus = async (
  database: XWatcherDatabase,
  accountId: number,
  remoteStatus: string,
  now: Date,
): Promise<void> => {
  await database.set(
    "x_watcher_account",
    { id: accountId },
    { remoteStatus, updatedAt: now },
  );
};

/** 更新远端过渡状态并清除不再适用的一次性补拉时间。 */
const setRemoteTransitionStatus = async (
  database: XWatcherDatabase,
  accountId: number,
  remoteStatus: string,
  now: Date,
): Promise<void> => {
  await database.set(
    "x_watcher_account",
    { id: accountId },
    { remoteStatus, reconcileAt: null, updatedAt: now },
  );
};

/** 将账号的有效订阅意图收敛为至多一个正确方向的 outbox 任务。 */
export const reconcileControlIntent = async (
  database: XWatcherDatabase,
  accountId: number,
  now: Date,
): Promise<void> => {
  const accountRows = await database.get("x_watcher_account", { id: accountId }, {
    limit: 1,
  });
  const account = accountRows[0];
  if (account === undefined) return;
  const active = await database.get(
    "x_watcher_subscription",
    { accountId, active: true },
    { limit: 1 },
  );
  const controls = await database.get(
    "x_watcher_control",
    { accountId },
    { sort: { id: "asc" } },
  );
  const staleIds = controls
    .filter(
      (row) =>
        row.status === "pending" &&
        row.keyFingerprint !== account.remoteKeyFingerprint,
    )
    .map((row) => row.id);
  if (staleIds.length > 0) {
    await database.set(
      "x_watcher_control",
      { id: staleIds, status: "pending" },
      { status: "cancelled", completedAt: now, leaseUntil: null, claimToken: null },
    );
  }
  const outstanding = controls.filter(
    (row) =>
      row.keyFingerprint === account.remoteKeyFingerprint &&
      (row.status === "pending" || row.status === "processing"),
  );
  if (active.length > 0 && account.remoteMonitoring) {
    if (account.remoteStatus === "ownership-uncertain" && account.remoteId === null) {
      return;
    }
    await cancelPending(database, outstanding, "remove", now);
    const removing = outstanding.some(
      (row) => row.operation === "remove" && row.status === "processing",
    );
    if (removing) {
      return setRemoteTransitionStatus(database, accountId, "pending-readd", now);
    }
    if (account.remoteId !== null) {
      return setRemoteStatus(database, accountId, "active", now);
    }
    const adding = outstanding.some(
      (row) => row.operation === "add" && row.status !== "cancelled",
    );
    if (!adding) await createControl(database, account, "add", now);
    return setRemoteTransitionStatus(database, accountId, "pending-add", now);
  }
  await cancelPending(database, outstanding, "add", now);
  const adding = outstanding.some(
    (row) => row.operation === "add" && row.status === "processing",
  );
  if (adding) {
    return setRemoteTransitionStatus(database, accountId, "pending-disable", now);
  }
  if (account.remoteId === null) {
    return setRemoteTransitionStatus(database, accountId, "inactive", now);
  }
  const removing = outstanding.some(
    (row) => row.operation === "remove" && row.status !== "cancelled",
  );
  if (!removing) await createControl(database, account, "remove", now);
  return setRemoteTransitionStatus(database, accountId, "pending-remove", now);
};
