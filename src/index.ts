import { Context, Logger } from "koishi";
import { registerCommands } from "./commands";
import {
  Config,
  type Config as PluginConfig,
  type WatcherAvatarRefreshMode,
} from "./config";
import { extendWatcherTable, migrateWatcherTable } from "./database";
import { createRettiwtDataSource } from "./providers/rettiwt";
import { createTwitterAccountStreamService } from "./providers/stream";
import { createTwitterApiDataSource } from "./providers/twitterapi";
import { installProxy } from "./proxy";
import {
  createMessageOutput,
  outputCapabilities,
  type MessageOutput,
} from "./output";
import { createTakumiRenderer } from "./render/takumi";
import { createAttachmentOutput, createMediaDownload } from "./media";
import { createImageLimiter } from "./render/image";
import { createAccountStreamRuntime, createPollingRuntime, type PluginRuntime } from "./runtime";

export const name = "x-watcher";
export const inject = { required: ["database", "http", "ffmpeg"] };
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
- 使用 \`xwatch [-m] [--quote] [--retweet] <username> [regexp]\` 订阅动态，
- 使用 \`xun <username>\` 或 \`xunwatch <username>\` 软取消
- 使用 \`xlist\` 查看当前频道订阅。
- 使用 \`xhe\` 查看插件全部指令与选项总览。
- 使用 \`xlatest [username] [-t post|reply]\` 即时获取指定用户的最新推文或回复；省略用户名时查询配置的默认账号。
- 使用 \`xrecent [username] [-c count]\` 获取指定用户最近的推文和回复；数量表示每类各取 N 条。

在哪里使用 watch 命令，推文的更新就会发送到哪里

请使用 Node.js 22.17 或更高版本

更多信息请前往存储库或 npm 阅读自述文件
`;

const logger = new Logger("x-watcher");

/** 从判别运行时生成命令依赖，保持 mode 与 monitor 能力一致。 */
function commandDependencies(
  runtime: PluginRuntime,
  interval: number,
  output: MessageOutput,
  latestDefaultUsername: string,
  recentDefaultUsername: string,
  recentDefaultCount: number,
  enableQuote: boolean,
  enableWaitingHint: boolean,
  watcherAvatarRefreshMode: WatcherAvatarRefreshMode,
) {
  if (runtime.mode === "polling") {
    return {
      source: runtime.source,
      interval,
      mode: runtime.mode,
      synchronizeMonitors: runtime.synchronizeMonitors,
      output,
      latestDefaultUsername,
      recentDefaultUsername,
      recentDefaultCount,
      enableQuote,
      enableWaitingHint,
      watcherAvatarRefreshMode,
    };
  }
  return {
    source: runtime.source,
    interval,
    mode: runtime.mode,
    synchronizeMonitors: runtime.synchronizeMonitors,
    output,
    latestDefaultUsername,
    recentDefaultUsername,
    recentDefaultCount,
    enableQuote,
    enableWaitingHint,
    watcherAvatarRefreshMode,
  };
}

/** 根据判别联合只创建一个 provider 和一个运行模式，不做跨源降级。 */
function createRuntime(
  ctx: Context,
  config: PluginConfig,
  rettiwtProxy: string | undefined,
  output: MessageOutput,
): PluginRuntime {
  const delivery = {
    output,
    activityTypes: config.activityTypes ?? ["post", "reply"],
    maxPostCount: config.maxPostCount ?? 5,
    maxReplyCount: config.maxReplyCount ?? 5,
  };
  if (config.provider === "rettiwt") {
    const source = createRettiwtDataSource({
      apiKeys: config.apiKeys,
      logger,
      ...(rettiwtProxy === undefined ? {} : { proxy: rettiwtProxy }),
    });
    return createPollingRuntime(ctx, source, logger, config.interval, undefined, delivery);
  }

  const source = createTwitterApiDataSource(ctx, config.apiKey);
  if (config.mode === "polling") {
    return createPollingRuntime(ctx, source, logger, config.interval, undefined, delivery);
  }
  const stream = createTwitterAccountStreamService(ctx, config.apiKey);
  return createAccountStreamRuntime(
    ctx,
    source,
    stream,
    logger,
    config.interval,
    undefined,
    delivery,
  );
}

/** 表结构和命令同步注册，迁移与 worker 启动延迟到 ready。 */
export function apply(ctx: Context, config: PluginConfig): void {
  try {
    extendWatcherTable(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`声明 x_watcher 表结构失败：${message}`);
    return;
  }

  let disposed = false;
  let runtime: PluginRuntime | null = null;
  let disposeProxy: () => void = () => undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (runtime !== null) runtime.dispose();
    disposeProxy();
  };
  ctx.on("dispose", () => {
    dispose();
  });

  try {
    const proxy = config.provider === "rettiwt"
      ? installProxy({
        enabled: config.enableProxy ?? false,
        url: config.proxyUrl ?? "http://127.0.0.1:7890",
      }, logger)
      : { rettiwtProxy: undefined, dispose: () => undefined };
    disposeProxy = proxy.dispose;
    const mode = config.outputMode ?? "card-text";
    const limiter = createImageLimiter(ctx, logger, config.takumiImageMaxSizeMiB ?? 5);
    const download = createMediaDownload(ctx, {
      enabled: config.enableProxy ?? false,
      url: config.proxyUrl ?? "http://127.0.0.1:7890",
    });
    const output = createMessageOutput(
      mode,
      outputCapabilities(mode).card ? createTakumiRenderer(ctx, logger, {
        format: config.takumiImageFormat ?? "jpg",
        quality: config.takumiImageQuality ?? 50,
        mediaMaxWidth: config.takumiMediaMaxWidth ?? 666,
        mediaMaxHeight: config.takumiMediaMaxHeight ?? 333,
        mediaCrop: config.takumiMediaCrop ?? "mild",
        mediaLayout: config.takumiMediaLayout ?? "grid-2",
      }) : null,
      logger,
      limiter,
      createAttachmentOutput(ctx, logger, download, limiter),
    );
    runtime = createRuntime(ctx, config, proxy.rettiwtProxy, output);
    registerCommands(
      ctx,
      commandDependencies(
        runtime,
        config.interval,
        output,
        config.latestDefaultUsername ?? "amsrntk3",
        config.recentDefaultUsername ?? "OpenAI",
        config.recentDefaultCount ?? 5,
        config.enableQuote ?? true,
        config.enableWaitingHint ?? true,
        config.watcherAvatarRefreshMode ?? "cache",
      ),
      logger,
    );
  } catch (error) {
    dispose();
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`初始化 x-watcher 失败：${message}`);
    return;
  }

  ctx.on("ready", async () => {
    const migrated = await migrateWatcherTable(ctx);
    if (disposed) return;
    if (!migrated.ok) {
      logger.error(`迁移 x_watcher 表失败：${migrated.error}`);
      return;
    }
    if (runtime === null) return;
    try {
      await runtime.start();
      if (disposed) return;
      logger.info(`x-watcher 已启动：${config.provider}/${config.mode}`);
    } catch (error) {
      runtime.dispose();
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`启动 x-watcher 失败：${message}`);
    }
  });
}
