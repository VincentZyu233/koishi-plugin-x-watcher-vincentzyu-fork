import type { Context } from "koishi";
import type { Config } from "../config";
import type { RuntimeDisposer } from "./models";
import {
  startRettiwtPolling,
  startTwitterApiPolling,
} from "./modes/polling";
import {
  startTwitterApiWebhook,
  startTwitterApiWebSocket,
} from "./modes/realtime";

/** 根据显式 provider 与 mode 选择唯一启动路径，不执行隐式回退。 */
export const startConfiguredRuntime = (
  ctx: Context,
  config: Config,
): Promise<RuntimeDisposer> => {
  if (config.provider === "rettiwt") return startRettiwtPolling(ctx, config);
  if (config.mode === "polling") return startTwitterApiPolling(ctx, config);
  if (config.mode === "websocket") return startTwitterApiWebSocket(ctx, config);
  return startTwitterApiWebhook(ctx, config);
};
