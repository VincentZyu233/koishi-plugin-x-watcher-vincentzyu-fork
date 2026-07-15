import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Context as KoishiContext } from "koishi";
import {
  ChannelAuthorization,
  type ChannelAuthorizationService,
} from "../../ports/platform";
import { lookupAdministrator } from "./authorization-checks";

/** 创建失败关闭的频道权限服务。 */
const makeChannelAuthorization = (
  ctx: KoishiContext,
): ChannelAuthorizationService => ({
  /** 创建者直接允许；私聊中的其他用户始终拒绝。 */
  canManage: (request) => {
    if (request.actorId === request.creatorId) return Effect.succeed(true);
    if (request.isDirect) return Effect.succeed(false);
    return Effect.tryPromise({
      /** 查询当前平台能够可靠识别的管理员身份。 */
      try: () => lookupAdministrator(ctx, request),
      /** 把平台适配器异常保留为可记录错误。 */
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(String(cause)),
    }).pipe(
      Effect.catchAll((error) =>
        Effect.logWarning(`频道管理员查询失败：${error.message}`).pipe(
          Effect.as(false),
        ),
      ),
    );
  },
});

/** 提供绑定 Koishi 上下文的频道权限 Layer。 */
export const ChannelAuthorizationLive = (ctx: KoishiContext) =>
  Layer.succeed(ChannelAuthorization, makeChannelAuthorization(ctx));
