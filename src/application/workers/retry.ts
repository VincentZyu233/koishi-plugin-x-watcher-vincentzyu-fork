import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/** 投递或基础设施重试的最大退避时间。 */
const MAX_BACKOFF_MILLIS = 60 * 60 * 1_000;

/** 根据已执行次数计算从 5 秒开始、最大一小时的全抖动上界。 */
export const retryDelayCapMillis = (attempts: number): number =>
  Math.min(
    MAX_BACKOFF_MILLIS,
    5_000 * 2 ** Math.min(Math.max(0, attempts - 1), 20),
  );

/** 根据尝试次数计算带全抖动的下一次执行时间。 */
export const nextRetryDate = (attempts: number) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const random = yield* Random.next;
    const cap = retryDelayCapMillis(attempts);
    return new Date(now + Math.floor(random * cap));
  });
