import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { Tweet, TweetMedia } from "rettiwt-api";
import type {
  ActivityBody,
  ActivityKind,
  ActivityReference,
  MediaKind,
  XActivity,
  XMedia,
} from "../../../domain/activity";
import { DecodeError } from "../../../domain/errors";
import {
  parseActivityId,
  parseXHandle,
  parseXUserId,
} from "../../../domain/identifiers";

/** 将 Rettiwt 媒体类型转换为领域媒体类型。 */
const mapMediaKind = (type: string): MediaKind => {
  if (type === "VIDEO") return "video";
  if (type === "GIF") return "gif";
  return "image";
};

/** 将 Rettiwt 媒体转换为领域媒体并丢弃上游空地址。 */
const mapMedia = (media: TweetMedia, order: number): XMedia | null =>
  media.url.trim().length === 0
    ? null
    : {
        kind: mapMediaKind(media.type),
        url: media.url,
        previewUrl: Option.fromNullable(media.thumbnailUrl),
        order,
      };

/** 将 Rettiwt Tweet 正文转换为领域正文。 */
const mapBody = (tweet: Tweet): ActivityBody => ({
  text: tweet.fullText,
  expandedUrls: [...tweet.entities.urls],
  media: (tweet.media === undefined ? [] : tweet.media)
    .map(mapMedia)
    .filter((media): media is XMedia => media !== null)
    .map((media, order) => ({ ...media, order })),
});

/** 按稳定优先级识别 Rettiwt 动态种类。 */
const classifyTweet = (tweet: Tweet): ActivityKind => {
  if (tweet.retweetedTweet !== undefined) return "retweet";
  if (tweet.quoted !== undefined) return "quote";
  if (tweet.replyTo !== undefined) return "reply";
  return "post";
};

/** 将 Rettiwt 嵌套推文转换为引用内容。 */
const mapReference = (
  tweet: Tweet,
): Either.Either<Option.Option<ActivityReference>, DecodeError> => {
  const target = tweet.retweetedTweet === undefined ? tweet.quoted : tweet.retweetedTweet;
  if (target === undefined) return Either.right(Option.none());
  const activityId = parseActivityId(target.id);
  const handle = parseXHandle(target.tweetBy.userName);
  if (Either.isLeft(activityId) || Either.isLeft(handle)) {
    return Either.left(
      new DecodeError({
        provider: "rettiwt",
        message: "嵌套推文包含无效的 ID 或用户名",
      }),
    );
  }
  return Either.right(
    Option.some({
      kind: tweet.retweetedTweet === undefined ? "quote" : "retweet",
      activityId: activityId.right,
      authorHandle: handle.right,
      authorName: target.tweetBy.fullName,
      body: mapBody(target),
      permalink: target.url || `https://x.com/${handle.right}/status/${activityId.right}`,
    }),
  );
};

/** 将 Rettiwt Tweet 严格转换为数据源无关动态。 */
export const mapRettiwtTweet = (
  tweet: Tweet,
): Either.Either<XActivity, DecodeError> => {
  const id = parseActivityId(tweet.id);
  const authorId = parseXUserId(tweet.tweetBy.id);
  const authorHandle = parseXHandle(tweet.tweetBy.userName);
  const reference = mapReference(tweet);
  const createdAtEpochMillis = Date.parse(tweet.createdAt);
  if (
    Either.isLeft(id) ||
    Either.isLeft(authorId) ||
    Either.isLeft(authorHandle) ||
    Either.isLeft(reference) ||
    !Number.isFinite(createdAtEpochMillis)
  ) {
    return Either.left(
      new DecodeError({
        provider: "rettiwt",
        message: `推文 ${tweet.id} 缺少合法的核心字段`,
      }),
    );
  }
  let replyToId: Option.Option<typeof id.right> = Option.none();
  if (tweet.replyTo !== undefined) {
    const parsedReply = parseActivityId(tweet.replyTo);
    if (Either.isLeft(parsedReply)) {
      return Either.left(
        new DecodeError({ provider: "rettiwt", message: "回复目标 ID 无效" }),
      );
    }
    replyToId = Option.some(parsedReply.right);
  }
  return Either.right({
    id: id.right,
    authorId: authorId.right,
    authorHandle: authorHandle.right,
    authorName: tweet.tweetBy.fullName,
    kind: classifyTweet(tweet),
    createdAtEpochMillis,
    body: mapBody(tweet),
    replyToId,
    reference: reference.right,
    permalink: tweet.url || `https://x.com/${authorHandle.right}/status/${id.right}`,
  });
};
