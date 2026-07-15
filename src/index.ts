import type {} from "@koishijs/plugin-http";
import type {} from "@koishijs/plugin-server";
import * as Effect from "effect/Effect";
import type { Context } from "koishi";
import {
  Config as ConfigSchema,
  providerLabel,
  type Config as PluginConfig,
} from "./config";
import { validateConfig } from "./config-validation";
import {
  installConfiguredRuntime,
  registerDatabaseModels,
} from "./runtime";

/** Koishi 插件名称。 */
export const name = "x-watcher";

/** Koishi 插件配置 Schema。 */
export const Config = ConfigSchema;

/** Koishi 插件配置类型。 */
export type Config = PluginConfig;

/** 插件静态服务依赖；实时模式会在运行时等待可选服务。 */
export const inject = {
  required: ["database"],
  optional: ["http", "server"],
};

/** Koishi 控制台中展示的简要使用说明。 */
export const usage = `
使用 \`watch <用户名> [正则]\` 在当前私聊或频道订阅 X/Twitter 动态。

- \`watch @user -t post,reply -m\`：更新动态类型并启用媒体
- \`watch @user --clear-filter\`：清除已有过滤规则
- \`unwatch @user\`：软停用订阅
- \`xlist\`：列出有效订阅；\`xlist --all\` 同时显示停用项

TwitterAPI.io 是稳定数据源；Rettiwt 为实验性逆向数据源。Webhook 模式同样为实验性能力。
`;

/** 应用插件并按模式等待其实际所需的 Koishi 服务。 */
export const apply = (ctx: Context, config: PluginConfig): void => {
  registerDatabaseModels(ctx);
  const validation = Effect.runSync(Effect.either(validateConfig(config)));
  if (validation._tag === "Left") {
    ctx.logger(name).error("配置无效：%s", validation.left.message);
    return;
  }
  ctx.logger(name).info("已选择 %s / %s 模式", providerLabel(config), config.mode);
  if (config.provider === "rettiwt") {
    installConfiguredRuntime(ctx, config);
    return;
  }
  if (config.mode === "webhook") {
    ctx.inject(["http", "server"], (injected) => {
      installConfiguredRuntime(injected, config);
    });
    return;
  }
  ctx.inject(["http"], (injected) => {
    installConfiguredRuntime(injected, config);
  });
};
