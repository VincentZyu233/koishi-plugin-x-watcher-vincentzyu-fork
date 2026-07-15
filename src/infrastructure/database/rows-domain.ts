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
import type { ActivityKind } from "../../domain/activity";
import type { AccountStatus } from "../../ports/storage";

/** 账号表持久化行。 */
export interface AccountRow {
  readonly id: number;
  readonly xUserId: XUserId;
  readonly handle: XHandle;
  readonly displayName: string;
  readonly cursor: ActivityId | null;
  readonly status: AccountStatus;
  readonly lastError: string | null;
  readonly remoteMonitoring: boolean;
  readonly remoteKeyFingerprint: string | null;
  readonly orphanedRemoteIds: ReadonlyArray<string>;
  readonly remoteId: string | null;
  readonly remoteStatus: string;
  readonly reconcileAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 订阅表持久化行。 */
export interface SubscriptionRow {
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
  readonly activeSince: Date;
  readonly cursor: ActivityId | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** 动态审计表持久化行。 */
export interface ActivityRow {
  readonly id: number;
  readonly accountId: number;
  readonly activityId: ActivityId;
  readonly payloadJson: string;
  readonly createdAt: Date;
  readonly recordedAt: Date;
}

/** 旧版单表订阅持久化行。 */
export interface LegacyWatcherRow {
  readonly id: number;
  readonly platform: string;
  readonly channelId: string;
  readonly userId: string;
  readonly botId: string;
  readonly twitter_fullname: string;
  readonly twitter_username: string;
  readonly twitter_id: string;
  readonly last_tweet_id?: string | null;
  readonly filter_regexp?: string | null;
  readonly media?: boolean;
  readonly active: boolean;
  readonly create_at: Date;
  readonly update_at: Date;
}

declare module "koishi" {
  interface Tables {
    x_watcher_account: AccountRow;
    x_watcher_subscription: SubscriptionRow;
    x_watcher_activity: ActivityRow;
    x_watcher: LegacyWatcherRow;
  }
}
