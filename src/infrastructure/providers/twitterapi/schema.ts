import * as Schema from "effect/Schema";
import { TwitterMediaSchema } from "./media-schema";

export { TwitterMediaSchema } from "./media-schema";

/** TwitterAPI.io 宽松用户结构。 */
export const TwitterUserSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  userName: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
});

/** TwitterAPI.io URL 实体结构。 */
const UrlEntitySchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    url: Schema.optional(Schema.String),
    expanded_url: Schema.optional(Schema.String),
    expandedUrl: Schema.optional(Schema.String),
  }),
);

/** 不递归的引用推文结构。 */
const ReferencedTweetSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  fullText: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  author: Schema.optional(TwitterUserSchema),
  entities: Schema.optional(
    Schema.Struct({ urls: Schema.optional(Schema.Array(UrlEntitySchema)) }),
  ),
  media: Schema.optional(Schema.Array(TwitterMediaSchema)),
  extendedEntities: Schema.optional(
    Schema.Struct({ media: Schema.optional(Schema.Array(TwitterMediaSchema)) }),
  ),
});

/** TwitterAPI.io 宽松推文结构。 */
export const TwitterTweetSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  fullText: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  author: Schema.optional(TwitterUserSchema),
  isReply: Schema.optional(Schema.Boolean),
  inReplyToId: Schema.optional(Schema.NullOr(Schema.String)),
  quoted_tweet: Schema.optional(Schema.NullOr(ReferencedTweetSchema)),
  retweeted_tweet: Schema.optional(Schema.NullOr(ReferencedTweetSchema)),
  entities: Schema.optional(
    Schema.Struct({ urls: Schema.optional(Schema.Array(UrlEntitySchema)) }),
  ),
  media: Schema.optional(Schema.Array(TwitterMediaSchema)),
  extendedEntities: Schema.optional(
    Schema.Struct({ media: Schema.optional(Schema.Array(TwitterMediaSchema)) }),
  ),
});

/** TwitterAPI.io 用户资料响应。 */
export const UserResponseSchema = Schema.Union(
  TwitterUserSchema,
  Schema.Struct({
    status: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    data: TwitterUserSchema,
  }),
);

/** TwitterAPI.io 最近推文响应。 */
const LastTweetsBodySchema = Schema.Struct({
  tweets: Schema.Array(Schema.Unknown),
  has_next_page: Schema.optional(Schema.Boolean),
  next_cursor: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

/** 兼容顶层与 data 包裹的最近推文响应。 */
export const LastTweetsResponseSchema = Schema.Union(
  LastTweetsBodySchema,
  Schema.Struct({ data: LastTweetsBodySchema }),
);

/** TwitterAPI.io Tweet Details 响应。 */
export const TweetDetailsResponseSchema = Schema.Union(
  Schema.Struct({ tweets: Schema.Array(TwitterTweetSchema) }),
  Schema.Struct({ data: Schema.Array(TwitterTweetSchema) }),
  Schema.Array(TwitterTweetSchema),
);

/** Account Stream 操作响应。 */
export const MonitorOperationResponseSchema = Schema.Struct({
  status: Schema.Literal("success", "error"),
  msg: Schema.String,
});

/** Account Stream 远端条目。 */
export const MonitorEntrySchema = Schema.Struct({
  id_for_user: Schema.optional(Schema.String),
  x_user_id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  x_user_name: Schema.optional(Schema.String),
  x_user_screen_name: Schema.optional(Schema.String),
});

/** Account Stream 列表响应。 */
export const MonitorListResponseSchema = Schema.Struct({
  status: Schema.Literal("success", "error"),
  msg: Schema.String,
  data: Schema.Array(MonitorEntrySchema),
});

/** Account Stream fast_tweet 结构。 */
const FastTweetSchema = Schema.Struct({
  id: Schema.String,
  screen_name: Schema.String,
  text: Schema.String,
  type: Schema.String,
  created_ms: Schema.Number,
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  user_id: Schema.optional(Schema.String),
});

/** Account Stream 支持的实时 envelope。 */
export const RealtimeEnvelopeSchema = Schema.Union(
  Schema.Struct({
    event_type: Schema.Literal("fast_tweet"),
    timestamp: Schema.Number,
    tweet: FastTweetSchema,
  }),
  Schema.Struct({
    event_type: Schema.Literal("tweet"),
    timestamp: Schema.Number,
    tweets: Schema.Array(Schema.Unknown),
  }),
  Schema.Struct({
    event_type: Schema.Literal("connected", "ping"),
    timestamp: Schema.Number,
  }),
);

/** 已解码 TwitterAPI.io 推文类型。 */
export type TwitterTweet = typeof TwitterTweetSchema.Type;

/** 已解码 TwitterAPI.io 用户类型。 */
export type TwitterUser = typeof TwitterUserSchema.Type;

/** 已解码 TwitterAPI.io 实时 envelope 类型。 */
export type RealtimeEnvelope = typeof RealtimeEnvelopeSchema.Type;
