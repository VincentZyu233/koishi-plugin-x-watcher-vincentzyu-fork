import { Context } from "koishi";
import { getTwitterUserInfo, getLatestTweetId } from "./utils";
import { formatWatcherListMessage } from "./message-formatter";
import { logger } from ".";

/**
 * 命令配置
 */
export interface CommandConfig {
  auth_key: string;
  interval: number;
}

/**
 * 注册所有命令
 * @param ctx Koishi 上下文
 * @param config 配置
 */
export function registerCommands(ctx: Context, config: CommandConfig): void {
  registerWatchCommand(ctx, config);
  registerUnwatchCommand(ctx, config);
  registerListCommand(ctx);
}

/**
 * 注册订阅命令
 * @param ctx Koishi 上下文
 * @param config 配置
 */
function registerWatchCommand(ctx: Context, config: CommandConfig): void {
  ctx
    .command("x-watcher.watch <twitter_username> [regexp:text]", "订阅博主推文")
    .option("media", "-m", { fallback: false })
    .alias("watch")
    .action(async ({ session, options }, twitter_username, regexp) => {
      try {
        // 参数验证
        if (!twitter_username || !twitter_username.trim()) {
          session.send("请提供有效的推特用户名");
          return;
        }

        // 验证正则表达式
        let filterRegexp: string | null = null;
        if (regexp && regexp.trim()) {
          try {
            new RegExp(regexp.trim());
            filterRegexp = regexp.trim();
          } catch (error) {
            session.send(`正则表达式格式错误: ${error.message}`);
            return;
          }
        }

        // 解析聊天类型和id
        const { platform, channelId, userId } = session;

        // 获取推特用户名
        let twitter_info: { fullname: string; id: string; username: string };
        try {
          twitter_info = await getTwitterUserInfo(
            twitter_username,
            config.auth_key
          );
        } catch (error) {
          session.send(`${error}`);
          return;
        }

        // 数据库操作
        try {
          // 检查订阅是否存在
          const watchers = await ctx.database.get("x_watcher", {
            twitter_id: twitter_info.id,
            platform: platform,
            channelId: channelId,
          });

          if (watchers.length === 0) {
            // 没有订阅，则添加订阅
            // 获取最新推文ID
            let latestTweetId: string | null = null;
            try {
              latestTweetId = await getLatestTweetId(
                twitter_info.id,
                config.auth_key
              );
            } catch (error) {
              logger.warn(
                `获取用户 ${twitter_info.username} 最新推文ID失败，将在后续检查中初始化:`,
                error
              );
            }

            await ctx.database.create("x_watcher", {
              platform: platform,
              channelId: channelId,
              userId: userId,
              botId: session.bot.selfId,
              twitter_username: twitter_info.username,
              twitter_id: twitter_info.id,
              twitter_fullname: twitter_info.fullname,
              last_tweet_id: latestTweetId,
              filter_regexp: filterRegexp,
              media: options.media || false,
              active: true,
              create_at: new Date(),
              update_at: new Date(),
            });

            const filterInfo = filterRegexp
              ? `\n过滤条件: ${filterRegexp}`
              : "";
            const mediaInfo = options.media ? "\n媒体: 包含" : "\n媒体: 不含";
            session.send(
              `已添加 ${twitter_info.fullname} 的推文订阅，将在 ${twitter_info.fullname} 发布推文后的${config.interval}分钟内转发到此处${filterInfo}${mediaInfo}`
            );
            return;
          } else if (!watchers[0].active) {
            // 已存在订阅但未激活，则激活订阅并更新用户名
            // 获取最新推文ID
            let latestTweetId: string | null = watchers[0].last_tweet_id;
            try {
              const newLatestTweetId = await getLatestTweetId(
                twitter_info.id,
                config.auth_key
              );
              if (newLatestTweetId) {
                latestTweetId = newLatestTweetId;
              }
            } catch (error) {
              logger.warn(
                `获取用户 ${twitter_info.username} 最新推文ID失败，使用原有ID:`,
                error
              );
            }

            await ctx.database.set(
              "x_watcher",
              {
                twitter_id: twitter_info.id,
                platform: platform,
                channelId: channelId,
              },
              {
                twitter_username: twitter_info.username,
                twitter_fullname: twitter_info.fullname,
                last_tweet_id: latestTweetId,
                filter_regexp: filterRegexp,
                media: options.media || false,
                active: true,
                update_at: new Date(),
              }
            );
            const filterInfo = filterRegexp
              ? `\n过滤条件: ${filterRegexp}`
              : "";
            const mediaInfo = options.media ? "\n媒体: 包含" : "\n媒体: 不含";
            session.send(
              `已重新订阅 ${twitter_info.fullname}${filterInfo}${mediaInfo}`
            );
            return;
          } else {
            // 已存在订阅且已激活，更新用户名
            await ctx.database.set(
              "x_watcher",
              {
                twitter_id: twitter_info.id,
                platform: platform,
                channelId: channelId,
              },
              {
                twitter_username: twitter_info.username,
                twitter_fullname: twitter_info.fullname,
                filter_regexp: filterRegexp,
                media: options.media || false,
                active: true,
                update_at: new Date(),
              }
            );
            const filterInfo = filterRegexp
              ? `\n过滤条件: ${filterRegexp}`
              : "";
            const mediaInfo = options.media ? "\n媒体: 包含" : "\n媒体: 不含";
            session.send(
              `已更新订阅 ${twitter_info.fullname}${filterInfo}${mediaInfo}`
            );
            return;
          }
        } catch (error) {
          logger.error("数据库操作失败", error);
          session.send(
            "由于内部错误而订阅失败，这并非您的原因，请联系开发者或等待修复"
          );
          return;
        }
      } catch (error) {
        logger.error("订阅命令执行失败", error);
        session.send("命令执行失败，请稍后重试");
        return;
      }
    });
}

/**
 * 注册取消订阅命令
 * @param ctx Koishi 上下文
 * @param config 配置
 */
function registerUnwatchCommand(ctx: Context, config: CommandConfig): void {
  ctx
    .command("x-watcher.unwatch <twitter_username>", "取消订阅博主推文")
    .alias("unwatch")
    .action(async ({ session }, twitter_username) => {
      try {
        // 参数验证
        if (!twitter_username || !twitter_username.trim()) {
          session.send("请提供有效的推特用户名");
          return;
        }

        const { platform, channelId } = session;

        let twitter_info: { fullname: string; id: string; username: string };
        try {
          twitter_info = await getTwitterUserInfo(
            twitter_username,
            config.auth_key
          );
        } catch (error) {
          logger.error("获取推特用户信息失败", error);
          return;
        }

        try {
          // 检查订阅是否存在
          const watchers = await ctx.database.get("x_watcher", {
            twitter_id: twitter_info.id,
            platform: platform,
            channelId: channelId,
          });

          if (watchers.length === 0) {
            session.send("订阅不存在");
            return;
          }

          const watcher = watchers[0];
          if (!watcher.active) {
            session.send(`${watcher.twitter_username} 的订阅已经是取消状态`);
            return;
          }

          // 取消激活状态
          await ctx.database.set(
            "x_watcher",
            {
              platform: platform,
              channelId: channelId,
              twitter_id: twitter_info.id,
            },
            {
              twitter_fullname: twitter_info.fullname,
              twitter_username: twitter_info.username,
              active: false,
              update_at: new Date(),
            }
          );

          session.send(`已取消 ${watcher.twitter_username} 的推文订阅`);
        } catch (error) {
          logger.error("数据库操作失败", error);
          session.send(
            "由于内部错误而取消订阅失败，这并非您的原因，请联系开发者或等待修复"
          );
        }
      } catch (error) {
        logger.error("取消订阅命令执行失败", error);
        session.send("命令执行失败，请稍后重试");
      }
    });
}

/**
 * 注册查看订阅列表命令
 * @param ctx Koishi 上下文
 */
function registerListCommand(ctx: Context): void {
  ctx
    .command("x-watcher.list", "查看推特订阅列表")
    .alias("xlist")
    .action(async ({ session }) => {
      try {
        const { platform, channelId } = session;

        try {
          const watchers = await ctx.database.get("x_watcher", {
            platform: platform,
            channelId: channelId,
          });

          const message = formatWatcherListMessage(watchers);
          session.send(message);
        } catch (error) {
          logger.error("数据库操作失败", error);
          session.send(
            "由于内部错误而获取订阅列表失败，这并非您的原因，请联系开发者或等待修复"
          );
        }
      } catch (error) {
        logger.error("查看订阅列表命令执行失败", error);
        session.send("命令执行失败，请稍后重试");
      }
    });
}
