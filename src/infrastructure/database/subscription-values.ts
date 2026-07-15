import * as Either from "effect/Either";
import { compileFilter } from "../../domain/filter";
import type { FilterPatch, SaveSubscriptionInput } from "../../ports/storage";
import type { XWatcherDatabase } from "./database-effect";
import { appendRemoteOrphan } from "./remote-orphan";
import type { AccountRow, SubscriptionRow } from "./rows-domain";

/** 根据过滤补丁计算持久化规则与有效状态。 */
export const resolveFilter = (
  patch: FilterPatch,
  existing: SubscriptionRow | undefined,
): Pick<SubscriptionRow, "filterPattern" | "filterStatus"> => {
  if (patch._tag === "Preserve" && existing !== undefined) {
    return {
      filterPattern: existing.filterPattern,
      filterStatus: existing.filterStatus,
    };
  }
  if (patch._tag === "Clear" || patch._tag === "Preserve") {
    return { filterPattern: null, filterStatus: "valid" };
  }
  const compiled = compileFilter(patch.pattern);
  return {
    filterPattern: Either.isRight(compiled) ? compiled.right.pattern : patch.pattern,
    filterStatus: Either.isRight(compiled) ? "valid" : "invalid",
  };
};

/** 查找或创建稳定 X 用户账号，并刷新资料与远端 key 归属。 */
export const saveAccount = async (
  database: XWatcherDatabase,
  input: SaveSubscriptionInput,
): Promise<AccountRow> => {
  const rows = await database.get(
    "x_watcher_account",
    { xUserId: input.user.id },
    { limit: 1 },
  );
  const existing = rows[0];
  if (existing === undefined) {
    return database.create("x_watcher_account", {
      xUserId: input.user.id,
      handle: input.user.handle,
      displayName: input.user.displayName,
      cursor: input.baselineId,
      status: input.baselineKnown ? "ready" : "initializing",
      lastError: null,
      remoteMonitoring: input.remoteMonitoring,
      remoteKeyFingerprint: input.remoteKeyFingerprint,
      orphanedRemoteIds: [],
      remoteId: null,
      remoteStatus: "inactive",
      reconcileAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
  const configurationChanged =
    existing.remoteMonitoring !== input.remoteMonitoring ||
    existing.remoteKeyFingerprint !== input.remoteKeyFingerprint;
  const current = configurationChanged && existing.remoteId !== null
    ? await appendRemoteOrphan(
        database,
        existing,
        existing.remoteId,
        existing.remoteKeyFingerprint,
        input.now,
      )
    : existing;
  const initializes = current.status !== "ready" && input.baselineKnown;
  const updated: AccountRow = {
    ...current,
    handle: input.user.handle,
    displayName: input.user.displayName,
    cursor: initializes ? input.baselineId : current.cursor,
    status: initializes ? "ready" : current.status,
    lastError: initializes && current.orphanedRemoteIds.length === 0
      ? null
      : current.lastError,
    remoteMonitoring: input.remoteMonitoring,
    remoteKeyFingerprint: input.remoteKeyFingerprint,
    remoteId: configurationChanged ? null : current.remoteId,
    remoteStatus: configurationChanged
      ? current.orphanedRemoteIds.length === 0
        ? "inactive"
        : "orphaned-manual-cleanup"
      : current.remoteStatus,
    reconcileAt: configurationChanged ? null : current.reconcileAt,
    updatedAt: input.now,
  };
  await database.set("x_watcher_account", { id: existing.id }, {
    handle: updated.handle,
    displayName: updated.displayName,
    cursor: updated.cursor,
    status: updated.status,
    lastError: updated.lastError,
    remoteMonitoring: updated.remoteMonitoring,
    remoteKeyFingerprint: updated.remoteKeyFingerprint,
    orphanedRemoteIds: updated.orphanedRemoteIds,
    remoteId: updated.remoteId,
    remoteStatus: updated.remoteStatus,
    reconcileAt: updated.reconcileAt,
    updatedAt: updated.updatedAt,
  });
  return updated;
};
