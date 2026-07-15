import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { MessageSender } from "../../ports/platform";
import { XWatcherStore, type ClaimedDelivery } from "../../ports/storage";
import { nextRetryDate } from "./retry";

/** 按投递结果推进消息任务或进入下一降级阶段。 */
const processDelivery = (delivery: ClaimedDelivery) =>
  Effect.gen(function* () {
    const sender = yield* MessageSender;
    const store = yield* XWatcherStore;
    const result = yield* Effect.either(
      sender.send(
        delivery.target,
        delivery.plan,
        delivery.stage,
        delivery.partIndex,
      ),
    );
    const nowMillis = yield* Clock.currentTimeMillis;
    if (result._tag === "Right") {
      if (result.right === -1) {
        yield* store.completeDelivery(
          delivery.id,
          delivery.claimToken,
          new Date(nowMillis),
        );
      } else {
        yield* store.updateDeliveryProgress(
          delivery.id,
          delivery.claimToken,
          delivery.stage,
          result.right,
          new Date(nowMillis),
          null,
        );
      }
      return;
    }
    if (
      result.left.classification === "unsupported" &&
      delivery.stage !== "link"
    ) {
      const nextStage = delivery.stage === "mixed" ? "split" : "link";
      yield* store.updateDeliveryProgress(
        delivery.id,
        delivery.claimToken,
        nextStage,
        0,
        new Date(nowMillis),
        result.left.message,
      );
      return;
    }
    const retryAt = yield* nextRetryDate(delivery.attempts);
    yield* store.updateDeliveryProgress(
      delivery.id,
      delivery.claimToken,
      delivery.stage,
      delivery.partIndex,
      retryAt,
      result.left.message,
    );
  });

/** 领取并处理一个严格按订阅头阻塞的投递任务。 */
export const deliveryStep = XWatcherStore.pipe(
  Effect.flatMap((store) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        store.claimDelivery(new Date(now), new Date(now + 5 * 60_000)),
      ),
    ),
  ),
  Effect.flatMap((delivery) =>
    delivery === null ? Effect.sleep("500 millis") : processDelivery(delivery),
  ),
  Effect.catchAll((error) =>
    Effect.logError(`投递 worker 失败：${error.message}`).pipe(
      Effect.zipRight(Effect.sleep("1 second")),
    ),
  ),
);
