import type { Context } from "koishi";
import type {
  ChannelId,
  Platform,
  XHandle,
  XUserId,
} from "../../domain/identifiers";
import type { StoredAccount, StoredSubscription } from "../../ports/storage";
import { runDatabase } from "./database-effect";
import { toStoredAccount, toStoredSubscription } from "./mapping";

/** 按频道与规范化用户名查找单条订阅。 */
export const findSubscription = (
  ctx: Context,
  platform: Platform,
  channelId: ChannelId,
  handle: XHandle,
) =>
  runDatabase("findSubscription", async (): Promise<StoredSubscription | null> => {
    const accounts = await ctx.database.get(
      "x_watcher_account",
      { handle },
      { limit: 1 },
    );
    const account = accounts[0];
    if (account === undefined) return null;
    const rows = await ctx.database.get(
      "x_watcher_subscription",
      { platform, channelId, accountId: account.id },
      { limit: 1 },
    );
    const row = rows[0];
    return row === undefined ? null : toStoredSubscription(row, account);
  });

/** 按频道与稳定 X 用户 ID 查找订阅，避免用户名变更绕过鉴权。 */
export const findSubscriptionByUserId = (
  ctx: Context,
  platform: Platform,
  channelId: ChannelId,
  xUserId: XUserId,
) =>
  runDatabase(
    "findSubscriptionByUserId",
    async (): Promise<StoredSubscription | null> => {
      const accounts = await ctx.database.get(
        "x_watcher_account",
        { xUserId },
        { limit: 1 },
      );
      const account = accounts[0];
      if (account === undefined) return null;
      const rows = await ctx.database.get(
        "x_watcher_subscription",
        { platform, channelId, accountId: account.id },
        { limit: 1 },
      );
      const row = rows[0];
      return row === undefined ? null : toStoredSubscription(row, account);
    },
  );

/** 列出频道内的有效订阅或完整历史订阅。 */
export const listSubscriptions = (
  ctx: Context,
  platform: Platform,
  channelId: ChannelId,
  includeInactive: boolean,
) =>
  runDatabase("listSubscriptions", async (): Promise<ReadonlyArray<StoredSubscription>> => {
    const rows = await ctx.database.get(
      "x_watcher_subscription",
      includeInactive ? { platform, channelId } : { platform, channelId, active: true },
      { sort: { id: "asc" } },
    );
    const output: Array<StoredSubscription> = [];
    for (const row of rows) {
      const accounts = await ctx.database.get(
        "x_watcher_account",
        { id: row.accountId },
        { limit: 1 },
      );
      const account = accounts[0];
      if (account !== undefined) output.push(toStoredSubscription(row, account));
    }
    return output;
  });

/** 列出至少仍有一个有效订阅的唯一账号。 */
export const listActiveAccounts = (ctx: Context) =>
  runDatabase("listActiveAccounts", async (): Promise<ReadonlyArray<StoredAccount>> => {
    const subscriptions = await ctx.database.get("x_watcher_subscription", {
      active: true,
    });
    const ids = Array.from(new Set(subscriptions.map((row) => row.accountId)));
    if (ids.length === 0) return [];
    const accounts = await ctx.database.get(
      "x_watcher_account",
      { id: ids },
      { sort: { id: "asc" } },
    );
    return accounts.map(toStoredAccount);
  });
