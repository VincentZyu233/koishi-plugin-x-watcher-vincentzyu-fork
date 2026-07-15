import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import type { Context } from "koishi";
import {
  createRealtimeSink,
  runWebhookWorkers,
  runWebSocketWorkers,
} from "../../application/workers";
import { registerCommands } from "../../commands";
import type {
  TwitterApiWebhookConfig,
  TwitterApiWebSocketConfig,
} from "../../config";
import {
  registerTwitterApiWebhook,
  TWITTER_API_WEBHOOK_PATH,
} from "../../infrastructure/providers/twitterapi/webhook";
import { TwitterApiWebSocketLayer } from "../../infrastructure/providers/twitterapi/websocket";
import { XWatcherStore } from "../../ports/storage";
import { fingerprintApiKey, prepareStore } from "../config-preparation";
import { makeRealtimeApplicationLayer } from "../layers";
import {
  disposeRuntimeOnFailure,
  makeRuntimeCleanupReporter,
  stopManagedRuntime,
} from "../managed";
import type { RuntimeDisposer } from "../models";

/** 启动 TwitterAPI.io Account Stream WebSocket 模式。 */
export const startTwitterApiWebSocket = (
  ctx: Context,
  config: TwitterApiWebSocketConfig,
): Promise<RuntimeDisposer> => {
  const fingerprint = fingerprintApiKey(config.apiKey);
  const layer = Layer.merge(
    makeRealtimeApplicationLayer(ctx, config.apiKey),
    TwitterApiWebSocketLayer(ctx, config.apiKey),
  );
  const runtime = ManagedRuntime.make(layer);
  const reporter = makeRuntimeCleanupReporter(ctx);
  const starting = runtime.runPromise(prepareStore(true, fingerprint)).then(() => {
    registerCommands(ctx, runtime);
    const worker = runtime.runFork(runWebSocketWorkers);
    ctx.logger("x-watcher").info(
      "TwitterAPI.io Account Stream WebSocket 已启动",
    );
    return () => stopManagedRuntime(worker, runtime, reporter);
  });
  return disposeRuntimeOnFailure(runtime, starting, reporter);
};

/** 启动实验性的 TwitterAPI.io Account Stream Webhook 模式。 */
export const startTwitterApiWebhook = (
  ctx: Context,
  config: TwitterApiWebhookConfig,
): Promise<RuntimeDisposer> => {
  const fingerprint = fingerprintApiKey(config.apiKey);
  const runtime = ManagedRuntime.make(
    makeRealtimeApplicationLayer(ctx, config.apiKey),
  );
  const reporter = makeRuntimeCleanupReporter(ctx);
  const starting = runtime.runPromise(prepareStore(true, fingerprint)).then(
    () => runtime.runPromise(XWatcherStore),
  ).then((store) => {
    registerTwitterApiWebhook(
      ctx,
      config.callbackToken,
      createRealtimeSink(store),
    );
    registerCommands(ctx, runtime);
    const worker = runtime.runFork(runWebhookWorkers);
    const callbackUrl = `${config.publicBaseUrl.replace(/\/+$/, "")}${TWITTER_API_WEBHOOK_PATH}`;
    ctx.logger("x-watcher").warn(
      "实验性 Account Stream Webhook 已启动；请在供应商控制台配置 %s?token=<已隐藏>",
      callbackUrl,
    );
    return () => stopManagedRuntime(worker, runtime, reporter);
  });
  return disposeRuntimeOnFailure(runtime, starting, reporter);
};
