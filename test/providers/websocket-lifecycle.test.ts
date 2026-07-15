import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import type { Context } from "koishi";
import { TwitterApiWebSocketLayer } from "../../src/infrastructure/providers/twitterapi/websocket";
import { RealtimeIngress } from "../../src/ports/source";
import { makeFastTweetEnvelope } from "./fixtures/twitterapi";

type Listener = (event: unknown) => void;

/** 模拟测试所需的最小 WebSocket 事件与关闭行为。 */
class FakeWebSocket {
  private readonly listeners = new Map<string, Set<Listener>>();
  readonly closeCalls: Array<readonly [number | undefined, string | undefined]> = [];

  /** 创建可按事件注册或关闭阶段同步抛错的测试 WebSocket。 */
  constructor(
    private readonly failingListener: string | undefined = undefined,
    private readonly closeFailure: Error | undefined = undefined,
  ) {}

  /** 注册指定类型的事件监听器。 */
  addEventListener(type: string, listener: Listener): void {
    if (type === this.failingListener) throw new Error(`add ${type} failed`);
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  /** 移除指定类型的事件监听器。 */
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** 记录连接关闭参数而不自动派发 close 事件。 */
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.closeFailure !== undefined) throw this.closeFailure;
  }

  /** 向当前已注册监听器派发测试事件。 */
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** 返回当前指定类型的监听器数量。 */
  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

/** 构造只包含 HTTP WebSocket 与日志能力的测试 Context。 */
const makeContext = (
  open: () => FakeWebSocket,
  warnings: Array<string> = [],
): Context => ({
  http: { ws: open },
  logger: () => ({
    error: () => undefined,
    warn: (message: string) => warnings.push(message),
  }),
}) as unknown as Context;

describe("TwitterAPI.io WebSocket 生命周期", () => {
  it.effect("连接关闭会中断旧恢复任务，旧任务不能再打开 gate", () => {
    const socket = new FakeWebSocket();
    const layer = TwitterApiWebSocketLayer(makeContext(() => socket), "offline-key");
    return Effect.gen(function* () {
      const ingress = yield* RealtimeIngress;
      const gate = yield* Ref.make(false);
      const interrupted = yield* Ref.make(false);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const recovery = Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(Deferred.await(release)),
        Effect.zipRight(Ref.set(gate, true)),
        Effect.onInterrupt(() => Ref.set(interrupted, true)),
      );
      const connection = yield* Effect.fork(
        ingress.run(() => Effect.void, recovery),
      );
      yield* Effect.yieldNow();
      yield* Effect.sync(() => socket.emit("open", {}));
      yield* Deferred.await(started);
      yield* Effect.sync(() =>
        socket.emit("close", { code: 1006, reason: "network lost" }),
      );
      const exit = yield* Fiber.await(connection);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow();
      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* Ref.get(interrupted)).toBe(true);
      expect(yield* Ref.get(gate)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Scope 释放会中断尚未完成的消息持久化任务并清理监听器", () => {
    const socket = new FakeWebSocket();
    const layer = TwitterApiWebSocketLayer(makeContext(() => socket), "offline-key");
    return Effect.gen(function* () {
      const ingress = yield* RealtimeIngress;
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Ref.make(false);
      /** 模拟已进入持久化但尚未完成的实时事件 sink。 */
      const sink = () => Deferred.succeed(started, undefined).pipe(
        Effect.zipRight(Effect.never),
        Effect.onInterrupt(() => Ref.set(interrupted, true)),
      );
      const connection = yield* Effect.fork(ingress.run(sink, Effect.void));
      yield* Effect.yieldNow();
      yield* Effect.sync(() => socket.emit("open", {}));
      yield* Effect.sync(() => socket.emit("message", {
        data: JSON.stringify(makeFastTweetEnvelope("8501")),
      }));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(connection);
      expect(yield* Ref.get(interrupted)).toBe(true);
      expect(socket.listenerCount("message")).toBe(0);
      expect(socket.listenerCount("open")).toBe(0);
      expect(socket.closeCalls).toContainEqual([1000, "x-watcher scope disposed"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("创建连接同步抛错会成为可重试 TransportError", () => {
    const failure = new Error("ws factory failed");
    const layer = TwitterApiWebSocketLayer(makeContext(() => {
      throw failure;
    }), "offline-key");
    return Effect.gen(function* () {
      const ingress = yield* RealtimeIngress;
      const error = yield* Effect.flip(ingress.run(() => Effect.void, Effect.void));
      expect(error._tag).toBe("TransportError");
      expect(error.message).toContain("创建 WebSocket 连接");
      expect(error.message).toContain(failure.message);
    }).pipe(Effect.provide(layer));
  });

  it.effect("监听器注册同步抛错会清理已注册监听器并关闭连接", () => {
    const socket = new FakeWebSocket("error");
    const layer = TwitterApiWebSocketLayer(makeContext(() => socket), "offline-key");
    return Effect.gen(function* () {
      const ingress = yield* RealtimeIngress;
      const error = yield* Effect.flip(ingress.run(() => Effect.void, Effect.void));
      expect(error._tag).toBe("TransportError");
      expect(error.message).toContain("注册 error 监听器");
      expect(socket.listenerCount("message")).toBe(0);
      expect(socket.listenerCount("open")).toBe(0);
      expect(socket.closeCalls).toContainEqual([1000, "x-watcher scope disposed"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("Scope 关闭异常会被记录且不会覆盖连接失败", () => {
    const warnings: Array<string> = [];
    const socket = new FakeWebSocket(undefined, new Error("close failed"));
    const layer = TwitterApiWebSocketLayer(
      makeContext(() => socket, warnings),
      "offline-key",
    );
    return Effect.gen(function* () {
      const ingress = yield* RealtimeIngress;
      const connection = yield* Effect.fork(
        ingress.run(() => Effect.void, Effect.void),
      );
      yield* Effect.yieldNow();
      yield* Effect.sync(() =>
        socket.emit("close", { code: 1006, reason: "network lost" }));
      const error = yield* Effect.flip(Fiber.join(connection));
      expect(error._tag).toBe("TransportError");
      expect(error.message).toContain("1006 network lost");
      expect(warnings).toContain("%s失败，已收敛清理异常：%s");
      expect(socket.closeCalls).toContainEqual([1000, "x-watcher scope disposed"]);
    }).pipe(Effect.provide(layer));
  });
});
