import * as Layer from "effect/Layer";
import type { Context } from "koishi";
import { XWatcherStore, type XWatcherStoreService } from "../../ports/storage";
import { claimControl } from "./control-claim";
import { coordinateControlAdd } from "./control-coordination";
import { completeControl, retryControl } from "./controls";
import {
  claimDelivery,
  completeDelivery,
  updateDeliveryProgress,
} from "./deliveries";
import { cleanupTerminalRecords } from "./maintenance";
import { migrateDatabase } from "./migration";
import {
  claimRawEvent,
  completeRawEvent,
  persistRawEvent,
  retryRawEvent,
} from "./raw-events";
import { commitRecovery, initializeAccount } from "./recovery";
import { configureRemoteMonitoring } from "./remote-configuration";
import {
  findSubscription,
  findSubscriptionByUserId,
  listActiveAccounts,
  listSubscriptions,
} from "./subscription-read";
import { disableSubscription, saveSubscription } from "./subscription-write";

/** 创建绑定当前 Koishi Context 的持久化服务实现。 */
export const makeXWatcherStoreService = (ctx: Context): XWatcherStoreService => ({
  /** 创建新表并幂等迁移旧订阅。 */
  migrate: () => migrateDatabase(ctx),
  /** 将全局远端模式与 key 指纹同步到全部账号。 */
  configureRemoteMonitoring: (enabled, fingerprint, now) =>
    configureRemoteMonitoring(ctx, enabled, fingerprint, now),
  /** 按频道与用户名读取订阅。 */
  findSubscription: (platform, channelId, handle) =>
    findSubscription(ctx, platform, channelId, handle),
  /** 按频道与稳定 X 用户 ID 读取订阅。 */
  findSubscriptionByUserId: (platform, channelId, userId) =>
    findSubscriptionByUserId(ctx, platform, channelId, userId),
  /** 新建、启用或更新订阅。 */
  saveSubscription: (input) => saveSubscription(ctx, input),
  /** 软停用订阅。 */
  disableSubscription: (subscriptionId, now) =>
    disableSubscription(ctx, subscriptionId, now),
  /** 列出频道订阅。 */
  listSubscriptions: (platform, channelId, includeInactive) =>
    listSubscriptions(ctx, platform, channelId, includeInactive),
  /** 列出有效账号。 */
  listActiveAccounts: () => listActiveAccounts(ctx),
  /** 建立账号无历史基线。 */
  initializeAccount: (accountId, latestId, consumeRecoveryDue, now) =>
    initializeAccount(ctx, accountId, latestId, consumeRecoveryDue, now),
  /** 原子提交恢复结果。 */
  commitRecovery: (input) => commitRecovery(ctx, input),
  /** 幂等持久化原始事件。 */
  persistRawEvent: (event) => persistRawEvent(ctx, event),
  /** 领取原始事件。 */
  claimRawEvent: (now) => claimRawEvent(ctx, now),
  /** 路由并完成原始事件。 */
  completeRawEvent: (rawEventId, claimToken, activity, now) =>
    completeRawEvent(ctx, rawEventId, claimToken, activity, now),
  /** 延后原始事件。 */
  retryRawEvent: (rawEventId, claimToken, availableAt, message) =>
    retryRawEvent(ctx, rawEventId, claimToken, availableAt, message),
  /** 按订阅顺序领取投递。 */
  claimDelivery: (now, leaseUntil) => claimDelivery(ctx, now, leaseUntil),
  /** 完成投递。 */
  completeDelivery: (deliveryId, claimToken, now) =>
    completeDelivery(ctx, deliveryId, claimToken, now),
  /** 保存投递降级进度。 */
  updateDeliveryProgress: (
    deliveryId,
    claimToken,
    stage,
    partIndex,
    availableAt,
    message,
  ) => updateDeliveryProgress(
    ctx,
    deliveryId,
    claimToken,
    stage,
    partIndex,
    availableAt,
    message,
  ),
  /** 领取远端控制任务。 */
  claimControl: (now, leaseUntil) => claimControl(ctx, now, leaseUntil),
  /** 完成远端控制任务。 */
  completeControl: (controlId, claimToken, remoteId, reconcileAt, now) =>
    completeControl(ctx, controlId, claimToken, remoteId, reconcileAt, now),
  /** 延后远端控制任务。 */
  retryControl: (controlId, claimToken, availableAt, message) =>
    retryControl(ctx, controlId, claimToken, availableAt, message),
  /** 终结远端 add 归属歧义。 */
  coordinateControlAdd: (
    controlId,
    claimToken,
    candidateRemoteIds,
    message,
    now,
  ) => coordinateControlAdd(
    ctx,
    controlId,
    claimToken,
    candidateRemoteIds,
    message,
    now,
  ),
  /** 清理七天前终态审计。 */
  cleanupTerminalRecords: (before) => cleanupTerminalRecords(ctx, before),
});

/** 提供绑定 Koishi 数据库的 XWatcherStore Layer。 */
export const XWatcherStoreLive = (ctx: Context) =>
  Layer.succeed(XWatcherStore, makeXWatcherStoreService(ctx));
