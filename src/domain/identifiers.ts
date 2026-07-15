import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

/** X/Twitter Snowflake 字符串的公共校验规则。 */
const SnowflakeSchema = Schema.String.pipe(
  Schema.pattern(/^\d+$/),
  Schema.minLength(1),
);

/** 稳定的 X/Twitter 用户 ID Schema。 */
export const XUserIdSchema = SnowflakeSchema.pipe(Schema.brand("XUserId"));

/** 稳定的 X/Twitter 用户 ID。 */
export type XUserId = typeof XUserIdSchema.Type;

/** X/Twitter 动态 ID Schema。 */
export const ActivityIdSchema = SnowflakeSchema.pipe(
  Schema.brand("ActivityId"),
);

/** X/Twitter 动态 ID。 */
export type ActivityId = typeof ActivityIdSchema.Type;

/** 规范化 X/Twitter 用户名 Schema。 */
export const XHandleSchema = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9_]{1,15}$/),
  Schema.brand("XHandle"),
);

/** 规范化 X/Twitter 用户名。 */
export type XHandle = typeof XHandleSchema.Type;

/** 非空 Koishi 平台名 Schema。 */
export const PlatformSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("Platform"),
);

/** Koishi 平台名。 */
export type Platform = typeof PlatformSchema.Type;

/** 非空 Koishi 频道 ID Schema。 */
export const ChannelIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("ChannelId"),
);

/** Koishi 频道 ID。 */
export type ChannelId = typeof ChannelIdSchema.Type;

/** 非空 Koishi 群组 ID Schema。 */
export const GuildIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("GuildId"),
);

/** Koishi 群组 ID。 */
export type GuildId = typeof GuildIdSchema.Type;

/** 非空 Koishi 用户 ID Schema。 */
export const KoishiUserIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("KoishiUserId"),
);

/** Koishi 用户 ID。 */
export type KoishiUserId = typeof KoishiUserIdSchema.Type;

/** 非空 Koishi 机器人 ID Schema。 */
export const BotIdSchema = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand("BotId"),
);

/** Koishi 机器人 ID。 */
export type BotId = typeof BotIdSchema.Type;

/** 将外部值解析为稳定 X 用户 ID。 */
export const parseXUserId = Schema.decodeUnknownEither(XUserIdSchema);

/** 将外部值解析为动态 ID。 */
export const parseActivityId = Schema.decodeUnknownEither(ActivityIdSchema);

/** 将输入用户名去除 @ 并转成小写后解析。 */
export const parseXHandle = (input: string) =>
  Schema.decodeUnknownEither(XHandleSchema)(input.trim().replace(/^@/, "").toLowerCase());

/** 将外部值解析为 Koishi 平台名。 */
export const parsePlatform = Schema.decodeUnknownEither(PlatformSchema);

/** 将外部值解析为 Koishi 频道 ID。 */
export const parseChannelId = Schema.decodeUnknownEither(ChannelIdSchema);

/** 将外部值解析为 Koishi 群组 ID。 */
export const parseGuildId = Schema.decodeUnknownEither(GuildIdSchema);

/** 将外部值解析为 Koishi 用户 ID。 */
export const parseKoishiUserId = Schema.decodeUnknownEither(KoishiUserIdSchema);

/** 将外部值解析为 Koishi 机器人 ID。 */
export const parseBotId = Schema.decodeUnknownEither(BotIdSchema);

/** 比较两个合法 Snowflake ID 的时间顺序。 */
export const compareActivityId = (left: ActivityId, right: ActivityId): number => {
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
};

/** 判断候选动态是否位于给定水位之后。 */
export const isActivityAfter = (
  candidate: ActivityId,
  cursor: ActivityId,
): boolean => compareActivityId(candidate, cursor) > 0;

/** 从外部字符串数组中解析全部动态 ID。 */
export const parseActivityIds = (
  inputs: ReadonlyArray<string>,
): Either.Either<ReadonlyArray<ActivityId>, string> => {
  const values: Array<ActivityId> = [];
  for (const input of inputs) {
    const decoded = parseActivityId(input);
    if (Either.isLeft(decoded)) return Either.left(String(decoded.left));
    values.push(decoded.right);
  }
  return Either.right(values);
};
