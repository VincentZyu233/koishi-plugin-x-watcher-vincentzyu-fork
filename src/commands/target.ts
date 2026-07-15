import * as Either from "effect/Either";
import type { Session } from "koishi";
import type { CommandTarget } from "../application/subscription";
import {
  parseBotId,
  parseChannelId,
  parseGuildId,
  parseKoishiUserId,
  parsePlatform,
} from "../domain/identifiers";

/** 从 Koishi Session 构造品牌化命令目标。 */
export const parseCommandTarget = (
  session: Session,
): Either.Either<CommandTarget, string> => {
  if (session.channelId === undefined || session.userId === undefined) {
    return Either.left("当前会话缺少频道或用户标识，无法管理订阅");
  }
  const platform = parsePlatform(session.platform);
  const channelId = parseChannelId(session.channelId);
  const actorId = parseKoishiUserId(session.userId);
  const botId = parseBotId(session.selfId);
  const guildId = session.guildId === undefined ? null : parseGuildId(session.guildId);
  if (
    Either.isLeft(platform) ||
    Either.isLeft(channelId) ||
    Either.isLeft(actorId) ||
    Either.isLeft(botId) ||
    (guildId !== null && Either.isLeft(guildId))
  ) {
    return Either.left("当前会话标识格式无效，无法管理订阅");
  }
  return Either.right({
    platform: platform.right,
    channelId: channelId.right,
    guildId: guildId === null ? null : guildId.right,
    actorId: actorId.right,
    botId: botId.right,
    isDirect: session.isDirect,
  });
};
