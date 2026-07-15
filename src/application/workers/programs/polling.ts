import * as Effect from "effect/Effect";
import { cleanupLoop } from "../cleanup";
import { controlStep } from "../control";
import { deliveryStep } from "../delivery";
import { pollingLoop } from "../recovery";

/** 运行轮询模式所需的恢复、投递和清理 fibers。 */
export const runPollingWorkers = (intervalMinutes: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(pollingLoop(intervalMinutes));
      yield* Effect.forkScoped(Effect.forever(deliveryStep));
      yield* Effect.forkScoped(cleanupLoop);
      return yield* Effect.never;
    }),
  );

/** 运行 TwitterAPI.io 轮询及同 key 下的远端清理控制 fiber。 */
export const runTwitterApiPollingWorkers = (intervalMinutes: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.forkScoped(pollingLoop(intervalMinutes));
      yield* Effect.forkScoped(Effect.forever(deliveryStep));
      yield* Effect.forkScoped(Effect.forever(controlStep));
      yield* Effect.forkScoped(cleanupLoop);
      return yield* Effect.never;
    }),
  );
