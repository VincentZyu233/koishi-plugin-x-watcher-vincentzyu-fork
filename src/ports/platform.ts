import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { DeliveryError } from "../domain/errors";
import type { MessagePlan } from "../domain/message";
import type {
  BotId,
  ChannelId,
  GuildId,
  KoishiUserId,
  Platform,
} from "../domain/identifiers";

/** 消息投递的 Koishi 目标。 */
export interface DeliveryTarget {
  readonly platform: Platform;
  readonly channelId: ChannelId;
  readonly guildId: GuildId | null;
  readonly botId: BotId;
  readonly isDirect: boolean;
}

/** 频道权限校验输入。 */
export interface AuthorizationRequest {
  readonly platform: Platform;
  readonly channelId: ChannelId;
  readonly guildId: GuildId | null;
  readonly actorId: KoishiUserId;
  readonly creatorId: KoishiUserId;
  readonly isDirect: boolean;
  readonly botId: BotId;
}

/** 频道权限服务能力。 */
export interface ChannelAuthorizationService {
  /** 判断调用者是否为创建者或可靠识别的频道管理员。 */
  readonly canManage: (
    request: AuthorizationRequest,
  ) => Effect.Effect<boolean, never>;
}

/** 频道权限服务 Tag。 */
export class ChannelAuthorization extends Context.Tag(
  "x-watcher/ChannelAuthorization",
)<ChannelAuthorization, ChannelAuthorizationService>() {}

/** Koishi 消息发送服务能力。 */
export interface MessageSenderService {
  /** 发送至多一个原子分片；返回下一分片，-1 表示计划完成。 */
  readonly send: (
    target: DeliveryTarget,
    plan: MessagePlan,
    stage: "mixed" | "split" | "link",
    partIndex: number,
  ) => Effect.Effect<number, DeliveryError>;
}

/** Koishi 消息发送服务 Tag。 */
export class MessageSender extends Context.Tag("x-watcher/MessageSender")<
  MessageSender,
  MessageSenderService
>() {}
