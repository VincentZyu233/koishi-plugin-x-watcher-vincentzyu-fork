import { Context } from "koishi";
import { logger } from ".";

/**
 * 数据库表字段定义
 */
export const X_WATCHER_FIELDS = {
  id: "integer",
  platform: "string",
  channelId: "string",
  userId: "string",
  botId: "string",
  twitter_fullname: "string",
  twitter_username: "string",
  twitter_id: "string",
  last_tweet_id: "string",
  filter_regexp: "string", // 过滤推文内容的正则表达式（可为空）
  media: "boolean", // 是否在推送更新时附带推文的media
  active: "boolean",
  create_at: "timestamp",
  update_at: "timestamp",
} as const;

/**
 * 数据库表选项
 */
export const X_WATCHER_OPTIONS = {
  primary: "id", // 主键
  autoInc: true, // 自增主键值
} as const;

/**
 * 初始化数据库表结构
 * @param ctx Koishi 上下文
 */
export function initializeDatabase(ctx: Context): void {
  try {
    ctx.database.extend("x_watcher", X_WATCHER_FIELDS, X_WATCHER_OPTIONS);
    logger.info("数据库初始化成功");
  } catch (error) {
    logger.error("数据库初始化失败", error);
    throw error;
  }
}

/**
 * 订阅记录类型定义
 */
export interface WatcherRecord {
  id?: number;
  platform: string;
  channelId: string;
  userId: string;
  botId: string;
  twitter_fullname: string;
  twitter_username: string;
  twitter_id: string;
  last_tweet_id?: string;
  filter_regexp?: string | null; // 过滤推文内容的正则表达式（可为空）
  media?: boolean; // 是否在推送更新时附带推文的media
  active: boolean;
  create_at?: Date;
  update_at?: Date;
}

//声明数据表
declare module "koishi" {
  interface Tables {
    x_watcher: XWatcher;
  }
}
//表的接口类型
interface XWatcher {
  id: number; // 主键
  platform: string; // 平台
  channelId: string; // 推送目标id
  userId: string; // 用户id
  botId: string; // 机器人id
  twitter_fullname: string; // 监控的推特用户全名
  twitter_username: string; // 监控的推特用户名
  twitter_id: string; // 监控的推特用户id
  last_tweet_id?: string; // 监控的推特用户最后一条推文id
  filter_regexp?: string | null; // 过滤推文内容的正则表达式（可为空）
  media?: boolean; // 是否在推送更新时附带推文的media
  active: boolean; // 是否激活
  create_at: Date; // 创建时间
  update_at: Date; // 更新时间
}
