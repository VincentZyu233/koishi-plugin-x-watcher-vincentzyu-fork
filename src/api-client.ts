import { Rettiwt } from "rettiwt-api";
import { logger } from ".";

// 创建单例 rettiwt 实例
let rettiwt: Rettiwt | null = null;

/**
 * 获取或创建 Rettiwt API 客户端实例
 * @param auth_key 推特API密钥
 * @returns Rettiwt 实例
 */
export function getRettiwt(auth_key: string): Rettiwt {
  if (!rettiwt) {
    try {
      rettiwt = new Rettiwt({
        apiKey: auth_key,
      });
      logger.info("Rettiwt 实例初始化成功");
    } catch (error) {
      logger.error("Rettiwt 实例初始化失败", error);
      throw error;
    }
  }
  return rettiwt;
}

/**
 * 重置 Rettiwt 实例（用于测试或重新初始化）
 */
export function resetRettiwt(): void {
  rettiwt = null;
  logger.info("Rettiwt 实例已重置");
}
