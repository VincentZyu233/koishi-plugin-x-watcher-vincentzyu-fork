import * as Option from "effect/Option";
import type { ActivityKind, XActivity, XMedia } from "./activity";

/** 可持久化消息计划中的媒体。 */
export interface PlannedMedia {
  readonly kind: XMedia["kind"];
  readonly url: string;
  readonly previewUrl: string | null;
  readonly order: number;
}

/** 入队后不再随订阅规则变化的消息计划。 */
export interface MessagePlan {
  readonly activityId: string;
  readonly kind: ActivityKind | "recovery-summary";
  readonly title: string;
  readonly text: string;
  readonly nestedText: string | null;
  readonly permalink: string;
  readonly createdAtEpochMillis: number;
  readonly media: ReadonlyArray<PlannedMedia>;
  readonly includeMedia: boolean;
}

/** 返回动态种类对应的中文动作。 */
export const activityKindLabel = (kind: ActivityKind): string => {
  switch (kind) {
    case "post":
      return "发布了新推文";
    case "reply":
      return "发布了新回复";
    case "quote":
      return "引用了一条推文";
    case "retweet":
      return "转推了一条推文";
  }
};

/** 把规范化动态冻结成可持久化的消息计划。 */
export const createMessagePlan = (
  activity: XActivity,
  includeMedia: boolean,
): MessagePlan => {
  const nestedText = Option.match(activity.reference, {
    /** 在没有嵌套内容时返回空值。 */
    onNone: () => null,
    /** 渲染引用或转推的嵌套正文。 */
    onSome: (reference) =>
      `${reference.authorName} (@${reference.authorHandle})\n${reference.body.text}`,
  });
  const nestedMedia = Option.match(activity.reference, {
    /** 没有引用内容时不追加媒体。 */
    onNone: () => [] as ReadonlyArray<XMedia>,
    /** 引用或转推的媒体同样属于用户可见内容。 */
    onSome: (reference) => reference.body.media,
  });
  const uniqueMedia = [...activity.body.media, ...nestedMedia].filter(
    (media, index, values) =>
      values.findIndex((candidate) => candidate.url === media.url) === index,
  );
  return {
    activityId: activity.id,
    kind: activity.kind,
    title: `${activity.authorName} (@${activity.authorHandle}) ${activityKindLabel(activity.kind)}`,
    text: activity.body.text,
    nestedText,
    permalink: activity.permalink,
    createdAtEpochMillis: activity.createdAtEpochMillis,
    media: uniqueMedia.map((media, order) => ({
      kind: media.kind,
      url: media.url,
      previewUrl: Option.getOrNull(media.previewUrl),
      order,
    })),
    includeMedia,
  };
};

/** 创建超过恢复上限时的透明摘要消息。 */
export const createRecoverySummaryPlan = (
  handle: string,
  newestActivityId: string,
  createdAtEpochMillis: number,
): MessagePlan => ({
  activityId: newestActivityId,
  kind: "recovery-summary",
  title: `@${handle} 在离线期间产生了超过 20 条新动态`,
  text: "为避免大量刷屏，详细内容已跳过，订阅水位已同步到最新位置。",
  nestedText: null,
  permalink: `https://x.com/${handle}`,
  createdAtEpochMillis,
  media: [],
  includeMedia: false,
});
