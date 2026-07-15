import { h, type Fragment } from "koishi";
import type { MessagePlan, PlannedMedia } from "../../domain/message";

const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** 格式化消息计划中的发布时间。 */
const formatCreatedAt = (epochMillis: number): string =>
  TIME_FORMATTER.format(new Date(epochMillis));

/** 构造动态正文及可选嵌套正文元素。 */
const renderTextElements = (plan: MessagePlan): Array<h> => {
  const nested =
    plan.nestedText === null
      ? []
      : [h("p", {}, `引用内容：\n${plan.nestedText}`)];
  return [
    h("p", {}, plan.title),
    h("p", {}, `发布时间：${formatCreatedAt(plan.createdAtEpochMillis)}`),
    h("p", {}, plan.text),
    ...nested,
  ];
};

/** 按计划顺序返回需要发送的媒体。 */
const orderedMedia = (plan: MessagePlan): ReadonlyArray<PlannedMedia> =>
  [...plan.media].sort((left, right) => left.order - right.order);

/** 将单个持久化媒体渲染为 Satori 元素。 */
const renderMedia = (media: PlannedMedia): h => {
  if (media.kind === "video" || (media.kind === "gif" && /\.mp4(?:[?#]|$)/i.test(media.url))) {
    return h.video(media.url);
  }
  return h.image(media.url);
};

/** 渲染可跨适配器转换的原文链接。 */
const renderPermalink = (plan: MessagePlan): h =>
  h("a", { href: plan.permalink }, "原文链接");

/** 构造包含正文、媒体和链接的混排消息。 */
export const renderMixedFragment = (plan: MessagePlan): Fragment => {
  const media = plan.includeMedia ? orderedMedia(plan).map(renderMedia) : [];
  return [...renderTextElements(plan), ...media, renderPermalink(plan)];
};

/** 构造可逐片恢复发送的正文、媒体和链接序列。 */
export const renderSplitFragments = (
  plan: MessagePlan,
): ReadonlyArray<Fragment> => {
  const media: ReadonlyArray<Fragment> = plan.includeMedia
    ? orderedMedia(plan).map(renderMedia)
    : [];
  return [renderTextElements(plan), ...media, renderPermalink(plan)];
};

/** 构造最终降级使用的纯文本链接消息。 */
export const renderLinkFragment = (plan: MessagePlan): Fragment =>
  `${plan.title}\n${plan.permalink}`;
