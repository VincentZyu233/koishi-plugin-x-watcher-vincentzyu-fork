import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DecodeError } from "../../../domain/errors";

/** 使用 Effect Schema 解码 TwitterAPI.io 数据并转换失败类型。 */
export const decodeTwitterApi = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema)(input).pipe(
    Effect.mapError(
      (error) =>
        new DecodeError({
          provider: "twitterapiio",
          message: String(error),
        }),
    ),
  );
