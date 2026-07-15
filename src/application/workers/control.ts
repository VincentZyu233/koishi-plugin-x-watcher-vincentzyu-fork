import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import { RemoteMonitor } from "../../ports/source";
import { XWatcherStore, type ClaimedControl } from "../../ports/storage";
import { nextRetryDate } from "./retry";

/** 执行一条 Account Stream add/remove 控制任务。 */
const processControl = (control: ClaimedControl) =>
  Effect.gen(function* () {
    const remote = yield* RemoteMonitor;
    const store = yield* XWatcherStore;
    const nowMillis = yield* Clock.currentTimeMillis;
    if (control.operation === "add") {
      const result = yield* Effect.either(remote.add(control.handle));
      if (result._tag === "Left") {
        if (result.left.disposition === "manual") {
          yield* store.coordinateControlAdd(
            control.id,
            control.claimToken,
            result.left.candidateRemoteIds ?? [],
            result.left.message,
            new Date(nowMillis),
          );
          return;
        }
        const retryAt = yield* nextRetryDate(control.attempts);
        yield* store.retryControl(
          control.id,
          control.claimToken,
          retryAt,
          result.left.message,
        );
        return;
      }
      yield* store.completeControl(
        control.id,
        control.claimToken,
        result.right.remoteId,
        new Date(nowMillis + 20 * 60_000),
        new Date(nowMillis),
      );
      return;
    }
    const result = control.remoteId === null
      ? Either.right(undefined)
      : yield* Effect.either(remote.remove(control.remoteId));
    if (result._tag === "Left") {
      const retryAt = yield* nextRetryDate(control.attempts);
      yield* store.retryControl(
        control.id,
        control.claimToken,
        retryAt,
        result.left.message,
      );
      return;
    }
    yield* store.completeControl(
      control.id,
      control.claimToken,
      null,
      null,
      new Date(nowMillis),
    );
  });

/** 领取并处理一个远端监控控制任务。 */
export const controlStep = XWatcherStore.pipe(
  Effect.flatMap((store) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        store.claimControl(new Date(now), new Date(now + 5 * 60_000)),
      ),
    ),
  ),
  Effect.flatMap((control) =>
    control === null ? Effect.sleep("1 second") : processControl(control),
  ),
  Effect.catchAll((error) =>
    Effect.logError(`远端监控 worker 失败：${error.message}`).pipe(
      Effect.zipRight(Effect.sleep("2 seconds")),
    ),
  ),
);
