import type { Context, Logger, Session } from "koishi";
import {
  canonicalHandle,
  compileFilter,
  normalizeHandle,
  success,
  type XUser,
} from "./domain";
import {
  getChannelWatchers,
  type WatcherRecord,
} from "./database";
import { formatWatcherListMessage } from "./message-formatter";
import type { XDataSourceService } from "./services";

/** 命令共享的数据源和轮询提示间隔。 */
interface CommandDependencyBase {
  readonly source: XDataSourceService;
  readonly interval: number;
}

/** 命令依赖保持模式与远端 monitor 能力的判别关系。 */
export type CommandDependencies = CommandDependencyBase & (
  | { readonly mode: "polling"; readonly synchronizeMonitors: null }
  | {
      readonly mode: "websocket";
      readonly synchronizeMonitors: () => Promise<boolean>;
    }
);

/** watch 命令的完整覆盖选项。 */
interface WatchOptions {
  readonly media: boolean;
  readonly quote: boolean;
  readonly retweet: boolean;
}

/** 命令执行所需的频道定位信息。 */
interface SessionAddress {
  readonly platform: string;
  readonly channelId: string;
  readonly userId: string;
  readonly botId: string;
}

/** 统一等待命令回复，避免适配器拒绝时留下未处理 Promise。 */
async function reply(session: Session, message: string): Promise<void> {
  await session.send(message);
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

/** 从数据库订阅还原稳定用户资料。 */
function userFromWatcher(watcher: WatcherRecord): XUser {
  return {
    id: watcher.twitter_id,
    username: watcher.twitter_username,
    fullname: watcher.twitter_fullname,
  };
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

/** 将 Account Stream 同步结果附加到用户可见回复。 */
async function remoteSyncSuffix(
  synchronizeMonitors: (() => Promise<boolean>) | null,
): Promise<string> {
  if (synchronizeMonitors === null) return "";
  try {
    const synchronized = await synchronizeMonitors();
    return synchronized ? "" : "\n已保存，远端 Stream 同步待重试";
  } catch {
    return "\n已保存，远端 Stream 同步待重试";
  }
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

/** 更新当前频道中同一个稳定 X 用户的订阅设置。 */
async function updateExistingWatcher(
  ctx: Context,
  address: SessionAddress,
  watcher: WatcherRecord,
  user: XUser,
  filter: string | null,
  options: WatchOptions,
  reactivate: boolean,
  baseline: string | null,
): Promise<void> {
  const now = new Date();
  await ctx.database.set(
    "x_watcher",
    {
      platform: watcher.platform,
      channelId: watcher.channelId,
      twitter_id: watcher.twitter_id,
    },
    {
      userId: address.userId,
      botId: address.botId,
      twitter_username: user.username,
      twitter_fullname: user.fullname,
      last_tweet_id: reactivate ? baseline : watcher.last_tweet_id,
      filter_regexp: filter,
      media: options.media,
      include_quote: options.quote,
      include_retweet: options.retweet,
      active: true,
      enabled_at: reactivate ? now : watcher.enabled_at,
      update_at: now,
    },
  );
}

/** 创建一个从当前最新水位开始的新频道订阅。 */
async function createWatcher(
  ctx: Context,
  address: SessionAddress,
  user: XUser,
  baseline: string | null,
  filter: string | null,
  options: WatchOptions,
): Promise<void> {
  const now = new Date();
  await ctx.database.create("x_watcher", {
    platform: address.platform,
    channelId: address.channelId,
    userId: address.userId,
    botId: address.botId,
    twitter_fullname: user.fullname,
    twitter_username: user.username,
    twitter_id: user.id,
    last_tweet_id: baseline,
    filter_regexp: filter,
    media: options.media,
    include_quote: options.quote,
    include_retweet: options.retweet,
    active: true,
    enabled_at: now,
    create_at: now,
    update_at: now,
  });
}

/** 注册新增和完整更新订阅的 watch 命令。 */
function registerWatchCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  ctx
    .command(
      "x-watcher.watch <twitter_username> [regexp:text]",
      "订阅 X/Twitter 用户动态",
    )
    .option("media", "-m", { fallback: false })
    .option("quote", "--quote", { fallback: false })
    .option("retweet", "--retweet", { fallback: false })
    .alias("watch")
    .action(async ({ session, options }, twitterUsername, regexp) => {
      if (session === undefined) return;
      if (twitterUsername === undefined) {
        await reply(session, "请提供要订阅的 X/Twitter 用户名");
        return;
      }
      const address = sessionAddress(session);
      if (address === null) {
        await reply(session, "当前会话缺少频道或用户标识，无法保存订阅");
        return;
      }
      const parsedHandle = normalizeHandle(twitterUsername);
      if (!parsedHandle.ok) {
        await reply(session, parsedHandle.error);
        return;
      }
      const filter = normalizeFilterInput(regexp);
      const compiled = compileFilter(filter);
      if (!compiled.ok) {
        await reply(session, `正则表达式格式错误：${compiled.error}`);
        return;
      }
      const watchOptions: WatchOptions = {
        media: options !== undefined && options.media === true,
        quote: options !== undefined && options.quote === true,
        retweet: options !== undefined && options.retweet === true,
      };

      try {
        const channelWatchers = await getChannelWatchers(
          ctx,
          address.platform,
          address.channelId,
        );
        const localMatch = findByHandle(channelWatchers, parsedHandle.value);

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
            `已更新 ${localMatch.twitter_fullname} 的订阅\n${watchSummary(filter, watchOptions)}${remote}`,
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
            `获取 X/Twitter 用户失败：${resolved.error.message}`,
          );
          return;
        }

        const stableMatch = channelWatchers.find(
          (watcher) => watcher.twitter_id === resolved.value.id,
        );
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
            `已更新 ${resolved.value.fullname} 的订阅\n${watchSummary(filter, watchOptions)}${remote}`,
          );
          return;
        }

        const baseline = await dependencies.source.fetchBaseline(resolved.value);
        if (!baseline.ok) {
          await reply(
            session,
            `建立订阅水位失败：${baseline.error.message}`,
          );
          return;
        }

        const existing = stableMatch === undefined ? localMatch : stableMatch;
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
          `已订阅 ${resolved.value.fullname}，${deliveryExpectation}\n${watchSummary(filter, watchOptions)}${remote}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`watch 命令失败：${message}`);
        await reply(session, "订阅失败，请稍后重试");
      }
    });
}

/** 注册不依赖远端成功即可软取消的 unwatch 命令。 */
function registerUnwatchCommand(
  ctx: Context,
  dependencies: CommandDependencies,
  logger: Logger,
): void {
  ctx
    .command(
      "x-watcher.unwatch <twitter_username>",
      "取消 X/Twitter 用户订阅",
    )
    .alias("unwatch")
    .action(async ({ session }, twitterUsername) => {
      if (session === undefined) return;
      if (twitterUsername === undefined) {
        await reply(session, "请提供要取消订阅的 X/Twitter 用户名");
        return;
      }
      const address = sessionAddress(session);
      if (address === null) {
        await reply(session, "当前会话缺少频道或用户标识，无法管理订阅");
        return;
      }
      const parsedHandle = normalizeHandle(twitterUsername);
      if (!parsedHandle.ok) {
        await reply(session, parsedHandle.error);
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
          await reply(session, "订阅不存在");
          return;
        }
        if (!target.active) {
          await reply(session, `${target.twitter_username} 的订阅已经取消`);
          return;
        }
        await ctx.database.set(
          "x_watcher",
          {
            platform: target.platform,
            channelId: target.channelId,
            twitter_id: target.twitter_id,
          },
          { active: false, update_at: new Date() },
        );
        const remote = await remoteSyncSuffix(
          dependencies.synchronizeMonitors,
        );
        await reply(
          session,
          `已取消 ${target.twitter_username} 的订阅${remote}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`unwatch 命令失败：${message}`);
        await reply(session, "取消订阅失败，请稍后重试");
      }
    });
}

/** 注册当前频道订阅列表命令。 */
function registerListCommand(ctx: Context, logger: Logger): void {
  ctx
    .command("x-watcher.list", "查看 X/Twitter 订阅列表")
    .alias("xlist")
    .action(async ({ session }) => {
      if (session === undefined) return;
      const address = sessionAddress(session);
      if (address === null) {
        await reply(session, "当前会话缺少频道或用户标识，无法读取订阅");
        return;
      }
      try {
        const watchers = await getChannelWatchers(
          ctx,
          address.platform,
          address.channelId,
        );
        await reply(session, formatWatcherListMessage(watchers));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`xlist 命令失败：${message}`);
        await reply(session, "获取订阅列表失败，请稍后重试");
      }
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
  registerListCommand(ctx, logger);
}
