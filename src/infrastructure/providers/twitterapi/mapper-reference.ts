import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { ActivityReference } from "../../../domain/activity";
import { DecodeError } from "../../../domain/errors";
import { parseActivityId, parseXHandle } from "../../../domain/identifiers";
import type { TwitterTweet } from "./schema";
import { firstNonEmptyString, mapTwitterActivityBody } from "./mapper-body";

/** 将嵌套引用或转推转换为领域引用。 */
export const mapTwitterReference = (
  tweet: TwitterTweet,
): Either.Either<Option.Option<ActivityReference>, DecodeError> => {
  const retweeted = tweet.retweeted_tweet;
  const target = retweeted === undefined || retweeted === null ? tweet.quoted_tweet : retweeted;
  if (target === undefined || target === null) return Either.right(Option.none());
  const id = parseActivityId(target.id === undefined ? "" : target.id);
  const rawAuthor = target.author;
  const rawHandle = rawAuthor === undefined
    ? ""
    : firstNonEmptyString(rawAuthor.userName, rawAuthor.username) || "";
  const handle = parseXHandle(rawHandle);
  if (Either.isLeft(id) || Either.isLeft(handle)) {
    return Either.left(
      new DecodeError({ provider: "twitterapiio", message: "引用推文核心字段无效" }),
    );
  }
  const authorName = rawAuthor === undefined
    ? handle.right
    : firstNonEmptyString(rawAuthor.name, rawAuthor.displayName) || handle.right;
  return Either.right(
    Option.some({
      kind: retweeted === undefined || retweeted === null ? "quote" : "retweet",
      activityId: id.right,
      authorHandle: handle.right,
      authorName,
      body: mapTwitterActivityBody(target),
      permalink: target.url || `https://x.com/${handle.right}/status/${id.right}`,
    }),
  );
};
