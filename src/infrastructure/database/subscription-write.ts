import type { Context } from "koishi";
import { DefaultActivityKinds } from "../../domain/activity";
import type {
  SaveSubscriptionInput,
  StoredSubscription,
} from "../../ports/storage";
import { reconcileControlIntent } from "./control-intent";
import { newestCursor } from "./cursor";
import { runTransaction, type XWatcherDatabase } from "./database-effect";
import { toStoredSubscription } from "./mapping";
import { resolveFilter, saveAccount } from "./subscription-values";

/** 在事务内新建、重新启用或局部更新订阅。 */
const saveSubscriptionTransaction = async (
  database: XWatcherDatabase,
  input: SaveSubscriptionInput,
): Promise<StoredSubscription> => {
  let account = await saveAccount(database, input);
  const rows = await database.get(
    "x_watcher_subscription",
    { platform: input.platform, channelId: input.channelId, accountId: account.id },
    { limit: 1 },
  );
  const existing = rows[0];
  const needsBaseline = existing === undefined || !existing.active;
  if (needsBaseline && input.baselineKnown && account.status !== "ready") {
    await database.set(
      "x_watcher_account",
      { id: account.id },
      {
        cursor: input.baselineId,
        status: "ready",
        updatedAt: input.now,
      },
    );
    await database.set(
      "x_watcher_subscription",
      { accountId: account.id, active: true },
      { cursor: input.baselineId, updatedAt: input.now },
    );
    account = {
      ...account,
      cursor: input.baselineId,
      status: "ready",
      lastError: account.lastError,
    };
  }
  if (needsBaseline && !input.baselineKnown && account.status === "ready") {
    const active = await database.get(
      "x_watcher_subscription",
      { accountId: account.id, active: true },
      { limit: 1 },
    );
    if (active.length === 0) {
      await database.set(
        "x_watcher_account",
        { id: account.id },
        { status: "initializing", updatedAt: input.now },
      );
      account = { ...account, status: "initializing" };
    }
  }
  const filter = resolveFilter(input.filter, existing);
  const cursor =
    existing !== undefined && existing.active
      ? existing.cursor
      : newestCursor(account.cursor, input.baselineId);
  const values = {
    accountId: account.id,
    platform: input.platform,
    channelId: input.channelId,
    guildId: input.guildId,
    isDirect: input.isDirect,
    creatorId: existing === undefined ? input.creatorId : existing.creatorId,
    botId: input.botId,
    kinds: input.kinds === null
      ? existing === undefined ? DefaultActivityKinds : existing.kinds
      : input.kinds,
    filterPattern: filter.filterPattern,
    filterStatus: filter.filterStatus,
    includeMedia:
      input.includeMedia === null
        ? existing === undefined ? false : existing.includeMedia
        : input.includeMedia,
    active: true,
    activeSince: existing === undefined || !existing.active
      ? input.now
      : existing.activeSince,
    cursor,
    updatedAt: input.now,
  };
  const row = existing === undefined
    ? await database.create("x_watcher_subscription", {
        ...values,
        createdAt: input.now,
      })
    : await database.set("x_watcher_subscription", { id: existing.id }, values).then(
        async () => {
          const updated = await database.get(
            "x_watcher_subscription",
            { id: existing.id },
            { limit: 1 },
          );
          return updated[0] === undefined ? existing : updated[0];
        },
      );
  await reconcileControlIntent(database, account.id, input.now);
  const accounts = await database.get("x_watcher_account", { id: account.id }, {
    limit: 1,
  });
  return toStoredSubscription(row, accounts[0] === undefined ? account : accounts[0]);
};

/** 新建、重新启用或局部更新订阅并同步控制 outbox。 */
export const saveSubscription = (ctx: Context, input: SaveSubscriptionInput) =>
  runTransaction(ctx, "saveSubscription", (database) =>
    saveSubscriptionTransaction(database, input),
  );

/** 软停用订阅、作废当前代际的全部未终态投递并同步控制 outbox。 */
export const disableSubscription = (
  ctx: Context,
  subscriptionId: number,
  now: Date,
) =>
  runTransaction(ctx, "disableSubscription", async (database) => {
    const rows = await database.get(
      "x_watcher_subscription",
      { id: subscriptionId },
      { limit: 1 },
    );
    const row = rows[0];
    if (row === undefined) return;
    await database.set(
      "x_watcher_subscription",
      { id: subscriptionId },
      { active: false, updatedAt: now },
    );
    await database.set(
      "x_watcher_delivery",
      {
        subscriptionId,
        $or: [{ status: "pending" }, { status: "processing" }],
      },
      {
        status: "cancelled",
        completedAt: now,
        leaseUntil: null,
        claimToken: null,
      },
    );
    await reconcileControlIntent(database, row.accountId, now);
  });
