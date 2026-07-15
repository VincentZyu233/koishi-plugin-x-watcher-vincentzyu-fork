import * as Effect from "effect/Effect";
import * as Either from "effect/Either";

/** 将 Either 提升为具有相同成功值与失败值的 Effect。 */
export const effectFromEither = <A, E>(
  either: Either.Either<A, E>,
): Effect.Effect<A, E> =>
  Either.match(either, {
    /** 将 Either 左值变为 Effect 失败。 */
    onLeft: (error) => Effect.fail(error),
    /** 将 Either 右值变为 Effect 成功。 */
    onRight: (value) => Effect.succeed(value),
  });
