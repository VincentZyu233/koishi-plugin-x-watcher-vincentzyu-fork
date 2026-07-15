import * as Effect from "effect/Effect";
import { AuthorizationError } from "../../domain/errors";
import type { ChannelAuthorizationService } from "../../ports/platform";
import type { StoredSubscription } from "../../ports/storage";
import type { CommandTarget } from "./models";

/** 校验调用者对已有订阅的管理权限。 */
export const authorizeExisting = (
  authorization: ChannelAuthorizationService,
  target: CommandTarget,
  subscription: StoredSubscription,
) =>
  Effect.gen(function* () {
    const allowed = yield* authorization.canManage({
      platform: target.platform,
      channelId: target.channelId,
      guildId: target.guildId,
      actorId: target.actorId,
      creatorId: subscription.creatorId,
      isDirect: target.isDirect,
      botId: target.botId,
    });
    if (!allowed) {
      return yield* Effect.fail(
        new AuthorizationError({ message: "只有订阅创建者或频道管理员可以修改此订阅" }),
      );
    }
  });
