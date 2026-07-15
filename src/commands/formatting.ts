import type {
  SubscriptionApplicationError,
  UnwatchResult,
  WatchResult,
} from "../application/subscription";
import type { StoredSubscription } from "../ports/storage";

/** 将应用层错误翻译为用户可理解的中文。 */
export const formatApplicationError = (error: SubscriptionApplicationError): string => {
  switch (error._tag) {
    case "AuthorizationError":
    case "ConfigurationError":
    case "UserUnavailableError":
      return error.message;
    case "AuthenticationError":
      return `${error.provider} 认证失败，请联系插件管理员检查密钥`;
    case "RateLimitError":
      return `${error.provider} 正在限流，请稍后重试`;
    case "TransportError":
      return `${error.provider} 暂时不可用：${error.message}`;
    case "DecodeError":
      return `${error.provider} 返回了无法识别的数据，请稍后重试`;
    case "PersistenceError":
      return `订阅数据库操作失败：${error.message}`;
  }
};

/** 根据 watch 的成功结果生成回复。 */
export const formatWatchResult = (result: WatchResult): string => {
  const action = result.outcome === "created"
    ? "已创建"
    : result.outcome === "reactivated" ? "已重新启用" : "已更新";
  const subscription = result.subscription;
  const filter = subscription.filterPattern === null ? "无" : subscription.filterPattern;
  const baseline = result.baselinePending ? "\n基线：等待数据源恢复后初始化（不会补历史）" : "";
  return [
    `${action} @${subscription.account.handle} 的动态订阅`,
    `类型：${subscription.kinds.join(", ")}`,
    `过滤：${filter}`,
    `媒体：${subscription.includeMedia ? "包含" : "不含"}`,
    `同步：${subscription.remoteStatus}`,
  ].join("\n") + baseline;
};

/** 根据 unwatch 的结果生成回复。 */
export const formatUnwatchResult = (result: UnwatchResult): string => {
  switch (result._tag) {
    case "NotFound":
      return "当前频道没有该用户的订阅";
    case "AlreadyInactive":
      return `@${result.subscription.account.handle} 的订阅已经停用`;
    case "Disabled":
      return `已停用 @${result.subscription.account.handle} 的动态订阅`;
  }
};

/** 将单条订阅渲染为列表文本。 */
const formatSubscriptionLine = (subscription: StoredSubscription): string => {
  const state = subscription.active ? "订阅中" : "已停用";
  const filter = subscription.filterPattern === null ? "无" : subscription.filterPattern;
  const error = subscription.account.lastError === null
    ? []
    : [`提示=${subscription.account.lastError}`];
  return [
    `@${subscription.account.handle}（${state}）`,
    `创建者=${subscription.creatorId}`,
    `类型=${subscription.kinds.join(",")}`,
    `过滤=${filter}${subscription.filterStatus === "invalid" ? " [规则错误]" : ""}`,
    `媒体=${subscription.includeMedia ? "是" : "否"}`,
    `账号=${subscription.account.status}`,
    `同步=${subscription.remoteStatus}`,
    ...error,
  ].join(" | ");
};

/** 将频道订阅列表渲染为易读文本。 */
export const formatSubscriptionList = (
  subscriptions: ReadonlyArray<StoredSubscription>,
): string =>
  subscriptions.length === 0
    ? "当前频道没有符合条件的 X/Twitter 订阅"
    : `当前频道的 X/Twitter 订阅：\n${subscriptions.map(formatSubscriptionLine).join("\n")}`;
