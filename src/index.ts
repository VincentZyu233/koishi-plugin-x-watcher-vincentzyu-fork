import { Context, Logger } from "koishi";
import { registerCommands } from "./commands";
import { Config, type Config as PluginConfig } from "./config";
import { extendWatcherTable, migrateWatcherTable } from "./database";
import { createRettiwtDataSource } from "./providers/rettiwt";
import { createTwitterAccountStreamService } from "./providers/twitter-stream";
import { createTwitterApiDataSource } from "./providers/twitterapi";
import {
  createAccountStreamRuntime,
  createPollingRuntime,
  type PluginRuntime,
} from "./runtime";

export const name = "x-watcher";
export const inject = { required: ["database", "http"] };
export { Config };

export const usage = `
### 升级后请手动更新配置。

### 如何获取 Rettiwt apiKey
1. 打开你的浏览器（Chrome/Chromium 内核/Firefox/Firefox 内核），访问 Twitter/X。
2. 按下键盘上的 F12 键，打开浏览器开发者工具。
3. 导航至 应用程序 -> Cookie（Chrome/Chromium 内核）或 存储 -> Cookie（Firefox/Firefox 内核）。
4. 复制以下 3 个字段的值：auth_token、ct0、twid。这些将作为你的身份验证凭据。
5. 进入浏览器开发者工具的控制台 ，执行命令：btoa("auth_token=<auth_token_value>;ct0=<ct0_value>;twid=<twid_value>;")。将token值替换为你复制的对应内容。
6. 输出的字符串即为你的 API_KEY。

### 如何使用
- 使用 \`watch [-m] [--quote] [--retweet] <username> [regexp]\` 订阅动态，
- 使用 \`unwatch <username>\` 软取消
- 使用 \`xlist\` 查看当前频道订阅。

在哪里使用 watch 命令，推文的更新就会发送到哪里

请使用 nodejs 22

更多信息请前往存储库或 npm 阅读自述文件
`;

const logger = new Logger("x-watcher");

/** 从判别运行时生成命令依赖，保持 mode 与 monitor 能力一致。 */
function commandDependencies(
  runtime: PluginRuntime,
  interval: number,
) {
  if (runtime.mode === "polling") {
    return {
      source: runtime.source,
      interval,
      mode: runtime.mode,
      synchronizeMonitors: runtime.synchronizeMonitors,
    };
  }
  return {
    source: runtime.source,
    interval,
    mode: runtime.mode,
    synchronizeMonitors: runtime.synchronizeMonitors,
  };
}

/** 根据判别联合只创建一个 provider 和一个运行模式，不做跨源降级。 */
function createRuntime(
  ctx: Context,
  config: PluginConfig,
): PluginRuntime {
  if (config.provider === "rettiwt") {
    const source = createRettiwtDataSource({
      apiKeys: config.apiKeys,
      logger,
    });
    return createPollingRuntime(
      ctx,
      source,
      logger,
      config.interval,
    );
  }

  const source = createTwitterApiDataSource(ctx, config.apiKey);
  if (config.mode === "polling") {
    return createPollingRuntime(
      ctx,
      source,
      logger,
      config.interval,
    );
  }
  const stream = createTwitterAccountStreamService(ctx, config.apiKey);
  return createAccountStreamRuntime(
    ctx,
    source,
    stream,
    logger,
    config.interval,
  );
}

/**
 * 表结构先交给 Koishi 同步，旧数据回填则延迟到 ready。
 * 只有迁移完整成功后才注册命令和 worker，避免半迁移状态继续写入。
 */
export function apply(ctx: Context, config: PluginConfig): void {
  try {
    extendWatcherTable(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`声明 x_watcher 表结构失败：${message}`);
    return;
  }

  ctx.on("ready", async () => {
    const migrated = await migrateWatcherTable(ctx);
    if (!migrated.ok) {
      logger.error(`迁移 x_watcher 表失败：${migrated.error}`);
      return;
    }

    try {
      const runtime = createRuntime(ctx, config);
      ctx.on("dispose", runtime.dispose);
      try {
        await runtime.start();
        registerCommands(
          ctx,
          commandDependencies(runtime, config.interval),
          logger,
        );
      } catch (error) {
        runtime.dispose();
        throw error;
      }
      logger.info(
        `x-watcher 已启动：${config.provider}/${config.mode}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`启动 x-watcher 失败：${message}`);
    }
  });
}
