import { Context } from "koishi";
import { getRettiwt } from "./api-client";
import { formatTweetMessage } from "./message-formatter";
import { WatcherRecord } from "./database-schema";
import { logger } from ".";
import { Tweet } from "rettiwt-api";

/**
 * 推文检查配置
 */
export interface TweetCheckerConfig {
  auth_key: string;
}

/**
 * 检查并处理新推文
 * @param ctx Koishi 上下文
 * @param config 配置
 */
export async function checkTweetUpdates(
  ctx: Context,
  config: TweetCheckerConfig
): Promise<void> {
  try {
    // 获取所有活跃的订阅
    const activeWatchers = await ctx.database.get("x_watcher", {
      active: true,
    });

    if (activeWatchers.length === 0) {
      logger.debug("没有活跃的订阅");
      return;
    }

    logger.debug(`检查 ${activeWatchers.length} 个活跃订阅的推文更新`);

    const rettiwtInstance = getRettiwt(config.auth_key);

    // 按 twitter_id 分组，避免重复请求同一个用户
    const userGroups = new Map<string, WatcherRecord[]>();
    for (const watcher of activeWatchers) {
      if (!userGroups.has(watcher.twitter_id)) {
        userGroups.set(watcher.twitter_id, []);
      }
      userGroups.get(watcher.twitter_id)!.push(watcher);
    }

    logger.debug(`需要检查 ${userGroups.size} 个不同的推特用户`);

    // 遍历每个用户组，检查推文更新
    for (const [twitter_id, watchers] of userGroups) {
      try {
        logger.debug(
          `检查用户 ${watchers[0].twitter_username} (${twitter_id}) 的推文更新`
        );

        // 获取用户最新的推文； timeline 的第二个参数疑似存在bug，暂时使用 1
        const tweets = await rettiwtInstance.user.timeline(twitter_id, 1);

        if (!tweets || !tweets.list || tweets.list.length === 0) {
          logger.debug(`用户 ${watchers[0].twitter_username} 没有推文`);
          continue;
        }

        logger.debug(
          `用户 ${watchers[0].twitter_username} 获取到 ${tweets.list.length} 条推文`
        );

        // 检查每个订阅该用户的频道
        for (const watcher of watchers) {
          await processWatcherTweets(ctx, watcher, tweets.list);
        }
      } catch (userError) {
        logger.error(`检查用户 ${twitter_id} 推文时出错:`, userError);
      }
    }

    logger.debug("推文更新检查完成");
  } catch (error) {
    logger.error("检查推文更新时出错:", error);
  }
}

/**
 * 处理单个订阅者的推文更新
 * @param ctx Koishi 上下文
 * @param watcher 订阅记录
 * @param tweets 推文列表
 */
async function processWatcherTweets(
  ctx: Context,
  watcher: WatcherRecord,
  tweets: any[]
): Promise<void> {
  try {
    // 找出新推文
    let newTweets = [];

    if (!watcher.last_tweet_id) {
      // 第一次检查，只取最新的一条推文作为初始化
      newTweets = [tweets[0]];
      logger.debug(
        `初始化用户 ${watcher.twitter_username} 的最新推文ID: ${tweets[0].id}`
      );
    } else {
      // 使用推文ID的数值比较来判断新推文
      // Twitter的Snowflake ID是按时间顺序递增的，可以直接比较大小
      const lastTweetIdBigInt = BigInt(watcher.last_tweet_id);

      // 找出所有ID大于上次记录ID的推文（即更新的推文）
      newTweets = tweets.filter((tweet) => {
        try {
          return BigInt(tweet.id) > lastTweetIdBigInt;
        } catch (error) {
          logger.warn(`推文ID格式错误: ${tweet.id}`, error);
          return false;
        }
      });

      if (newTweets.length > 0) {
        logger.info(
          `用户 ${watcher.twitter_username} 发现 ${newTweets.length} 条新推文`
        );
      } else {
        logger.debug(`用户 ${watcher.twitter_username} 没有新推文`);
      }
    }

    // 推送所有新推文（按时间顺序，从旧到新）
    if (newTweets.length > 0) {
      await sendNewTweets(ctx, watcher, newTweets, tweets);
    }
  } catch (watcherError) {
    logger.error(`处理订阅 ${watcher.id} 时出错:`, watcherError);
  }
}

/**
 * 发送新推文消息
 * @param ctx Koishi 上下文
 * @param watcher 订阅记录
 * @param newTweets 新推文列表
 * @param allTweets 所有推文列表
 */
async function sendNewTweets(
  ctx: Context,
  watcher: WatcherRecord,
  newTweets: Tweet[],
  allTweets: Tweet[]
): Promise<void> {
  // 按推文ID排序，确保按时间顺序推送（从旧到新）
  // 因为Snowflake ID是递增的，所以ID小的推文更早
  const tweetsToSend = newTweets.sort((a, b) => {
    try {
      const aId = BigInt(a.id);
      const bId = BigInt(b.id);
      return aId < bId ? -1 : aId > bId ? 1 : 0;
    } catch (error) {
      logger.warn(`推文ID排序时出错: ${a.id}, ${b.id}`, error);
      return 0;
    }
  });

  for (const tweet of tweetsToSend) {
    // 只有在不是初始化时才推送消息
    if (watcher.last_tweet_id) {
      // 检查推文是否符合过滤条件
      if (!shouldSendTweet(tweet, watcher.filter_regexp)) {
        logger.debug(
          `推文 ${tweet.id} 不符合过滤条件，跳过推送: ${watcher.filter_regexp}`
        );
        continue;
      }

      // 构建推文消息
      const message = formatTweetMessage({
        tweet,
        fullname: watcher.twitter_fullname,
        username: watcher.twitter_username,
        includeMedia: watcher.media || false,
      });

      // 发送消息到对应的频道
      try {
        await ctx.bots
          .find(
            (bot) =>
              bot.platform === watcher.platform && bot.selfId === watcher.botId
          )
          .sendMessage(watcher.channelId, message);

        logger.info(
          `推文推送成功: ${watcher.platform}:${watcher.channelId} - ${tweet.id}`
        );

        // 在推文之间添加小延迟，避免消息发送过快
        if (tweetsToSend.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (sendError) {
        logger.error(
          `推送推文失败: ${watcher.platform}:${watcher.channelId} - ${tweet.id}`,
          sendError
        );
      }
    }
  }

  // 更新数据库中的最新推文ID
  await updateLatestTweetId(ctx, watcher, newTweets, allTweets);
}

/**
 * 更新最新推文ID
 * @param ctx Koishi 上下文
 * @param watcher 订阅记录
 * @param newTweets 新推文列表
 * @param allTweets 所有推文列表
 */
async function updateLatestTweetId(
  ctx: Context,
  watcher: WatcherRecord,
  newTweets: any[],
  allTweets: any[]
): Promise<void> {
  // 使用所有推文中ID最大的（即最新的）推文ID
  let latestTweetId = watcher.last_tweet_id || allTweets[0].id;

  // 如果有新推文，找出其中ID最大的作为最新ID
  if (newTweets.length > 0) {
    try {
      latestTweetId = newTweets.reduce((latest, current) => {
        try {
          return BigInt(current.id) > BigInt(latest.id) ? current : latest;
        } catch (error) {
          logger.warn(`比较推文ID时出错: ${current.id}, ${latest.id}`, error);
          return latest;
        }
      }).id;
    } catch (error) {
      logger.warn(`查找最新推文ID时出错`, error);
      // 如果出错，使用原始列表的第一个推文ID作为备选
      latestTweetId = allTweets[0].id;
    }
  } else if (!watcher.last_tweet_id) {
    // 初始化情况，使用列表中的第一个推文ID
    latestTweetId = allTweets[0].id;
  }

  await ctx.database.set(
    "x_watcher",
    { id: watcher.id },
    {
      last_tweet_id: latestTweetId,
      update_at: new Date(),
    }
  );
}

/**
 * 检查推文是否应该被推送（基于正则表达式过滤）
 * @param tweet 推文对象
 * @param filterRegexp 过滤正则表达式
 * @returns 是否应该推送
 */
function shouldSendTweet(tweet: any, filterRegexp?: string | null): boolean {
  // 如果没有设置过滤条件，则推送所有推文
  if (!filterRegexp || !filterRegexp.trim()) {
    return true;
  }

  try {
    const regex = new RegExp(filterRegexp, "i"); // 使用不区分大小写的匹配
    const tweetText = tweet.fullText || tweet.text || "";

    // 检查推文内容是否匹配正则表达式
    const matches = regex.test(tweetText);

    if (matches) {
      logger.debug(
        `推文内容匹配过滤条件: "${filterRegexp}" -> "${tweetText.substring(
          0,
          100
        )}..."`
      );
    }

    return matches;
  } catch (error) {
    logger.error(`正则表达式执行失败: ${filterRegexp}`, error);
    // 如果正则表达式执行失败，默认推送推文
    return true;
  }
}
