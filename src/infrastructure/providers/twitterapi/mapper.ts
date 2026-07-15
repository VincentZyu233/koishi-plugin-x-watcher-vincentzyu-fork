import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { ActivityKind, XActivity } from "../../../domain/activity";
import { DecodeError } from "../../../domain/errors";
import {
  parseActivityId,
  parseXHandle,
  parseXUserId,
  type ActivityId,
} from "../../../domain/identifiers";
import { firstNonEmptyString, mapTwitterActivityBody, parseTwitterCreatedAt } from "./mapper-body";
import { mapTwitterReference } from "./mapper-reference";
import type { TwitterTweet } from "./schema";

/** 按固定优先级识别 TwitterAPI.io 动态种类。 */
const classifyTweet = (tweet: TwitterTweet, hint?: string): ActivityKind => {
  if (tweet.retweeted_tweet !== undefined && tweet.retweeted_tweet !== null) return "retweet";
  if (tweet.quoted_tweet !== undefined && tweet.quoted_tweet !== null) return "quote";
  if (tweet.isReply === true || (tweet.inReplyToId !== undefined && tweet.inReplyToId !== null)) {
    return "reply";
  }
  if (hint === "repost") return "retweet";
  if (hint === "quote") return "quote";
  if (hint === "reply" || hint === "thread") return "reply";
  return "post";
};

/** 解析可选的回复目标 Tweet ID。 */
const parseReplyToId = (
  value: string | null | undefined,
): Either.Either<Option.Option<ActivityId>, DecodeError> => {
  if (value === undefined || value === null) return Either.right(Option.none());
  const parsed = parseActivityId(value);
  return Either.isLeft(parsed)
    ? Either.left(new DecodeError({ provider: "twitterapiio", message: "回复目标 ID 无效" }))
    : Either.right(Option.some(parsed.right));
};

/** 将 TwitterAPI.io 推文严格转换为数据源无关动态。 */
export const mapTwitterTweet = (
  tweet: TwitterTweet,
  kindHint?: string,
): Either.Either<XActivity, DecodeError> => {
  const id = parseActivityId(tweet.id === undefined ? "" : tweet.id);
  const author = tweet.author;
  if (author === undefined) {
    return Either.left(
      new DecodeError({ provider: "twitterapiio", message: "推文缺少作者资料" }),
    );
  }
  const authorId = parseXUserId(author.id === undefined ? "" : author.id);
  const handle = parseXHandle(firstNonEmptyString(author.userName, author.username) || "");
  const reference = mapTwitterReference(tweet);
  const createdAt = parseTwitterCreatedAt(tweet.createdAt, tweet.id);
  if (
    Either.isLeft(id) || Either.isLeft(authorId) || Either.isLeft(handle) ||
    Either.isLeft(reference) || !Number.isFinite(createdAt)
  ) {
    return Either.left(
      new DecodeError({ provider: "twitterapiio", message: "推文核心字段无效" }),
    );
  }
  const replyToId = parseReplyToId(tweet.inReplyToId);
  if (Either.isLeft(replyToId)) return Either.left(replyToId.left);
  return Either.right({
    id: id.right,
    authorId: authorId.right,
    authorHandle: handle.right,
    authorName: firstNonEmptyString(author.name, author.displayName) || handle.right,
    kind: classifyTweet(tweet, kindHint),
    createdAtEpochMillis: createdAt,
    body: mapTwitterActivityBody(tweet),
    replyToId: replyToId.right,
    reference: reference.right,
    permalink: tweet.url || `https://x.com/${handle.right}/status/${id.right}`,
  });
};
