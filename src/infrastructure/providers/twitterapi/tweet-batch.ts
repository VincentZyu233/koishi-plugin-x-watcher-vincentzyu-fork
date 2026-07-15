import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import * as ParseResult from "effect/ParseResult";
import * as Schema from "effect/Schema";
import type { XActivity } from "../../../domain/activity";
import { DecodeError } from "../../../domain/errors";
import { parseActivityId, type ActivityId } from "../../../domain/identifiers";
import { mapTwitterTweet } from "./mapper";
import { TwitterTweetSchema, type TwitterTweet } from "./schema";

/** 已成功规范化的 TwitterAPI.io 单条推文。 */
export interface DecodedTwitterTweet {
  readonly tweet: TwitterTweet;
  readonly activity: XActivity;
}

/** TwitterAPI.io 批次逐项解码结果。 */
export interface DecodedTwitterTweetBatch {
  readonly decoded: ReadonlyArray<DecodedTwitterTweet>;
  readonly observedIds: ReadonlyArray<ActivityId>;
}

/** 从未解码外部值提取可用于推进水位的 Tweet ID。 */
const extractObservedId = (input: unknown): Option.Option<ActivityId> => {
  if (typeof input !== "object" || input === null || !("id" in input)) {
    return Option.none();
  }
  const parsed = parseActivityId(input.id);
  return Either.isRight(parsed) ? Option.some(parsed.right) : Option.none();
};

/** 将 Effect Schema 解析错误转换为供应商解码错误。 */
const fromParseError = (error: ParseResult.ParseError): DecodeError =>
  new DecodeError({ provider: "twitterapiio", message: String(error) });

/** 对单条外部推文执行 Schema 与领域双重校验。 */
const decodeTweet = (
  input: unknown,
): Either.Either<DecodedTwitterTweet, DecodeError> => {
  const decoded = Schema.decodeUnknownEither(TwitterTweetSchema)(input).pipe(
    Either.mapLeft(fromParseError),
  );
  if (Either.isLeft(decoded)) return Either.left(decoded.left);
  const activity = mapTwitterTweet(decoded.right);
  return Either.isLeft(activity)
    ? Either.left(activity.left)
    : Either.right({ tweet: decoded.right, activity: activity.right });
};

/** 记录被跳过的单条供应商脏数据且不输出其正文。 */
const logSkippedTweet = (
  context: string,
  index: number,
  error: DecodeError,
): Effect.Effect<void> =>
  Effect.logWarning(
    `TwitterAPI.io ${context}第 ${index + 1} 条推文已跳过 [${error._tag}]`,
  );

/** 逐项解码 TwitterAPI.io 推文批次，保留有效项并审计无效项。 */
export const decodeTwitterTweetBatch = (
  inputs: ReadonlyArray<unknown>,
  context: string,
): Effect.Effect<DecodedTwitterTweetBatch> =>
  Effect.gen(function* () {
    const items = inputs.map((input) => ({
      observedId: extractObservedId(input),
      decoded: decodeTweet(input),
    }));
    yield* Effect.forEach(
      items,
      (item, index) =>
        Either.isLeft(item.decoded)
          ? logSkippedTweet(context, index, item.decoded.left)
          : Effect.void,
      { discard: true },
    );
    return {
      decoded: items.flatMap((item) =>
        Either.isRight(item.decoded) ? [item.decoded.right] : [],
      ),
      observedIds: items.flatMap((item) =>
        Option.isSome(item.observedId) ? [item.observedId.value] : [],
      ),
    };
  });
