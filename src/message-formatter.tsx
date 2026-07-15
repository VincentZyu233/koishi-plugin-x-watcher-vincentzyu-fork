import { MediaType, Tweet, TweetMedia } from "rettiwt-api";
import { formatTweetTime } from "./utils";
import Element from "@satorijs/element";

/**
 * 推文消息格式化选项
 */
export interface TweetMessageOptions {
  /** 推文对象 */
  tweet: Tweet;
  /** 推特用户全名 */
  fullname: string;
  /** 推特用户名 */
  username: string;
  /** 是否包含媒体附件 */
  includeMedia?: boolean;
}

/**
 * 格式化推文消息
 * @param options 消息格式化选项
 * @returns 格式化后的消息字符串
 */
export function formatTweetMessage(options: TweetMessageOptions): string {
  const { tweet, fullname, username, includeMedia = false } = options;

  // 构建推文URL
  const tweetUrl = `https://twitter.com/${username}/status/${tweet.id}`;

  // 获取并格式化时间
  const tweetTime = formatTweetTime(tweet);
  const timeStr = tweetTime ? `\n发布时间: ${tweetTime}` : "";

  // 构建媒体信息
  let medias: Element[];
  if (includeMedia && tweet.media && tweet.media.length > 0) {
    medias = tweet.media.map((media: TweetMedia) => {
      const mediaType = media.type;
      const mediaUrl = media.url;
      return mediaType === MediaType.VIDEO ? "" : <img src={mediaUrl} />;
    });
  }

  // 处理推文文本，移除末尾的 t.co 链接
  let tweetText = tweet.fullText || "";
  // 移除末尾的 https://t.co/ 链接（可能有多个）
  tweetText = tweetText.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, "").trim();

  const message = (
    <>
      <message>
        <p>
          {fullname} (@{username}) 发布了新推文:
        </p>
        <p>{timeStr}</p>
        <br />
        <p>{tweetText}</p>
        {medias}
        <a href={tweetUrl}>原文链接</a>
      </message>
    </>
  );

  return message;
}

/**
 * 格式化订阅列表消息
 * @param watchers 订阅列表
 * @returns 格式化后的订阅列表消息
 */
export function formatWatcherListMessage(watchers: any[]): string {
  if (watchers.length === 0) {
    return "当前没有订阅任何推特用户";
  }

  const tableHeader =
    "| 订阅 | 状态 | 过滤条件 | 媒体 |\n|------|------|----------|------|";
  const tableRows = watchers
    .map((watcher) => {
      const status = watcher.active ? "订阅中" : "已取消";
      const filter = watcher.filter_regexp || "无";
      const media = watcher.media ? "包含" : "不含";
      return `| ${watcher.twitter_username} | ${status} | ${filter} | ${media} |`;
    })
    .join("\n");

  return `当前订阅的推特用户：\n${tableHeader}\n${tableRows}`;
}
