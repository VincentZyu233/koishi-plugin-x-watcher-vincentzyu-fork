import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { XHandle } from "../../domain/identifiers";
import type { ChannelAuthorizationService } from "../../ports/platform";
import type { XDataSourceService } from "../../ports/source";
import type { XWatcherStoreService } from "../../ports/storage";
import { authorizeExisting } from "./authorization";
import { locateWatchSubscription } from "./locator";
import type {
  SubscriptionApplicationService,
  SubscriptionRuntimeSettings,
  WatchResult,
} from "./models";

/** 创建带基线保护与局部补丁语义的 watch 操作。 */
export const makeWatchOperation = (
  store: XWatcherStoreService,
  source: XDataSourceService,
  authorization: ChannelAuthorizationService,
  settings: SubscriptionRuntimeSettings,
): SubscriptionApplicationService["watch"] =>
  (request) =>
    Effect.gen(function* () {
      const located = yield* locateWatchSubscription(
        store,
        source,
        authorization,
        request.target,
        request.handle,
      );
      const needsBaseline = located.existing === null || !located.existing.active;
      const baselineResult = needsBaseline
        ? yield* Effect.either(source.fetchLatestId(located.user.id))
        : Either.right(Option.none());
      const now = new Date(yield* Clock.currentTimeMillis);
      const baselineKnown = Either.isRight(baselineResult);
      const baselineId = baselineKnown ? Option.getOrNull(baselineResult.right) : null;
      const subscription = yield* store.saveSubscription({
        platform: request.target.platform,
        channelId: request.target.channelId,
        guildId: request.target.guildId,
        isDirect: request.target.isDirect,
        creatorId: request.target.actorId,
        botId: request.target.botId,
        user: located.user,
        baselineId,
        baselineKnown,
        kinds: request.kinds,
        filter: request.filter,
        includeMedia: request.includeMedia,
        remoteMonitoring: settings.remoteMonitoring,
        remoteKeyFingerprint: settings.remoteKeyFingerprint,
        now,
      });
      const outcome: WatchResult["outcome"] = located.existing === null
        ? "created"
        : located.existing.active ? "updated" : "reactivated";
      return {
        outcome,
        subscription,
        baselinePending: needsBaseline && !baselineKnown,
      };
    });

/** 创建按稳定用户 ID 回退定位的 unwatch 操作。 */
export const makeUnwatchOperation = (
  store: XWatcherStoreService,
  source: XDataSourceService,
  authorization: ChannelAuthorizationService,
): SubscriptionApplicationService["unwatch"] =>
  (target, handle) =>
    Effect.gen(function* () {
      const local = yield* store.findSubscription(target.platform, target.channelId, handle);
      const subscription = local === null
        ? yield* resolveSubscriptionByHandle(store, source, target, handle)
        : local;
      if (subscription === null) return { _tag: "NotFound" } as const;
      yield* authorizeExisting(authorization, target, subscription);
      if (!subscription.active) {
        return { _tag: "AlreadyInactive", subscription } as const;
      }
      const now = new Date(yield* Clock.currentTimeMillis);
      yield* store.disableSubscription(subscription.id, now);
      return { _tag: "Disabled", subscription } as const;
    });

/** 通过数据源解析用户名，再以稳定用户 ID 查找频道订阅。 */
const resolveSubscriptionByHandle = (
  store: XWatcherStoreService,
  source: XDataSourceService,
  target: Parameters<SubscriptionApplicationService["unwatch"]>[0],
  handle: XHandle,
) =>
  source.resolveUser(handle).pipe(
    Effect.flatMap((user) =>
      store.findSubscriptionByUserId(target.platform, target.channelId, user.id),
    ),
  );

/** 创建当前频道的订阅列表查询操作。 */
export const makeListOperation = (
  store: XWatcherStoreService,
): SubscriptionApplicationService["list"] =>
  (target, includeInactive) =>
    store.listSubscriptions(target.platform, target.channelId, includeInactive);
