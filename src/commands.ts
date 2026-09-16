import { createWatcher, updateExistingWatcher, userFromWatcher, remoteSyncSuffix, withManagementLock, deactivateWatcher, deleteWatcher, type WatchOptions, type SessionAddress } from "./subscriptions";
import { helpCommands, helpDescription, helpOption, HELP_COMMON } from "./help";
import { errorMessage } from "./errors";
import { h, type Context, type Logger, type Session } from "koishi";
import {
  canonicalHandle,
  compileFilter,
  normalizeHandle,
  success,
} from "./domain";
import {
  getChannelWatchers,
  type WatcherRecord,
} from "./database";
import type { WatcherAvatarRefreshMode } from "./config";
import { legacyMessageOutput, type MessageOutput } from "./output";
import type { XDataSourceService } from "./services";

/** 命令共享的数据源和轮询提示间隔。 */
interface CommandDependencyBase {
  readonly canManage?: () => boolean;
  readonly source: XDataSourceService;
  readonly interval: number;
  readonly output?: MessageOutput;
  readonly latestDefaultUsername?: string;
  readonly recentDefaultUsername?: string;
  readonly recentDefaultCount?: number;
  readonly enableQuote?: boolean;
  readonly enableWaitingHint?: boolean;
  readonly watcherAvatarRefreshMode?: WatcherAvatarRefreshMode;
}

/** 命令依赖保持模式与远端 monitor 能力的判别关系。 */
export type CommandDependencies = CommandDependencyBase & (
  | { readonly mode: "polling"; readonly synchronizeMonitors: null }
  | {
      readonly mode: "websocket";
      readonly synchronizeMonitors: () => Promise<boolean>;
    }
);

type CommandReply = (session: Session, message: string) => Promise<void>;

/** 为当前插件实例创建统一命令回复；主动推送不会经过这里。 */
function commandQuote(dependencies: CommandDependencies, session: Session): string {
  return dependencies.enableQuote === true
      && session.messageId !== undefined
      && session.messageId.length > 0
    ? h.quote(session.messageId).toString()
    : "";
}

function createCommandReply(dependencies: CommandDependencies) {
  return async (session: Session, message: string): Promise<void> => {
    await session.send(`${commandQuote(dependencies, session)}${message}`);
  };
}

function messageOutput(dependencies: CommandDependencies): MessageOutput {
  return dependencies.output ?? legacyMessageOutput;
}

/** 等待提示属于辅助反馈，发送失败不能阻断真正的查询。 */
async function sendWaitingHint(
  session: Session,
  dependencies: CommandDependencies,
  logger: Logger,
  message: string,
): Promise<string | null> {
  if (dependencies.enableWaitingHint === false) return null;
  try {
    const messageIds = await session.send(`${commandQuote(dependencies, session)}${message}`);
    return messageIds[0] ?? null;
  } catch (error) {
    const detail = errorMessage(error instanceof Error ? error : String(error));
    logger.warn(`发送等待提示失败，继续执行查询：${detail}`);
    return null;
  }
}

/** 最终结果优先，撤回失败只记录日志。 */
async function retractWaitingHint(
  session: Session,
  logger: Logger,
  messageId: string | null,
): Promise<void> {
  if (messageId === null || session.channelId === undefined) return;
  try {
    await session.bot.deleteMessage(session.channelId, messageId);
  } catch (error) {
    const detail = errorMessage(error instanceof Error ? error : String(error));
    logger.warn(`撤回等待提示失败：${detail}`);
  }
}

/** 在写数据库前收紧 Koishi 会话中的可选地址字段。 */
function sessionAddress(session: Session): SessionAddress | null {
  if (
    session.channelId === undefined ||
    session.userId === undefined ||
    session.bot.selfId.length === 0
  ) {
    return null;
  }
  return {
    platform: session.platform,
    channelId: session.channelId,
    userId: session.userId,
    botId: session.bot.selfId,
  };
}

/** 把可选正则参数规范化为空值或去除首尾空白的规则。 */
function normalizeFilterInput(regexp: string | undefined): string | null {
  if (regexp === undefined || regexp.trim().length === 0) return null;
  return regexp.trim();
}

/** 在当前频道中按大小写无关用户名查找已有订阅。 */
function findByHandle(
  watchers: ReadonlyArray<WatcherRecord>,
  handle: string,
): WatcherRecord | undefined {
  const canonical = canonicalHandle(handle);
  return watchers.find(
    (watcher) => canonicalHandle(watcher.twitter_username) === canonical,
  );
}

/** 构造 watch 成功后的规则摘要。 */
function watchSummary(
  filter: string | null,
  options: WatchOptions,
): string {
  const filterText = filter === null ? "无" : filter;
  return [
    `过滤条件：${filterText}`,
    `媒体：${options.media ? "包含" : "不含"}`,
    `引用：${options.quote ? "开启" : "关闭"}`,
    `转推：${options.retweet ? "开启" : "关闭"}`,
  ].join("\n");
}

/** 按配置为列表补齐订阅头像，任何单条失败都不影响列表本身。 */
async function refreshWatcherAvatars(
  ctx: Context,
  source: XDataSourceService,
  watchers: ReadonlyArray<WatcherRecord>,
  mode: WatcherAvatarRefreshMode,
  logger: Logger,
): Promise<WatcherRecord[]> {
  if (mode === "placeholder") return [...watchers];
  const refreshed: WatcherRecord[] = [];
  for (const watcher of watchers) {
    const cachedUrl = watcher.twitter_avatar_url;
    const needsRefresh = mode === "always"
      || cachedUrl === undefined
      || cachedUrl === null
      || cachedUrl.length === 0;
    if (!needsRefresh) {
      refreshed.push(watcher);
      continue;
    }
    const resolved = await source.resolveUser(watcher.twitter_username);
    if (!resolved.ok) {
      logger.warn(`xlist 补查 @${watcher.twitter_username} 头像失败：${resolved.error.message}`);
      refreshed.push(watcher);
      continue;
    }
    const avatarUrl = resolved.value.avatarUrl;
    if (avatarUrl === undefined || avatarUrl.length === 0) {
      refreshed.push(watcher);
      continue;
    }
    try {
      await ctx.database.set(
        "x_watcher",
        { id: watcher.id },
        { twitter_avatar_url: avatarUrl },
      );
    } catch (error) {
      const message = errorMessage(error instanceof Error ? error : String(error));
      logger.warn(`xlist 缓存 @${watcher.twitter_username} 头像失败：${message}`);
    }
    refreshed.push({ ...watcher, twitter_avatar_url: avatarUrl });
  }
  return refreshed;
}

/** 注册新增和完整更新订阅的 watch 命令。 */
function registerWatchCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  const reply = createCommandReply(dependencies);
  ctx
    .command(
      "x-watcher.watch <twitter_username> [regexp:text]",
      helpDescription("x-watcher.watch"),
    )
    .option("media", `-m ${helpOption("x-watcher.watch", "media", dependencies)}`, { fallback: false })
    .option("quote", `--quote ${helpOption("x-watcher.watch", "quote", dependencies)}`, { fallback: false })
    .option("retweet", `--retweet ${helpOption("x-watcher.watch", "retweet", dependencies)}`, { fallback: false })
    .alias("xwatch")
    .alias("xwa")
    .action(async ({ session, options }, twitterUsername, regexp) => {
      if (session === undefined) return;
      if (twitterUsername === undefined) {
        await reply(session, "⚠️ 请提供要订阅的 X/Twitter 用户名");
        return;
      }
      const address = sessionAddress(session);
      if (address === null) {
        await reply(session, "❌ 当前会话缺少频道或用户标识，无法保存订阅");
        return;
      }
      const parsedHandle = normalizeHandle(twitterUsername);
      if (!parsedHandle.ok) {
        await reply(session, `⚠️ ${parsedHandle.error}`);
        return;
      }
      const filter = normalizeFilterInput(regexp);
      const compiled = compileFilter(filter);
      if (!compiled.ok) {
        await reply(session, `⚠️ 正则表达式格式错误：${compiled.error}`);
        return;
      }
      const watchOptions: WatchOptions = {
        media: options !== undefined && options.media === true,
        quote: options !== undefined && options.quote === true,
        retweet: options !== undefined && options.retweet === true,
      };

      try {
        await withManagementLock(ctx, async () => {
          if (dependencies.canManage !== undefined && !dependencies.canManage()) {
            throw new Error("订阅管理尚未就绪");
          }
          const channelWatchers = await getChannelWatchers(
            ctx,
            address.platform,
            address.channelId,
          );
          const localMatch = findByHandle(channelWatchers, parsedHandle.value);
          if (dependencies.canManage !== undefined && !dependencies.canManage()) {
            throw new Error("订阅管理尚未就绪");
          }

          // 活跃订阅的规则更新不依赖远端 API，数据源短暂故障时仍可操作。
          if (localMatch !== undefined && localMatch.active) {
            await updateExistingWatcher(
              ctx,
              address,
              localMatch,
              userFromWatcher(localMatch),
              filter,
              watchOptions,
              false,
              localMatch.last_tweet_id,
            );
            const remote = await remoteSyncSuffix(
              dependencies.synchronizeMonitors,
            );
            await reply(
              session,
              `✅ 已更新 ${localMatch.twitter_fullname} 的订阅\n${watchSummary(filter, watchOptions)}${remote}`,
            );
            return;
          }

          const resolved =
            localMatch === undefined
              ? await dependencies.source.resolveUser(parsedHandle.value)
              : success(userFromWatcher(localMatch));
          if (!resolved.ok) {
            await reply(
              session,
              `❌ 获取 X/Twitter 用户失败：${resolved.error.message}`,
            );
            return;
          }

          const stableMatch = channelWatchers.find(
            (watcher) => watcher.twitter_id === resolved.value.id,
          );
          if (dependencies.canManage !== undefined && !dependencies.canManage()) {
            throw new Error("订阅管理尚未就绪");
          }
          if (stableMatch !== undefined && stableMatch.active) {
            await updateExistingWatcher(
              ctx,
              address,
              stableMatch,
              resolved.value,
              filter,
              watchOptions,
              false,
              stableMatch.last_tweet_id,
            );
            const remote = await remoteSyncSuffix(
              dependencies.synchronizeMonitors,
            );
            await reply(
              session,
              `✅ 已更新 ${resolved.value.fullname} 的订阅\n${watchSummary(filter, watchOptions)}${remote}`,
            );
            return;
          }

          const baseline = await dependencies.source.fetchBaseline(resolved.value);
          if (!baseline.ok) {
            await reply(
              session,
              `❌ 建立订阅水位失败：${baseline.error.message}`,
            );
            return;
          }

          const existing = stableMatch === undefined ? localMatch : stableMatch;
          if (dependencies.canManage !== undefined && !dependencies.canManage()) {
            throw new Error("订阅管理尚未就绪");
          }
          if (existing === undefined) {
            await createWatcher(
              ctx,
              address,
              resolved.value,
              baseline.value,
              filter,
              watchOptions,
            );
          } else {
            await updateExistingWatcher(
              ctx,
              address,
              existing,
              resolved.value,
              filter,
              watchOptions,
              true,
              baseline.value,
            );
          }
          const remote = await remoteSyncSuffix(
            dependencies.synchronizeMonitors,
          );
          const deliveryExpectation = dependencies.mode === "websocket"
            ? "后续动态将通过实时流推送"
            : `后续动态将在约 ${dependencies.interval} 分钟内推送`;
          await reply(
            session,
            `✅ 已订阅 ${resolved.value.fullname}，${deliveryExpectation}\n${watchSummary(filter, watchOptions)}${remote}`,
          );
        });
      } catch (error) {
        const message = errorMessage(error instanceof Error ? error : String(error));
        logger.error(`watch 命令失败：${message}`);
        await reply(session, "❌ 订阅失败，请稍后重试");
      }
    });
}

/** 默认软取消；硬取消等待当前会话确认后删除记录。 */
function registerUnwatchCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  const reply = createCommandReply(dependencies);
  const pending = new Set<string>();
  let disposed = false;
  ctx.on("dispose", () => { disposed = true; pending.clear(); });
  ctx
    .command(
      "x-watcher.unwatch <twitter_username>",
      helpDescription("x-watcher.unwatch"),
    )
    .option("hard", `--hard ${helpOption("x-watcher.unwatch", "hard", dependencies)}`, { fallback: false })
    .alias("xun")
    .alias("xunwatch")
    .action(async ({ session, options }, twitterUsername) => {
      if (session === undefined) return;
      if (twitterUsername === undefined) {
        await reply(session, "⚠️ 请提供要取消订阅的 X/Twitter 用户名");
        return;
      }
      const address = sessionAddress(session);
      if (address === null) {
        await reply(session, "❌ 当前会话缺少频道或用户标识，无法管理订阅");
        return;
      }
      const parsedHandle = normalizeHandle(twitterUsername);
      if (!parsedHandle.ok) {
        await reply(session, `⚠️ ${parsedHandle.error}`);
        return;
      }
      try {
        const watchers = await getChannelWatchers(
          ctx,
          address.platform,
          address.channelId,
        );
        let target = findByHandle(watchers, parsedHandle.value);
        if (target === undefined) {
          const resolved = await dependencies.source.resolveUser(
            parsedHandle.value,
          );
          if (resolved.ok) {
            target = watchers.find(
              (watcher) => watcher.twitter_id === resolved.value.id,
            );
          }
        }
        if (target === undefined) {
          await reply(session, "⚠️ 订阅不存在");
          return;
        }
        if (options !== undefined && options.hard === true) {
          const key = JSON.stringify([address.platform, address.channelId, address.userId]);
          if (pending.has(key)) {
            await reply(session, "⚠️ 当前会话已有硬取消确认，请先回复 y/n 或等待超时");
            return;
          }
          pending.add(key);
          try {
            await reply(session, h.text(`⚠️ 将永久删除当前会话中 @${target.twitter_username} 的订阅记录（${target.active ? "订阅中" : "已取消"}），删除后无法恢复。请由发起人在 30 秒内回复 y 确认、n 取消；其他回复也会取消。`).toString());
            const answer = await session.prompt(30_000);
            if (disposed) return;
            if (dependencies.canManage !== undefined && !dependencies.canManage()) return;
            if (typeof answer !== "string" || answer.length === 0) {
              await reply(session, "⚠️ 确认超时，已取消硬取消操作");
              return;
            }
            if (answer.trim().toLowerCase() !== "y") {
              await reply(session, "ℹ️ 已取消硬取消操作，订阅记录未删除");
              return;
            }
            // 条件删除防止等待期间重新订阅、修改规则或 worker 更新后误删旧快照。
            const result = await withManagementLock(ctx, () => deleteWatcher(ctx, target, true));
            if (result.removed === 0) {
              await reply(session, "⚠️ 订阅已变更或已被删除，请重新执行命令确认");
              return;
            }
            const remote = await remoteSyncSuffix(dependencies.synchronizeMonitors);
            await reply(session, h.text(`✅ 已硬取消 @${target.twitter_username} 的订阅，本地记录已永久删除${remote}`).toString());
          } finally {
            pending.delete(key);
          }
          return;
        }
        if (!target.active) {
          await reply(session, `⚠️ ${target.twitter_username} 的订阅已经取消`);
          return;
        }
        await withManagementLock(ctx, () => {
          if (dependencies.canManage !== undefined && !dependencies.canManage()) {
            throw new Error("订阅管理尚未就绪");
          }
          return deactivateWatcher(ctx, target);
        });
        const remote = await remoteSyncSuffix(
          dependencies.synchronizeMonitors,
        );
        await reply(
          session,
          `✅ 已取消 ${target.twitter_username} 的订阅${remote}`,
        );
      } catch (error) {
        const message = errorMessage(error instanceof Error ? error : String(error));
        logger.error(`unwatch 命令失败：${message}`);
        await reply(session, "❌ 取消订阅失败，请稍后重试");
      }
    });
}

/** 注册当前频道订阅列表命令。 */
function registerListCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  const reply = createCommandReply(dependencies);
  ctx
    .command("x-watcher.list", helpDescription("x-watcher.list"))
    .alias("xlist")
    .alias("xls")
    .action(async ({ session }) => {
      if (session === undefined) return;
      const output = messageOutput(dependencies);
      const address = sessionAddress(session);
      if (address === null) {
        await reply(session, "❌ 当前会话缺少频道或用户标识，无法读取订阅");
        return;
      }
      try {
        const watchers = await getChannelWatchers(
          ctx,
          address.platform,
          address.channelId,
        );
        const mode = dependencies.watcherAvatarRefreshMode ?? "cache";
        const watchersWithAvatars = await refreshWatcherAvatars(
          ctx,
          dependencies.source,
          watchers,
          mode,
          logger,
        );
        await reply(session, await output.watcherList(watchersWithAvatars));
      } catch (error) {
        const message = errorMessage(error instanceof Error ? error : String(error));
        logger.error(`xlist 命令失败：${message}`);
        await reply(session, "❌ 获取订阅列表失败，请稍后重试");
      }
    });
}

/** 注册不创建订阅、不推进水位的即时最新动态查询。 */
function registerLatestCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  const reply = createCommandReply(dependencies);
  ctx
    .command(
      "x-watcher.latest [twitter_username]",
      helpDescription("x-watcher.latest"),
    )
    .option("type", `-t, --type <type:string> ${helpOption("x-watcher.latest", "type", dependencies)}`, { fallback: "post" })
    .alias("xlatest")
    .alias("xla")
    .action(async ({ session, options }, twitterUsername) => {
      if (session === undefined) return;
      const output = messageOutput(dependencies);
      const defaultUsername = dependencies.latestDefaultUsername ?? "amsrntk3";
      const parsedHandle = normalizeHandle(twitterUsername ?? defaultUsername);
      if (!parsedHandle.ok) {
        await reply(session, `⚠️ ${parsedHandle.error}`);
        return;
      }
      const requested = options === undefined || options.type === undefined
        ? "post"
        : options.type;
      if (requested !== "post" && requested !== "reply") {
        await reply(session, "⚠️ 动态类型只支持 post 或 reply");
        return;
      }
      if (dependencies.source.fetchLatest === undefined) {
        await reply(session, "⚠️ 当前数据源不支持即时查询最新动态");
        return;
      }
      const waitingHintId = await sendWaitingHint(
        session,
        dependencies,
        logger,
        "⏳ 正在获取最新动态并生成消息，请稍候...",
      );
      try {
        const user = await dependencies.source.resolveUser(parsedHandle.value);
        if (!user.ok) {
          await reply(session, `❌ 获取 X/Twitter 用户失败：${user.error.message}`);
          return;
        }
        const latest = await dependencies.source.fetchLatest(user.value, requested);
        if (!latest.ok) {
          await reply(session, `❌ 获取最新动态失败：${latest.error.message}`);
          return;
        }
        if (latest.value === null) {
          await reply(
            session,
            `⚠️ 未在最近的时间线中找到 @${user.value.username} 的${requested === "post" ? "推文" : "回复"}`,
          );
          return;
        }
        await reply(session, await output.activity(latest.value, true));
      } catch (error) {
        const message = errorMessage(error instanceof Error ? error : String(error));
        logger.error(`xlatest 命令失败：${message}`);
        await reply(session, "❌ 获取最新动态失败，请稍后重试");
      } finally {
        await retractWaitingHint(session, logger, waitingHintId);
      }
    });
}

/** 注册不创建订阅、不推进水位的最近动态批量查询。 */
function registerRecentCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  const reply = createCommandReply(dependencies);
  ctx
    .command(
      "x-watcher.recent [twitter_username]",
      helpDescription("x-watcher.recent"),
    )
    .option("count", `-c, --count <count:number> ${helpOption("x-watcher.recent", "count", dependencies)}`)
    .alias("xrecent")
    .alias("xre")
    .action(async ({ session, options }, twitterUsername) => {
      if (session === undefined) return;
      const output = messageOutput(dependencies);
      const defaultUsername = dependencies.recentDefaultUsername ?? "OpenAI";
      const parsedHandle = normalizeHandle(twitterUsername ?? defaultUsername);
      if (!parsedHandle.ok) {
        await reply(session, `⚠️ ${parsedHandle.error}`);
        return;
      }
      const configuredCount = dependencies.recentDefaultCount ?? 5;
      const count = options === undefined || options.count === undefined
        ? configuredCount
        : options.count;
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        await reply(session, "⚠️ 数量必须是 1～50 的整数；该数量会分别应用于推文和回复");
        return;
      }
      if (dependencies.source.fetchRecent === undefined) {
        await reply(session, "⚠️ 当前数据源不支持批量查询最近动态");
        return;
      }
      const waitingHintId = await sendWaitingHint(
        session,
        dependencies,
        logger,
        "⏳ 正在获取最近动态并生成消息，请稍候...",
      );
      try {
        const user = await dependencies.source.resolveUser(parsedHandle.value);
        if (!user.ok) {
          await reply(session, `❌ 获取 X/Twitter 用户失败：${user.error.message}`);
          return;
        }
        const recent = await dependencies.source.fetchRecent(user.value, count);
        if (!recent.ok) {
          await reply(session, `❌ 获取最近动态失败：${recent.error.message}`);
          return;
        }
        if (recent.value.length === 0) {
          await reply(session, `⚠️ 未找到 @${user.value.username} 最近的推文或回复`);
          return;
        }
        await reply(session, await output.recentActivities(user.value, recent.value));
      } catch (error) {
        const message = errorMessage(error instanceof Error ? error : String(error));
        logger.error(`xrecent 命令失败：${message}`);
        await reply(session, "❌ 获取最近动态失败，请稍后重试");
      } finally {
        await retractWaitingHint(session, logger, waitingHintId);
      }
    });
}

/** 注册插件总览帮助，复用消息格式和引用段策略。 */
function registerHelpCommand(
  ctx: Context,
  dependencies: CommandDependencies,
): void {
  const reply = createCommandReply(dependencies);
  ctx
    .command("x-watcher.help", helpDescription("x-watcher.help"))
    .alias("xhe")
    .alias("xhelp")
    .action(async ({ session }) => {
      if (session === undefined) return;
      const output = messageOutput(dependencies);
      await reply(session, await output.help(dependencies));
    });
}

/** 注册插件全部公开命令。 */
export function registerCommands(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  registerWatchCommand(ctx, dependencies, logger);
  registerUnwatchCommand(ctx, dependencies, logger);
  registerListCommand(ctx, dependencies, logger);
  registerHelpCommand(ctx, dependencies);
  registerLatestCommand(ctx, dependencies, logger);
  registerRecentCommand(ctx, dependencies, logger);
  for (const definition of helpCommands(dependencies)) {
    const command = ctx.command(definition.name)
      .usage([...definition.notes.map((note) => `ℹ️ ${note}`), ...HELP_COMMON].join("\n"));
    for (const example of definition.examples) command.example(example);
  }
}
