import type { WebSocket } from "@koishijs/plugin-http";
import * as Effect from "effect/Effect";
import type { Context } from "koishi";
import { TransportError } from "../../../domain/errors";

/** 将边界抛出的未知原因转换为可记录文本。 */
const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 将 WebSocket 创建或监听器注册的同步异常转换为可重试传输错误。 */
export const attemptWebSocketAction = <A>(
  operation: string,
  action: () => A,
): Effect.Effect<A, TransportError> =>
  Effect.try({
    try: action,
    /** 将同步异常建模为可重试错误。 */
    catch: (cause) => new TransportError({
      provider: "twitterapiio",
      message: `${operation}：${describeCause(cause)}`,
    }),
  });

/** 收敛 WebSocket Scope 清理异常并写入插件日志。 */
export const ignoreWebSocketCleanupFailure = (
  ctx: Context,
  operation: string,
  action: () => void,
): Effect.Effect<void> =>
  Effect.try({
    try: action,
    /** 保留清理异常供日志边界消费。 */
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.try({
        /** 记录已收敛的清理异常。 */
        try: () => ctx.logger("x-watcher").warn(
          "%s失败，已收敛清理异常：%s",
          operation,
          describeCause(cause),
        ),
        /** 日志适配器异常同样不得破坏 Scope 释放。 */
        catch: () => undefined,
      }).pipe(Effect.ignore),
    ),
  );

/** 在 Scope 结束时关闭 WebSocket，关闭异常只记录而不覆盖业务失败。 */
export const closeWebSocket = (
  ctx: Context,
  socket: WebSocket,
): Effect.Effect<void> =>
  ignoreWebSocketCleanupFailure(ctx, "关闭 WebSocket", () =>
    socket.close(1000, "x-watcher scope disposed"));
