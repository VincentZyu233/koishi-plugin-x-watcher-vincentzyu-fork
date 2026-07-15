import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { cleanupLoop } from "../cleanup";
import { controlStep } from "../control";
import { deliveryStep } from "../delivery";
import { rawEventStep } from "../raw";
import { runDueRecoveryCycle } from "../recovery";

/** 启动两种实时模式共享的原始事件、投递、控制、补拉与清理 fiber。 */
export const forkRealtimeWorkers = (gate: Ref.Ref<boolean>) =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(Effect.forever(rawEventStep(gate)));
    yield* Effect.forkScoped(Effect.forever(deliveryStep));
    yield* Effect.forkScoped(Effect.forever(controlStep));
    yield* Effect.forkScoped(
      Effect.forever(
        runDueRecoveryCycle.pipe(
          Effect.catchAll((error) =>
            Effect.logWarning(`一次性补拉失败：${error.message}`),
          ),
          Effect.zipRight(Effect.sleep("5 seconds")),
        ),
      ),
    );
    yield* Effect.forkScoped(cleanupLoop);
  });
