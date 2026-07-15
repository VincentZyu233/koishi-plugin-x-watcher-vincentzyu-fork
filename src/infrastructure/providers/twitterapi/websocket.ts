import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type { Context } from "koishi";
import { DecodeError, TransportError, type SourceError } from "../../../domain/errors";
import {
  RealtimeIngress,
  type RawEventSink,
  type RealtimeIngressService,
} from "../../../ports/source";
import { decodeRealtimeText } from "./realtime";
import {
  attemptWebSocketAction,
  closeWebSocket,
  ignoreWebSocketCleanupFailure,
} from "./websocket-scope";

/** TwitterAPI.io Account Stream WebSocket 地址。 */
const WEBSOCKET_URL = "wss://ws.twitterapi.io/twitter/tweet/websocket";

/** 将 WebSocket 消息体统一转换为字符串。 */
const messageDataToString = (data: unknown): string =>
  typeof data === "string" ? data : String(data);

/** 创建单次 WebSocket 连接 Effect。 */
const connectOnce = (
  ctx: Context,
  apiKey: string,
  sink: RawEventSink,
  onConnected: Effect.Effect<void, never>,
): Effect.Effect<never, SourceError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<never, SourceError>();
      const runTask = yield* FiberSet.makeRuntime<never, void, never>();
      const socket = yield* Effect.acquireRelease(
        attemptWebSocketAction("创建 WebSocket 连接", () =>
          ctx.http.ws(WEBSOCKET_URL, {
            headers: { "x-api-key": apiKey },
            timeout: 30_000,
          })),
        (resource) => closeWebSocket(ctx, resource),
      );
      let terminated = false;

      /** 只结束一次当前连接，并阻止终止后的事件启动新任务。 */
      const finish = (error: SourceError): void => {
        if (terminated) return;
        terminated = true;
        Deferred.unsafeDone(terminal, Effect.fail(error));
      };

      /** 在连接建立后执行当前会话的恢复回调。 */
      const onOpen = (): void => {
        if (!terminated) runTask(onConnected);
      };

      /** 解码并异步持久化一条 WebSocket 消息。 */
      const onMessage = (event: MessageEvent): void => {
        if (terminated) return;
        const program = decodeRealtimeText(messageDataToString(event.data)).pipe(
          Effect.flatMap((events) =>
            Effect.forEach(events, sink, { discard: true }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => {
              if (error._tag === "PersistenceError") {
                ctx.logger("x-watcher").error(
                  "实时事件持久化失败，将关闭连接并通过恢复扫描补偿：%s",
                  error.message,
                );
                finish(new TransportError({
                  provider: "twitterapiio",
                  message: `WebSocket 实时事件持久化失败：${error.message}`,
                }));
                socket.close(1011, "x-watcher persistence failure");
                return;
              }
              ctx.logger("x-watcher").warn(
                "忽略无法解码的实时事件：%s",
                error.message,
              );
            }),
          ),
        );
        runTask(program);
      };

      /** 将连接错误转换为可重试传输错误。 */
      const onError = (): void =>
        finish(
          new TransportError({
            provider: "twitterapiio",
            message: "WebSocket 连接错误",
          }),
        );

      /** 根据关闭码结束当前连接并交给 supervisor 退避。 */
      const onClose = (event: CloseEvent): void => {
        const message = `WebSocket 已关闭（${event.code} ${event.reason}）`;
        finish(
          event.code === 1008
            ? new DecodeError({ provider: "twitterapiio", message })
            : new TransportError({ provider: "twitterapiio", message }),
        );
      };

      yield* Effect.acquireRelease(
        attemptWebSocketAction("注册 message 监听器", () =>
          socket.addEventListener("message", onMessage)),
        () => ignoreWebSocketCleanupFailure(ctx, "移除 message 监听器", () =>
          socket.removeEventListener("message", onMessage)),
      );
      yield* Effect.acquireRelease(
        attemptWebSocketAction("注册 open 监听器", () =>
          socket.addEventListener("open", onOpen)),
        () => ignoreWebSocketCleanupFailure(ctx, "移除 open 监听器", () =>
          socket.removeEventListener("open", onOpen)),
      );
      yield* Effect.acquireRelease(
        attemptWebSocketAction("注册 error 监听器", () =>
          socket.addEventListener("error", onError)),
        () => ignoreWebSocketCleanupFailure(ctx, "移除 error 监听器", () =>
          socket.removeEventListener("error", onError)),
      );
      yield* Effect.acquireRelease(
        attemptWebSocketAction("注册 close 监听器", () =>
          socket.addEventListener("close", onClose)),
        () => ignoreWebSocketCleanupFailure(ctx, "移除 close 监听器", () =>
          socket.removeEventListener("close", onClose)),
      );
      return yield* Deferred.await(terminal);
    }),
  );

/** 创建 TwitterAPI.io WebSocket 实时入口服务。 */
const makeWebSocketIngress = (
  ctx: Context,
  apiKey: string,
): RealtimeIngressService => ({
  /** 启动一次可被 Scope 中断的 Account Stream 连接。 */
  run: (sink, onConnected) => connectOnce(ctx, apiKey, sink, onConnected),
});

/** 提供 TwitterAPI.io Account Stream WebSocket 实时入口 Layer。 */
export const TwitterApiWebSocketLayer = (ctx: Context, apiKey: string) =>
  Layer.succeed(RealtimeIngress, makeWebSocketIngress(ctx, apiKey));
