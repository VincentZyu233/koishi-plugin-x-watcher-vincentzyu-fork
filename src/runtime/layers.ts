import * as Layer from "effect/Layer";
import type { Context } from "koishi";
import {
  SubscriptionApplicationLayer,
  type SubscriptionRuntimeSettings,
} from "../application/subscription";
import { XWatcherStoreLive } from "../infrastructure/database";
import {
  ChannelAuthorizationLive,
  MessageSenderLive,
} from "../infrastructure/koishi";
import {
  TwitterApiDataLayer,
  TwitterApiRemoteMonitorLayer,
} from "../infrastructure/providers/twitterapi/layers";
import type { XDataSource } from "../ports/source";
import { fingerprintApiKey } from "./config-preparation";

/** 合并共享的数据库、平台、数据源与订阅应用 Layer。 */
export const makeApplicationLayer = <E>(
  ctx: Context,
  sourceLayer: Layer.Layer<XDataSource, E>,
  settings: SubscriptionRuntimeSettings,
) => {
  const dependencies = Layer.mergeAll(
    XWatcherStoreLive(ctx),
    ChannelAuthorizationLive(ctx),
    MessageSenderLive(ctx),
    sourceLayer,
  );
  return Layer.provideMerge(
    SubscriptionApplicationLayer(settings),
    dependencies,
  );
};

/** 创建 Account Stream 共享的数据源、远端控制与应用 Layer。 */
export const makeRealtimeApplicationLayer = (
  ctx: Context,
  apiKey: string,
) => {
  const sourceAndRemote = Layer.merge(
    TwitterApiDataLayer(ctx, apiKey),
    TwitterApiRemoteMonitorLayer(ctx, apiKey),
  );
  const application = makeApplicationLayer(ctx, sourceAndRemote, {
    remoteMonitoring: true,
    remoteKeyFingerprint: fingerprintApiKey(apiKey),
  });
  return Layer.merge(application, sourceAndRemote);
};
