import * as Either from "effect/Either";
import { compileFilter } from "../../domain/filter";
import {
  parseActivityId,
  parseBotId,
  parseChannelId,
  parseKoishiUserId,
  parsePlatform,
  parseXHandle,
  parseXUserId,
  type ActivityId,
  type BotId,
  type ChannelId,
  type KoishiUserId,
  type Platform,
  type XHandle,
  type XUserId,
} from "../../domain/identifiers";
import type { LegacyWatcherRow } from "./rows-domain";

/** 通过领域构造器验证后的旧行字段。 */
export interface ParsedLegacyRow {
  readonly platform: Platform;
  readonly channelId: ChannelId;
  readonly creatorId: KoishiUserId;
  readonly botId: BotId;
  readonly xUserId: XUserId;
  readonly handle: XHandle;
  readonly cursor: ActivityId | null;
}

/** 严格解析旧表中的裸字符串标识符。 */
export const parseLegacyRow = (
  row: LegacyWatcherRow,
): Either.Either<ParsedLegacyRow, string> => {
  const platform = parsePlatform(row.platform);
  const channelId = parseChannelId(row.channelId);
  const creatorId = parseKoishiUserId(row.userId);
  const botId = parseBotId(row.botId);
  const xUserId = parseXUserId(row.twitter_id);
  const handle = parseXHandle(row.twitter_username);
  if (Either.isLeft(platform)) return Either.left(String(platform.left));
  if (Either.isLeft(channelId)) return Either.left(String(channelId.left));
  if (Either.isLeft(creatorId)) return Either.left(String(creatorId.left));
  if (Either.isLeft(botId)) return Either.left(String(botId.left));
  if (Either.isLeft(xUserId)) return Either.left(String(xUserId.left));
  if (Either.isLeft(handle)) return Either.left(String(handle.left));
  const base = {
    platform: platform.right,
    channelId: channelId.right,
    creatorId: creatorId.right,
    botId: botId.right,
    xUserId: xUserId.right,
    handle: handle.right,
  };
  if (
    row.last_tweet_id === undefined ||
    row.last_tweet_id === null ||
    row.last_tweet_id.trim().length === 0
  ) {
    return Either.right({ ...base, cursor: null });
  }
  const cursor = parseActivityId(row.last_tweet_id);
  return Either.isLeft(cursor)
    ? Either.left(String(cursor.left))
    : Either.right({ ...base, cursor: cursor.right });
};

/** 规范化旧过滤字符串并保留无效规则的可见状态。 */
export const legacyFilter = (
  pattern: string | null | undefined,
): { readonly pattern: string | null; readonly status: "valid" | "invalid" } => {
  if (pattern === undefined || pattern === null || pattern.trim().length === 0) {
    return { pattern: null, status: "valid" };
  }
  const compiled = compileFilter(pattern);
  return {
    pattern: Either.isRight(compiled) ? compiled.right.pattern : pattern,
    status: Either.isRight(compiled) ? "valid" : "invalid",
  };
};
