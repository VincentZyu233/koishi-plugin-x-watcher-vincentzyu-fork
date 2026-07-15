import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Context } from "koishi";
import type { XActivity } from "../../../domain/activity";
import { effectFromEither } from "../../../domain/effect";
import { DecodeError, type SourceError } from "../../../domain/errors";
import type { RawRealtimeEvent } from "../../../ports/source";
import { decodeTwitterApi } from "./decoder";
import { requestTwitterApiJson } from "./http-client";
import { mapTwitterTweet } from "./mapper";
import { TweetDetailsResponseSchema, TwitterTweetSchema } from "./schema";

/** 解开 Tweet Details 的多种数组包装。 */
const unwrapDetailsResponse = (
  response: typeof TweetDetailsResponseSchema.Type,
): ReadonlyArray<typeof TwitterTweetSchema.Type> => {
  if ("tweets" in response) return response.tweets;
  if ("data" in response) return response.data;
  return response;
};

/** 将持久化的实时事件 JSON 解码为未知输入。 */
const parseEventJson = (event: RawRealtimeEvent) =>
  Effect.try({
    /** 解析已经可靠持久化的供应商 JSON。 */
    try: () => JSON.parse(event.payloadJson),
    /** 将损坏的持久化内容转换为可重试解码错误。 */
    catch: (error) =>
      new DecodeError({ provider: "twitterapiio", message: String(error) }),
  });

/** 直接补全标准 Account Stream 事件。 */
const hydrateFullEvent = (event: RawRealtimeEvent): Effect.Effect<XActivity, DecodeError> =>
  parseEventJson(event).pipe(
    Effect.flatMap((input) => decodeTwitterApi(TwitterTweetSchema, input)),
    Effect.flatMap((tweet) => effectFromEither(mapTwitterTweet(tweet))),
  );

/** 通过 Tweet Details REST 接口补全精简 Account Stream 事件。 */
const hydrateReducedEvent = (
  ctx: Context,
  apiKey: string,
  event: RawRealtimeEvent,
): Effect.Effect<XActivity, SourceError> =>
  parseEventJson(event).pipe(
    Effect.flatMap((input) =>
      decodeTwitterApi(Schema.Struct({ id: Schema.String, type: Schema.String }), input),
    ),
    Effect.flatMap((fast) =>
      requestTwitterApiJson(ctx, apiKey, "GET", "/twitter/tweets", {
        params: { tweet_ids: fast.id },
      }).pipe(
        Effect.flatMap((input) => decodeTwitterApi(TweetDetailsResponseSchema, input)),
        Effect.flatMap((response) => {
          const tweet = unwrapDetailsResponse(response).find((item) => item.id === fast.id);
          return tweet === undefined
            ? Effect.fail(
                new DecodeError({
                  provider: "twitterapiio",
                  message: "补全接口未返回目标推文",
                }),
              )
            : effectFromEither(mapTwitterTweet(tweet, fast.type));
        }),
      ),
    ),
  );

/** 创建 TwitterAPI.io 实时事件补全能力。 */
export const makeTwitterApiHydrate = (ctx: Context, apiKey: string) => (
  event: RawRealtimeEvent,
): Effect.Effect<XActivity, SourceError> =>
  event.reduced ? hydrateReducedEvent(ctx, apiKey, event) : hydrateFullEvent(event);
