import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { DecodeError } from "../../../domain/errors";
import { parseActivityId, parseXUserId } from "../../../domain/identifiers";
import type { RawRealtimeEvent } from "../../../ports/source";
import { RealtimeEnvelopeSchema, type RealtimeEnvelope } from "./schema";
import {
  decodeTwitterTweetBatch,
  type DecodedTwitterTweet,
} from "./tweet-batch";

/** Account Stream 中允许进入动态管道的精简事件类型。 */
const SUPPORTED_FAST_TYPES: ReadonlySet<string> = new Set([
  "post",
  "tweet",
  "reply",
  "thread",
  "quote",
  "repost",
  "retweet",
]);

/** 将供应商可能使用的秒或毫秒时间戳统一为 epoch 毫秒。 */
const normalizeEpochMillis = (value: number): number =>
  value < 10_000_000_000 ? value * 1_000 : value;

/** 判断未知 event_type 是否应作为不受支持动态静默忽略。 */
const isUnsupportedEnvelope = (input: unknown): boolean => {
  if (typeof input !== "object" || input === null || !("event_type" in input)) {
    return false;
  }
  const eventType = input.event_type;
  return typeof eventType === "string" &&
    eventType !== "fast_tweet" &&
    eventType !== "tweet" &&
    eventType !== "connected" &&
    eventType !== "ping";
};

/** 将外部 JSON 值安全序列化为持久化字符串。 */
const stringifyPayload = (input: object): Either.Either<string, DecodeError> => {
  try {
    return Either.right(JSON.stringify(input));
  } catch (error) {
    return Either.left(
      new DecodeError({ provider: "twitterapiio", message: String(error) }),
    );
  }
};

/** 将单条标准推文转换为原始实时事件。 */
const mapStandardTweet = (
  decoded: DecodedTwitterTweet,
  timestamp: number,
): Either.Either<RawRealtimeEvent, DecodeError> => {
  const serialized = stringifyPayload(decoded.tweet);
  if (Either.isLeft(serialized)) return Either.left(serialized.left);
  return Either.right({
    provider: "twitterapiio",
    eventKey: `activity:${decoded.activity.id}`,
    accountId: Option.some(decoded.activity.authorId),
    activityId: Option.some(decoded.activity.id),
    reduced: false,
    payloadJson: serialized.right,
    receivedAtEpochMillis: normalizeEpochMillis(timestamp),
  });
};

/** 将已解码实时 envelope 展开为可持久化原始事件。 */
const mapEnvelope = (
  envelope: RealtimeEnvelope,
): Effect.Effect<ReadonlyArray<RawRealtimeEvent>, DecodeError> => {
  if (envelope.event_type === "connected" || envelope.event_type === "ping") {
    return Effect.succeed([]);
  }
  if (envelope.event_type === "fast_tweet") {
    if (!SUPPORTED_FAST_TYPES.has(envelope.tweet.type.toLowerCase())) {
      return Effect.succeed([]);
    }
    const id = parseActivityId(envelope.tweet.id);
    const payload = stringifyPayload(envelope.tweet);
    if (Either.isLeft(id) || Either.isLeft(payload)) {
      return Effect.fail(
        new DecodeError({ provider: "twitterapiio", message: "精简实时事件字段无效" }),
      );
    }
    const parsedUserId = envelope.tweet.user_id === undefined
      ? null
      : parseXUserId(envelope.tweet.user_id);
    const userId = parsedUserId !== null && Either.isRight(parsedUserId)
      ? Option.some(parsedUserId.right)
      : Option.none();
    return Effect.succeed([
      {
        provider: "twitterapiio",
        eventKey: `activity:${id.right}`,
        accountId: userId,
        activityId: Option.some(id.right),
        reduced: true,
        payloadJson: payload.right,
        receivedAtEpochMillis: normalizeEpochMillis(envelope.timestamp),
      },
    ]);
  }
  if (envelope.event_type !== "tweet") return Effect.succeed([]);
  return decodeTwitterTweetBatch(envelope.tweets, "实时批次").pipe(
    Effect.flatMap((batch) =>
      Effect.forEach(batch.decoded, (tweet, index) => {
        const mapped = mapStandardTweet(tweet, envelope.timestamp);
        return Either.isRight(mapped)
          ? Effect.succeed(Option.some(mapped.right))
          : Effect.logWarning(
              `TwitterAPI.io 实时批次第 ${index + 1} 条推文序列化失败 [${mapped.left._tag}]：${mapped.left.message}`,
            ).pipe(Effect.as(Option.none<RawRealtimeEvent>()));
      }),
    ),
    Effect.map((events) =>
      events.flatMap((event) => Option.isSome(event) ? [event.value] : []),
    ),
  );
};

/** 解码已完成 JSON 解析的实时输入，并忽略编辑、删除与社交事件。 */
const decodeRealtimeInput = (
  input: unknown,
): Effect.Effect<ReadonlyArray<RawRealtimeEvent>, DecodeError> => {
  if (isUnsupportedEnvelope(input)) return Effect.succeed([]);
  return Schema.decodeUnknown(RealtimeEnvelopeSchema)(input).pipe(
    Effect.mapError(
      (error) => new DecodeError({ provider: "twitterapiio", message: String(error) }),
    ),
    Effect.flatMap(mapEnvelope),
  );
};

/** 解码 TwitterAPI.io WebSocket 或 Webhook JSON 字符串。 */
export const decodeRealtimeText = (
  text: string,
): Effect.Effect<ReadonlyArray<RawRealtimeEvent>, DecodeError> =>
  Effect.try({
    /** 解析 WebSocket 文本中的 JSON envelope。 */
    try: () => JSON.parse(text),
    /** 将无效 JSON 转换为显式解码错误。 */
    catch: (error) =>
      new DecodeError({ provider: "twitterapiio", message: String(error) }),
  }).pipe(
    Effect.flatMap(decodeRealtimeInput),
  );

/** 解码由 Koishi body parser 提供的 Webhook 对象。 */
export const decodeRealtimeObject = (
  input: unknown,
): Effect.Effect<ReadonlyArray<RawRealtimeEvent>, DecodeError> =>
  decodeRealtimeInput(input);
