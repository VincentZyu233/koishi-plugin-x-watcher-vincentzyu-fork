import Element from "@satorijs/element";
import type { XActivity, XUser } from "./domain";
import type { WatcherRecord } from "./database";

/** 返回不同动态类型对应的中文动作。 */
function activityAction(activity: XActivity): string {
  switch (activity.kind) {
    case "post":
      return "发布了新推文";
    case "reply":
      return "发布了新回复";
    case "quote":
      return "引用了推文";
    case "retweet":
      return "转推了推文";
  }
}

function activityEmoji(activity: XActivity): string {
  switch (activity.kind) {
    case "post": return "📝";
    case "reply": return "💬";
    case "quote": return "💭";
    case "retweet": return "🔁";
  }
}

/** 将动态时间固定格式化为上海时区。 */
function formatActivityTime(date: Date): string {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 清理正文末尾仅用于媒体跳转的 t.co 短链。 */
function cleanActivityText(text: string): string {
  return text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, "").trim();
}

/** 避免正则中的管道符或换行破坏 xlist 的 Markdown 表格。 */
function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** 纯文字先拼接再转义，正文中的标签不会变成消息元素。 */
export function formatActivityMessage(activity: XActivity): string {
  return Element.text([
    `${activityEmoji(activity)} ${activity.fullname} (@${activity.username}) ${activityAction(activity)}：`,
    `发布时间：${formatActivityTime(activity.createdAt)}`,
    cleanActivityText(activity.text) || "（无文字内容）",
    `原文链接：${activity.url}`,
  ].join("\n")).toString();
}

export function formatRecentActivitiesMessage(user: XUser, activities: ReadonlyArray<XActivity>): string {
  const postCount = activities.filter((activity) => activity.kind === "post").length;
  const replyCount = activities.filter((activity) => activity.kind === "reply").length;
  return Element.text([
    `🕒 ${user.fullname} (@${user.username}) 最近动态：${postCount} 条推文，${replyCount} 条回复`,
    ...activities.map((activity, index) => [
      `${activityEmoji(activity)} ${index + 1}. ${activityAction(activity)} · ${formatActivityTime(activity.createdAt)}`,
      cleanActivityText(activity.text) || "（无文字内容）",
      `原文链接：${activity.url}`,
    ].join("\n")),
  ].join("\n\n")).toString();
}

/** 格式化当前频道的订阅列表。 */
export function formatWatcherListMessage(
  watchers: ReadonlyArray<WatcherRecord>,
): string {
  if (watchers.length === 0) return "📋 当前没有订阅任何 X/Twitter 用户";
  const header =
    "| 订阅 | 状态 | 过滤条件 | 媒体 | 引用 | 转推 |\n" +
    "|------|------|----------|------|------|------|";
  const rows = watchers.map((watcher) => {
    const status = watcher.active ? "订阅中" : "已取消";
    const filter =
      watcher.filter_regexp === null || watcher.filter_regexp.length === 0
        ? "无"
        : escapeTableCell(watcher.filter_regexp);
    const media = watcher.media ? "包含" : "不含";
    const quote = watcher.include_quote === true ? "开启" : "关闭";
    const retweet = watcher.include_retweet === true ? "开启" : "关闭";
    return `| ${watcher.twitter_username} | ${status} | ${filter} | ${media} | ${quote} | ${retweet} |`;
  });
  return Element.text(`📋 当前订阅的 X/Twitter 用户：\n${header}\n${rows.join("\n")}`).toString();
}
