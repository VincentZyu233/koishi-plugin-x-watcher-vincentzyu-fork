import Element from "@satorijs/element";
import type { XActivity } from "./domain";
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

/** 按旧版 -m 语义构造图片和 GIF 元素，视频只保留原文链接。 */
function mediaElements(activity: XActivity, includeMedia: boolean): Element[] {
  if (!includeMedia) return [];
  const elements: Element[] = [];
  for (const media of activity.media) {
    if (media.kind === "video") continue;
    elements.push(Element("img", { src: media.url }));
  }
  return elements;
}

/** 构造可由 Koishi 适配器发送的图文混排消息。 */
export function formatActivityMessage(
  activity: XActivity,
  includeMedia: boolean,
): string {
  const medias = mediaElements(activity, includeMedia);
  const text = cleanActivityText(activity.text);
  const title = Element(
    "p",
    `${activity.fullname} (@${activity.username}) ${activityAction(activity)}：`,
  );
  const time = Element(
    "p",
    `发布时间：${formatActivityTime(activity.createdAt)}`,
  );
  const body = Element("p", text);
  const link = Element("a", { href: activity.url }, "原文链接");
  return Element("message", title, time, body, ...medias, link).toString();
}

/** 格式化当前频道的订阅列表。 */
export function formatWatcherListMessage(
  watchers: ReadonlyArray<WatcherRecord>,
): string {
  if (watchers.length === 0) return "当前没有订阅任何 X/Twitter 用户";
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
  return `当前订阅的 X/Twitter 用户：\n${header}\n${rows.join("\n")}`;
}
