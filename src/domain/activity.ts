import * as Option from "effect/Option";
import type { ActivityId, XHandle, XUserId } from "./identifiers";

/** 插件支持的 X/Twitter 动态种类。 */
export const ActivityKinds = ["post", "reply", "quote", "retweet"] as const;

/** 插件支持的 X/Twitter 动态种类。 */
export type ActivityKind = (typeof ActivityKinds)[number];

/** 新订阅在未显式指定时启用的动态种类。 */
export const DefaultActivityKinds: ReadonlyArray<ActivityKind> = ["post", "reply"];

/** 插件支持的媒体种类。 */
export type MediaKind = "image" | "gif" | "video";

/** 规范化后的媒体附件。 */
export interface XMedia {
  readonly kind: MediaKind;
  readonly url: string;
  readonly previewUrl: Option.Option<string>;
  readonly order: number;
}

/** 规范化后的动态正文。 */
export interface ActivityBody {
  readonly text: string;
  readonly expandedUrls: ReadonlyArray<string>;
  readonly media: ReadonlyArray<XMedia>;
}

/** 引用或转推的嵌套内容。 */
export interface ActivityReference {
  readonly kind: "quote" | "retweet";
  readonly activityId: ActivityId;
  readonly authorHandle: XHandle;
  readonly authorName: string;
  readonly body: ActivityBody;
  readonly permalink: string;
}

/** 与数据源无关的 X/Twitter 动态。 */
export interface XActivity {
  readonly id: ActivityId;
  readonly authorId: XUserId;
  readonly authorHandle: XHandle;
  readonly authorName: string;
  readonly kind: ActivityKind;
  readonly createdAtEpochMillis: number;
  readonly body: ActivityBody;
  readonly replyToId: Option.Option<ActivityId>;
  readonly reference: Option.Option<ActivityReference>;
  readonly permalink: string;
}

/** 判断字符串是否为受支持的动态种类。 */
export const isActivityKind = (input: string): input is ActivityKind =>
  ActivityKinds.some((kind) => kind === input);

/** 解析逗号分隔的动态种类并去重。 */
export const parseActivityKinds = (
  input: string,
): ReadonlyArray<ActivityKind> | string => {
  const values = input
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
  if (values.length === 0) return "至少选择一种动态类型";
  const invalid = values.find((value) => !isActivityKind(value));
  if (invalid !== undefined) return `不支持的动态类型：${invalid}`;
  return Array.from(new Set(values.filter(isActivityKind)));
};

/** 构造正则过滤使用的完整可见文本。 */
export const buildSearchableText = (activity: XActivity): string => {
  const own = [activity.body.text, ...activity.body.expandedUrls];
  if (Option.isNone(activity.reference)) return own.join("\n");
  const nested = activity.reference.value;
  return [
    ...own,
    nested.authorName,
    `@${nested.authorHandle}`,
    nested.body.text,
    ...nested.body.expandedUrls,
  ].join("\n");
};

/** 按 Snowflake ID 对动态进行稳定升序排列。 */
export const sortActivitiesOldestFirst = (
  activities: ReadonlyArray<XActivity>,
): ReadonlyArray<XActivity> =>
  [...activities].sort((left, right) => {
    if (left.id.length !== right.id.length) return left.id.length - right.id.length;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

/** 按动态 ID 去重并保留首次出现的规范化结果。 */
export const deduplicateActivities = (
  activities: ReadonlyArray<XActivity>,
): ReadonlyArray<XActivity> => {
  const seen = new Set<string>();
  return activities.filter((activity) => {
    if (seen.has(activity.id)) return false;
    seen.add(activity.id);
    return true;
  });
};
