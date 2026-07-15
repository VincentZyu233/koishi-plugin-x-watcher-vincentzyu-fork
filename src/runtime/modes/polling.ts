import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Layer from "effect/Layer";
import type { Context } from "koishi";
import {
  runPollingWorkers,
  runTwitterApiPollingWorkers,
} from "../../application/workers";
import { registerCommands } from "../../commands";
import type {
  RettiwtPollingConfig,
  TwitterApiPollingConfig,
} from "../../config";
import { RettiwtPollingLayer } from "../../infrastructure/providers/rettiwt/layer";
import {
  TwitterApiDataLayer,
  TwitterApiRemoteMonitorLayer,
} from "../../infrastructure/providers/twitterapi/layers";
import { fingerprintApiKey, prepareStore } from "../config-preparation";
import { makeApplicationLayer } from "../layers";
import {
  disposeRuntimeOnFailure,
  makeRuntimeCleanupReporter,
  stopManagedRuntime,
} from "../managed";
import type { RuntimeDisposer } from "../models";

/** 启动 TwitterAPI.io REST 轮询模式。 */
export const startTwitterApiPolling = (
  ctx: Context,
  config: TwitterApiPollingConfig,
): Promise<RuntimeDisposer> => {
  const fingerprint = fingerprintApiKey(config.apiKey);
  const sourceAndRemote = Layer.merge(
    TwitterApiDataLayer(ctx, config.apiKey),
    TwitterApiRemoteMonitorLayer(ctx, config.apiKey),
  );
  const layer = Layer.merge(
    makeApplicationLayer(
      ctx,
      sourceAndRemote,
      { remoteMonitoring: false, remoteKeyFingerprint: fingerprint },
    ),
    sourceAndRemote,
  );
  const runtime = ManagedRuntime.make(layer);
  const reporter = makeRuntimeCleanupReporter(ctx);
  const starting = runtime.runPromise(prepareStore(false, fingerprint)).then(() => {
    registerCommands(ctx, runtime);
    const worker = runtime.runFork(
      runTwitterApiPollingWorkers(config.intervalMinutes),
    );
    ctx.logger("x-watcher").info(
      "TwitterAPI.io REST 轮询已启动，间隔 %d 分钟",
      config.intervalMinutes,
    );
    return () => stopManagedRuntime(worker, runtime, reporter);
  });
  return disposeRuntimeOnFailure(runtime, starting, reporter);
};

/** 启动 Rettiwt key 池轮询模式。 */
export const startRettiwtPolling = (
  ctx: Context,
  config: RettiwtPollingConfig,
): Promise<RuntimeDisposer> => {
  const layer = makeApplicationLayer(
    ctx,
    RettiwtPollingLayer(config),
    { remoteMonitoring: false, remoteKeyFingerprint: null },
  );
  const runtime = ManagedRuntime.make(layer);
  const reporter = makeRuntimeCleanupReporter(ctx);
  const starting = runtime.runPromise(prepareStore(false, null)).then(() => {
    registerCommands(ctx, runtime);
    const worker = runtime.runFork(runPollingWorkers(config.intervalMinutes));
    ctx.logger("x-watcher").info(
      "Rettiwt 轮询已启动，间隔 %d 分钟，key 池大小 %d",
      config.intervalMinutes,
      config.apiKeys.length,
    );
    return () => stopManagedRuntime(worker, runtime, reporter);
  });
  return disposeRuntimeOnFailure(runtime, starting, reporter);
};
