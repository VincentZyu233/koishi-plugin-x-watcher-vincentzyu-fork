import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ActivityKind } from "../../domain/activity";
import type {
  AuthorizationError,
  ConfigurationError,
  PersistenceError,
  SourceError,
} from "../../domain/errors";
import type {
  BotId,
  ChannelId,
  GuildId,
  KoishiUserId,
  Platform,
  XHandle,
} from "../../domain/identifiers";
import type { FilterPatch, StoredSubscription } from "../../ports/storage";

/** 命令所在的 Koishi 会话目标。 */
export interface CommandTarget {
  readonly platform: Platform;
  readonly channelId: ChannelId;
  readonly guildId: GuildId | null;
  readonly actorId: KoishiUserId;
  readonly botId: BotId;
  readonly isDirect: boolean;
}

/** watch 命令传入的局部补丁。 */
export interface WatchRequest {
  readonly target: CommandTarget;
  readonly handle: XHandle;
  readonly kinds: ReadonlyArray<ActivityKind> | null;
  readonly filter: FilterPatch;
  readonly includeMedia: boolean | null;
}

/** watch 命令执行结果。 */
export interface WatchResult {
  readonly outcome: "created" | "reactivated" | "updated";
  readonly subscription: StoredSubscription;
  readonly baselinePending: boolean;
}

/** unwatch 命令执行结果。 */
export type UnwatchResult =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "AlreadyInactive"; readonly subscription: StoredSubscription }
  | { readonly _tag: "Disabled"; readonly subscription: StoredSubscription };

/** 应用层命令可能返回的已建模错误。 */
export type SubscriptionApplicationError =
  | SourceError
  | PersistenceError
  | AuthorizationError
  | ConfigurationError;

/** 订阅应用层的运行设置。 */
export interface SubscriptionRuntimeSettings {
  readonly remoteMonitoring: boolean;
  readonly remoteKeyFingerprint: string | null;
}

/** 订阅应用服务能力。 */
export interface SubscriptionApplicationService {
  /** 新建、重新启用或局部更新订阅。 */
  readonly watch: (
    request: WatchRequest,
  ) => Effect.Effect<WatchResult, SubscriptionApplicationError>;

  /** 软停用当前频道内的订阅。 */
  readonly unwatch: (
    target: CommandTarget,
    handle: XHandle,
  ) => Effect.Effect<UnwatchResult, SubscriptionApplicationError>;

  /** 列出当前频道的订阅。 */
  readonly list: (
    target: CommandTarget,
    includeInactive: boolean,
  ) => Effect.Effect<ReadonlyArray<StoredSubscription>, PersistenceError>;
}

/** 订阅应用服务 Tag。 */
export class SubscriptionApplication extends Context.Tag(
  "x-watcher/SubscriptionApplication",
)<SubscriptionApplication, SubscriptionApplicationService>() {}
