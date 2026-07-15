import type { ActivityKind, XActivity } from "../../domain/activity";
import type {
  ActivityId,
  BotId,
  ChannelId,
  GuildId,
  KoishiUserId,
  Platform,
  XHandle,
  XUserId,
} from "../../domain/identifiers";
import type { MessagePlan } from "../../domain/message";
import type {
  RawRealtimeEvent,
  RecoveryOverflowBoundary,
  ResolvedXUser,
} from "../source";

/** 持久化账号的运行状态。 */
export type AccountStatus = "initializing" | "ready" | "error";

/** 持久化的 X/Twitter 账号。 */
export interface StoredAccount {
  readonly id: number;
  readonly xUserId: XUserId;
  readonly handle: XHandle;
  readonly displayName: string;
  readonly cursor: ActivityId | null;
  readonly status: AccountStatus;
  readonly lastError: string | null;
  readonly recoveryDueAt: Date | null;
}

/** 订阅的过滤规则补丁。 */
export type FilterPatch =
  | { readonly _tag: "Preserve" }
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Set"; readonly pattern: string };

/** 新建或更新订阅的完整输入。 */
export interface SaveSubscriptionInput {
  readonly platform: Platform;
  readonly channelId: ChannelId;
  readonly guildId: GuildId | null;
  readonly isDirect: boolean;
  readonly creatorId: KoishiUserId;
  readonly botId: BotId;
  readonly user: ResolvedXUser;
  readonly baselineId: ActivityId | null;
  readonly baselineKnown: boolean;
  readonly kinds: ReadonlyArray<ActivityKind> | null;
  readonly filter: FilterPatch;
  readonly includeMedia: boolean | null;
  readonly remoteMonitoring: boolean;
  readonly remoteKeyFingerprint: string | null;
  readonly now: Date;
}

/** 持久化订阅。 */
export interface StoredSubscription {
  readonly id: number;
  readonly accountId: number;
  readonly platform: Platform;
  readonly channelId: ChannelId;
  readonly guildId: GuildId | null;
  readonly isDirect: boolean;
  readonly creatorId: KoishiUserId;
  readonly botId: BotId;
  readonly kinds: ReadonlyArray<ActivityKind>;
  readonly filterPattern: string | null;
  readonly filterStatus: "valid" | "invalid";
  readonly includeMedia: boolean;
  readonly active: boolean;
  readonly cursor: ActivityId | null;
  readonly account: StoredAccount;
  readonly remoteStatus: string;
}

/** 恢复批次持久化输入。 */
export interface CommitRecoveryInput {
  readonly account: StoredAccount;
  readonly activities: ReadonlyArray<XActivity>;
  readonly newestId: ActivityId | null;
  readonly overflow: boolean;
  readonly overflowBoundary: RecoveryOverflowBoundary | null;
  readonly consumeRecoveryDue: boolean;
  readonly now: Date;
}

/** 待处理的持久化原始事件。 */
export interface StoredRawEvent {
  readonly id: number;
  readonly claimToken: string;
  readonly accountId: number | null;
  readonly event: RawRealtimeEvent;
  readonly attempts: number;
}

/** 已领取的投递任务。 */
export interface ClaimedDelivery {
  readonly id: number;
  readonly claimToken: string;
  readonly subscriptionId: number;
  readonly target: {
    readonly platform: Platform;
    readonly channelId: ChannelId;
    readonly guildId: GuildId | null;
    readonly botId: BotId;
    readonly isDirect: boolean;
  };
  readonly plan: MessagePlan;
  readonly stage: "mixed" | "split" | "link";
  readonly partIndex: number;
  readonly attempts: number;
}

/** 待执行的远端监控控制任务。 */
export interface ClaimedControl {
  readonly id: number;
  readonly claimToken: string;
  readonly accountId: number;
  readonly operation: "add" | "remove";
  readonly handle: XHandle;
  readonly remoteId: string | null;
  readonly attempts: number;
}
