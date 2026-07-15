import { Tweet } from "rettiwt-api";
import { getRettiwt } from "./api-client";
import { logger } from ".";

/**
 * 从 twitter_username 获取 twitter_fullname 和 twitter_id
 * @param {string} twitter_username - 推特用户名
 * @param {string} auth_key - 推特API密钥
 * @returns {fullname: string, id: string,username: string} 推特用户信息
 */
export async function getTwitterUserInfo(
  twitter_username: string,
  auth_key: string
): Promise<{ fullname: string; id: string; username: string }> {
  try {
    const rettiwt = getRettiwt(auth_key);
    const user = await rettiwt.user.details(twitter_username);
    return { fullname: user.fullName, id: user.id, username: user.userName };
  } catch (error) {
    throw new Error(
      `获取推特用户名失败，请检查推特用户id是否正确，你只需要输入推特用户id，不需要输入@`
    );
  }
}

/**
 * 获取推特用户的最新推文ID
 * @param {string} twitter_id - 推特用户ID
 * @param {string} auth_key - 推特API密钥
 * @returns {string | null} 最新推文ID，如果没有推文则返回null
 */
export async function getLatestTweetId(
  twitter_id: string,
  auth_key: string
): Promise<string | null> {
  try {
    const rettiwt = getRettiwt(auth_key);
    const tweets = await rettiwt.user.timeline(twitter_id, 1);

    if (!tweets?.list?.length) {
      logger.debug(`用户 ${twitter_id} 没有推文`);
      return null;
    }

    // 使用 Snowflake ID 找到最新推文（ID 越大表示时间越新）
    const latestTweet = tweets.list.reduce((latest, current) => {
      try {
        return BigInt(current.id) > BigInt(latest.id) ? current : latest;
      } catch (error) {
        logger.warn(`比较推文ID失败: ${current.id}, ${latest.id}`, error);
        // 如果ID比较失败，尝试时间比较作为后备方案
        try {
          const currentTime = new Date(current.createdAt);
          const latestTime = new Date(latest.createdAt);
          return currentTime > latestTime ? current : latest;
        } catch (timeError) {
          logger.warn(`时间比较也失败，保持原选择`, timeError);
          return latest;
        }
      }
    });

    logger.debug(`获取到用户 ${twitter_id} 的最新推文ID: ${latestTweet.id}`);
    return latestTweet.id;
  } catch (error) {
    logger.error(`获取用户 ${twitter_id} 最新推文ID失败:`, error);
    return null;
  }
}

/**
 * 从推文对象中提取并格式化时间
 * @param tweet 推文对象
 * @returns 格式化后的时间字符串，如果无法获取时间则返回 null
 */
export function formatTweetTime(tweet: Tweet): string | null {
  try {
    const tweetDate = new Date(tweet.createdAt);

    if (tweetDate && !isNaN(tweetDate.getTime())) {
      return tweetDate.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
  } catch (error) {
    logger.warn(`格式化推文时间失败: ${tweet.id}`, error);
  }

  return null;
}
