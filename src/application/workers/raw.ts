import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type { XActivity } from "../../domain/activity";
import { DecodeError } from "../../domain/errors";
import { XDataSource, type RawRealtimeEvent } from "../../ports/source";
import {
  XWatcherStore,
  type StoredRawEvent,
  type XWatcherStoreService,
} from "../../ports/storage";
import { nextRetryDate } from "./retry";

/** 使用已绑定的存储服务创建实时事件持久化入口。 */
export const createRealtimeSink =
  (store: XWatcherStoreService) => (event: RawRealtimeEvent) =>
    store.persistRawEvent(event);

/** 校验补全结果仍对应原始事件声明的 Tweet 与作者。 */
const validateHydratedActivity = (raw: StoredRawEvent, activity: XActivity) => {
  const expectedActivity = raw.event.activityId;
  if (
    Option.isSome(expectedActivity) &&
    expectedActivity.value !== activity.id
  ) {
    return Effect.fail(
      new DecodeError({
        provider: raw.event.provider,
        message: "实时事件补全结果的 Tweet ID 与原始事件不一致",
      }),
    );
  }
  const expectedAuthor = raw.event.accountId;
  if (
    Option.isSome(expectedAuthor) &&
    expectedAuthor.value !== activity.authorId
  ) {
    return Effect.fail(
      new DecodeError({
        provider: raw.event.provider,
        message: "实时事件补全结果的作者与原始事件不一致",
      }),
    );
  }
  return Effect.succeed(activity);
};

/** 处理一条已领取的原始实时事件。 */
const processRawEvent = (raw: StoredRawEvent) =>
  Effect.gen(function* () {
    const source = yield* XDataSource;
    const store = yield* XWatcherStore;
    const result = yield* Effect.either(
      source.hydrate(raw.event).pipe(
        Effect.flatMap((activity) => validateHydratedActivity(raw, activity)),
      ),
    );
    if (result._tag === "Left") {
      const retryAt = yield* nextRetryDate(raw.attempts);
      yield* store.retryRawEvent(
        raw.id,
        raw.claimToken,
        retryAt,
        result.left.message,
      );
      return;
    }
    const now = new Date(yield* Clock.currentTimeMillis);
    yield* store.completeRawEvent(raw.id, raw.claimToken, result.right, now);
  });

/** 在实时恢复闸门打开时处理一个原始事件。 */
export const rawEventStep = (gate: Ref.Ref<boolean>) =>
  Ref.get(gate).pipe(
    Effect.flatMap((open) => {
      if (!open) return Effect.sleep("200 millis");
      return XWatcherStore.pipe(
        Effect.flatMap((store) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => store.claimRawEvent(new Date(now))),
          ),
        ),
        Effect.flatMap((raw) =>
          raw === null ? Effect.sleep("500 millis") : processRawEvent(raw),
        ),
      );
    }),
    Effect.catchAll((error) =>
      Effect.logError(`实时事件 worker 失败：${error.message}`).pipe(
        Effect.zipRight(Effect.sleep("1 second")),
      ),
    ),
  );
