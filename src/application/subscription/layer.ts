import * as Layer from "effect/Layer";
import { SubscriptionApplication, type SubscriptionRuntimeSettings } from "./models";
import { makeSubscriptionApplication } from "./service";

/** 提供订阅应用服务 Layer。 */
export const SubscriptionApplicationLayer = (
  settings: SubscriptionRuntimeSettings,
) => Layer.effect(SubscriptionApplication, makeSubscriptionApplication(settings));
