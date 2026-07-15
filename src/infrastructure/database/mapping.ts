import * as Option from "effect/Option";
import type {
  ClaimedControl,
  ClaimedDelivery,
  StoredAccount,
  StoredRawEvent,
  StoredSubscription,
} from "../../ports/storage";
import type { RawRealtimeEvent } from "../../ports/source";
import type { AccountRow, SubscriptionRow } from "./rows-domain";
import type { ControlRow, DeliveryRow, RawEventRow } from "./rows-queue";
import { visibleAccountError, visibleRemoteStatus } from "./remote-orphan";

/** 将账号数据库行映射为端口实体。 */
export const toStoredAccount = (row: AccountRow): StoredAccount => ({
  id: row.id,
  xUserId: row.xUserId,
  handle: row.handle,
  displayName: row.displayName,
  cursor: row.cursor,
  status: row.status,
  lastError: visibleAccountError(row),
  recoveryDueAt: row.reconcileAt,
});

/** 将订阅与账号数据库行组合为端口实体。 */
export const toStoredSubscription = (
  row: SubscriptionRow,
  account: AccountRow,
): StoredSubscription => ({
  id: row.id,
  accountId: row.accountId,
  platform: row.platform,
  channelId: row.channelId,
  guildId: row.guildId,
  isDirect: row.isDirect,
  creatorId: row.creatorId,
  botId: row.botId,
  kinds: [...row.kinds],
  filterPattern: row.filterPattern,
  filterStatus: row.filterStatus,
  includeMedia: row.includeMedia,
  active: row.active,
  cursor: row.cursor,
  account: toStoredAccount(account),
  remoteStatus: visibleRemoteStatus(account),
});

/** 从原始事件数据库行恢复数据源 DTO。 */
export const toRawRealtimeEvent = (row: RawEventRow): RawRealtimeEvent => ({
  provider: row.provider,
  eventKey: row.eventKey,
  accountId: Option.fromNullable(row.accountXUserId),
  activityId: Option.fromNullable(row.activityId),
  reduced: row.reduced,
  payloadJson: row.payloadJson,
  receivedAtEpochMillis: row.receivedAt.getTime(),
});

/** 将可领取原始事件行映射为端口任务。 */
export const toStoredRawEvent = (
  row: RawEventRow,
  accountId: number | null,
  claimToken: string,
): StoredRawEvent => ({
  id: row.id,
  claimToken,
  accountId,
  event: toRawRealtimeEvent(row),
  attempts: row.attempts,
});

/** 将投递行与订阅目标映射为端口任务。 */
export const toClaimedDelivery = (
  row: DeliveryRow,
  subscription: SubscriptionRow,
  claimToken: string,
): ClaimedDelivery => ({
  id: row.id,
  claimToken,
  subscriptionId: row.subscriptionId,
  target: {
    platform: subscription.platform,
    channelId: subscription.channelId,
    guildId: subscription.guildId,
    botId: subscription.botId,
    isDirect: subscription.isDirect,
  },
  plan: row.plan,
  stage: row.stage,
  partIndex: row.partIndex,
  attempts: row.attempts,
});

/** 将控制行与账号资料映射为端口任务。 */
export const toClaimedControl = (
  row: ControlRow,
  account: AccountRow,
  claimToken: string,
): ClaimedControl => ({
  id: row.id,
  claimToken,
  accountId: row.accountId,
  operation: row.operation,
  handle: account.handle,
  remoteId: row.remoteId,
  attempts: row.attempts,
});
