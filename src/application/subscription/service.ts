import * as Effect from "effect/Effect";
import { ChannelAuthorization } from "../../ports/platform";
import { XDataSource } from "../../ports/source";
import { XWatcherStore } from "../../ports/storage";
import type {
  SubscriptionApplicationService,
  SubscriptionRuntimeSettings,
} from "./models";
import {
  makeListOperation,
  makeUnwatchOperation,
  makeWatchOperation,
} from "./operations";

/** 创建订阅应用服务的具体实现。 */
export const makeSubscriptionApplication = (
  settings: SubscriptionRuntimeSettings,
): Effect.Effect<
  SubscriptionApplicationService,
  never,
  XWatcherStore | XDataSource | ChannelAuthorization
> =>
  Effect.gen(function* () {
    const store = yield* XWatcherStore;
    const source = yield* XDataSource;
    const authorization = yield* ChannelAuthorization;
    return {
      watch: makeWatchOperation(store, source, authorization, settings),
      unwatch: makeUnwatchOperation(store, source, authorization),
      list: makeListOperation(store),
    };
  });
