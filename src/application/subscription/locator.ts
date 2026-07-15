import * as Effect from "effect/Effect";
import { ConfigurationError } from "../../domain/errors";
import type { XHandle } from "../../domain/identifiers";
import type { ChannelAuthorizationService } from "../../ports/platform";
import type { XDataSourceService } from "../../ports/source";
import type { XWatcherStoreService } from "../../ports/storage";
import { authorizeExisting } from "./authorization";
import type { CommandTarget } from "./models";

/** 在用户名变更后通过稳定 ID 找回同一订阅。 */
export const locateWatchSubscription = (
  store: XWatcherStoreService,
  source: XDataSourceService,
  authorization: ChannelAuthorizationService,
  target: CommandTarget,
  handle: XHandle,
) =>
  Effect.gen(function* () {
    const local = yield* store.findSubscription(target.platform, target.channelId, handle);
    if (local !== null) yield* authorizeExisting(authorization, target, local);
    const user = yield* source.resolveUser(handle);
    if (local !== null && local.account.xUserId !== user.id) {
      return yield* Effect.fail(
        new ConfigurationError({
          message: "该用户名已指向另一账号，请先用旧订阅名取消后再重新订阅",
        }),
      );
    }
    const byId = local === null
      ? yield* store.findSubscriptionByUserId(target.platform, target.channelId, user.id)
      : local;
    if (local === null && byId !== null) {
      yield* authorizeExisting(authorization, target, byId);
    }
    return { user, existing: byId };
  });
