import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { XWatcherStore } from "../../ports/storage";

/** 每日清理七天前已终结的事件与投递审计。 */
export const cleanupLoop = Effect.forever(
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      XWatcherStore.pipe(
        Effect.flatMap((store) =>
          store.cleanupTerminalRecords(new Date(now - 7 * 24 * 60 * 60_000)),
        ),
      ),
    ),
    Effect.catchAll((error) =>
      Effect.logWarning(`审计清理失败：${error.message}`),
    ),
    Effect.zipRight(Effect.sleep("24 hours")),
  ),
);
