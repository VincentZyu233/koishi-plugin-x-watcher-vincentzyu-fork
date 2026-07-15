import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import type { Rettiwt } from "rettiwt-api";
import {
  TransportError,
  type SourceError,
} from "../../../domain/errors";
import { classifyRettiwtError } from "./error-classification";

/** Rettiwt key 对应的运行时状态。 */
interface ClientState {
  readonly key: Redacted.Redacted<string>;
  readonly client: Rettiwt;
  readonly quarantined: boolean;
  readonly cooldownUntil: number;
}

/** 隔离 Rettiwt 客户端轮换状态，避免上层接触密钥。 */
export interface RettiwtClientPool {
  readonly states: Ref.Ref<ReadonlyArray<ClientState>>;
}

/** 使用单把密钥创建 Rettiwt 客户端并收纳构造器同步异常。 */
const makeClientState = (
  RettiwtConstructor: typeof import("rettiwt-api").Rettiwt,
  key: string,
): Effect.Effect<ClientState, SourceError> =>
  Effect.try({
    /** 创建关闭 SDK 内部重试的 Rettiwt 客户端。 */
    try: () => new RettiwtConstructor({ apiKey: key, maxRetries: 0 }),
    /** 将构造器同步异常转换为可恢复的领域错误。 */
    catch: classifyRettiwtError,
  }).pipe(
    Effect.map((client) => ({
      key: Redacted.make(key),
      client,
      quarantined: false,
      cooldownUntil: 0,
    })),
  );

/** 更新失败 key 的隔离或冷却状态。 */
const recordClientFailure = (
  pool: RettiwtClientPool,
  target: ClientState,
  error: SourceError,
  now: number,
): Effect.Effect<void> =>
  Ref.update(pool.states, (current) =>
    current.map((state) => {
      if (state.client !== target.client) return state;
      if (error._tag === "AuthenticationError") return { ...state, quarantined: true };
      if (error._tag === "RateLimitError") {
        return { ...state, cooldownUntil: now + error.retryAfterMillis };
      }
      return state;
    }),
  );

/** 动态加载 Rettiwt 7.1.2 并创建不泄漏明文密钥的客户端池。 */
export const makeRettiwtClientPool = (
  apiKeys: ReadonlyArray<string>,
): Effect.Effect<RettiwtClientPool, SourceError> =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      /** 延迟导入以便未启用 Rettiwt 时不加载其逆向实现。 */
      try: () => import("rettiwt-api"),
      catch: classifyRettiwtError,
    });
    const attempts = yield* Effect.forEach(apiKeys, (key, index) =>
      Effect.either(makeClientState(module.Rettiwt, key)).pipe(
        Effect.map((result) => ({ index, result })),
      ),
    );
    const failures = attempts.filter(({ result }) => Either.isLeft(result));
    yield* Effect.forEach(
      failures,
      ({ index, result }) =>
        Either.isLeft(result)
          ? Effect.logWarning(
              `Rettiwt 第 ${index + 1} 把 key 初始化失败并已隔离 [${result.left._tag}]`,
            )
          : Effect.void,
      { discard: true },
    );
    const initial = attempts.flatMap(({ result }) =>
      Either.isRight(result) ? [result.right] : [],
    );
    const lastFailure = failures[failures.length - 1];
    if (initial.length === 0) {
      return yield* Effect.fail(
        lastFailure !== undefined && Either.isLeft(lastFailure.result)
          ? lastFailure.result.left
          : new TransportError({
              provider: "rettiwt",
              message: "没有可初始化的 Rettiwt API key",
            }),
      );
    }
    const states = yield* Ref.make<ReadonlyArray<ClientState>>(initial);
    return { states };
  });

/** 使用健康 key 执行请求，并在同一次请求内切换失败 key。 */
export const withHealthyClient = <A>(
  pool: RettiwtClientPool,
  operation: (client: Rettiwt) => Promise<A>,
): Effect.Effect<A, SourceError> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* Ref.get(pool.states);
    const available = snapshot.filter(
      (state) => !state.quarantined && state.cooldownUntil <= now,
    );
    let lastError: SourceError = new TransportError({
      provider: "rettiwt",
      message: "没有可用的 Rettiwt API key",
    });
    for (const state of available) {
      const result = yield* Effect.either(
        Effect.tryPromise({
          /** 使用当前健康客户端执行调用方提供的异步请求。 */
          try: () => operation(state.client),
          catch: classifyRettiwtError,
        }),
      );
      if (Either.isRight(result)) return result.right;
      lastError = result.left;
      const failedAt = yield* Clock.currentTimeMillis;
      yield* recordClientFailure(pool, state, lastError, failedAt);
    }
    return yield* Effect.fail(lastError);
  });
