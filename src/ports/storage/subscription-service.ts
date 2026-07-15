import type * as Effect from "effect/Effect";
import type { ActivityId } from "../../domain/identifiers";
import type {
  ChannelId,
  Platform,
  XHandle,
  XUserId,
} from "../../domain/identifiers";
import type { PersistenceError } from "../../domain/errors";
import type {
  CommitRecoveryInput,
  SaveSubscriptionInput,
  StoredAccount,
  StoredSubscription,
} from "./models";

/** 订阅、账号与恢复流程所需的持久化能力。 */
export interface XWatcherSubscriptionStoreService {
  /** 创建新表并无损迁移旧 x_watcher 数据。 */
  readonly migrate: () => Effect.Effect<void, PersistenceError>;

  /** 将全局实时模式与 key 指纹应用到既有账号并显式记录远端孤儿。 */
  readonly configureRemoteMonitoring: (
    enabled: boolean,
    fingerprint: string | null,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 按当前频道及用户名查找订阅。 */
  readonly findSubscription: (
    platform: Platform,
    channelId: ChannelId,
    handle: XHandle,
  ) => Effect.Effect<StoredSubscription | null, PersistenceError>;

  /** 按当前频道及稳定 X 用户 ID 查找订阅。 */
  readonly findSubscriptionByUserId: (
    platform: Platform,
    channelId: ChannelId,
    userId: XUserId,
  ) => Effect.Effect<StoredSubscription | null, PersistenceError>;

  /** 新建、重新启用或局部更新订阅。 */
  readonly saveSubscription: (
    input: SaveSubscriptionInput,
  ) => Effect.Effect<StoredSubscription, PersistenceError>;

  /** 软停用订阅并取消未开始的投递任务。 */
  readonly disableSubscription: (
    subscriptionId: number,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 列出当前频道的订阅。 */
  readonly listSubscriptions: (
    platform: Platform,
    channelId: ChannelId,
    includeInactive: boolean,
  ) => Effect.Effect<ReadonlyArray<StoredSubscription>, PersistenceError>;

  /** 列出至少拥有一个有效订阅的账号。 */
  readonly listActiveAccounts: () => Effect.Effect<
    ReadonlyArray<StoredAccount>,
    PersistenceError
  >;

  /** 为新建、恢复或旧迁移订阅建立无历史基线。 */
  readonly initializeAccount: (
    accountId: number,
    latestId: ActivityId | null,
    consumeRecoveryDue: boolean,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 原子提交恢复结果、投递任务和新水位。 */
  readonly commitRecovery: (
    input: CommitRecoveryInput,
  ) => Effect.Effect<void, PersistenceError>;
}
