import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { RealtimeIngress, XDataSource } from "../../../ports/source";
import { XWatcherStore } from "../../../ports/storage";
import { createRealtimeSink } from "../raw";
import { runRecoveryCycle } from "../recovery";
import { forkRealtimeWorkers } from "./common";

/** 运行 WebSocket 模式并在每次重连时先恢复再开放路由闸门。 */
export const runWebSocketWorkers = Effect.scoped(
  Effect.gen(function* () {
    const ingress = yield* RealtimeIngress;
    const store = yield* XWatcherStore;
    const source = yield* XDataSource;
    const gate = yield* Ref.make(false);
    const onConnected = runRecoveryCycle.pipe(
      Effect.provideService(XWatcherStore, store),
      Effect.provideService(XDataSource, source),
      Effect.catchAll((error) =>
        Effect.logWarning(`WebSocket 连接恢复失败：${error.message}`),
      ),
      Effect.zipRight(Ref.set(gate, true)),
    );
    const connectionLoop = Effect.forever(
      Ref.set(gate, false).pipe(
        Effect.zipRight(ingress.run(createRealtimeSink(store), onConnected)),
        Effect.catchAll((error) =>
          Effect.logWarning(`WebSocket 将在 90 秒后重连：${error.message}`),
        ),
        Effect.zipRight(Effect.sleep("90 seconds")),
      ),
    );
    yield* Effect.forkScoped(connectionLoop);
    yield* forkRealtimeWorkers(gate);
    return yield* Effect.never;
  }),
);

/** 运行 Webhook 模式；路由必须在调用前完成注册。 */
export const runWebhookWorkers = Effect.scoped(
  Effect.gen(function* () {
    const gate = yield* Ref.make(false);
    yield* runRecoveryCycle.pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`Webhook 启动恢复失败：${error.message}`),
      ),
    );
    yield* Ref.set(gate, true);
    yield* forkRealtimeWorkers(gate);
    return yield* Effect.never;
  }),
);
