import * as Option from "effect/Option";
import type { ActivityBody, MediaKind, XMedia } from "../../../domain/activity";
import type { TwitterMediaSchema, TwitterTweet } from "./schema";

/** 从两个可选字段中选取第一个非空字符串。 */
export const firstNonEmptyString = (
  first: string | undefined,
  second: string | undefined,
): string | undefined => first === undefined || first.length === 0 ? second : first;

/** 从 Tweet Snowflake ID 纯函数推导创建时间。 */
const createdAtFromSnowflake = (id: string | undefined): number => {
  if (id === undefined || !/^\d+$/.test(id)) return Number.NaN;
  return Number((BigInt(id) >> 22n) + 1_288_834_974_657n);
};

/** 将 TwitterAPI.io 时间字段转换成 UTC epoch 毫秒并使用 Snowflake 兜底。 */
export const parseTwitterCreatedAt = (
  value: string | number | undefined,
  id: string | undefined,
): number => {
  if (value === undefined) return createdAtFromSnowflake(id);
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1_000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : createdAtFromSnowflake(id);
};

/** 将 TwitterAPI.io 媒体类型映射为领域类型。 */
const mapMediaKind = (value: string | undefined): MediaKind => {
  if (value === "video") return "video";
  if (value === "animated_gif" || value === "gif") return "gif";
  return "image";
};

/** 从视频变体中选择优先级最高的可播放 URL。 */
const selectVariantUrl = (
  media: Exclude<typeof TwitterMediaSchema.Type, string>,
): string | undefined => {
  if (media.variants === undefined) return undefined;
  const candidates = media.variants.filter(
    (variant): variant is typeof variant & { readonly url: string } =>
      variant.url !== undefined && variant.url.length > 0,
  );
  return candidates.reduce<typeof candidates[number] | undefined>((selected, candidate) => {
    if (selected === undefined) return candidate;
    const candidateType = firstNonEmptyString(candidate.content_type, candidate.contentType);
    const selectedType = firstNonEmptyString(selected.content_type, selected.contentType);
    const candidateMp4 = candidateType === "video/mp4" ? 1 : 0;
    const selectedMp4 = selectedType === "video/mp4" ? 1 : 0;
    if (candidateMp4 !== selectedMp4) return candidateMp4 > selectedMp4 ? candidate : selected;
    return (candidate.bitrate ?? 0) > (selected.bitrate ?? 0) ? candidate : selected;
  }, undefined)?.url;
};

/** 将宽松媒体实体转换为领域媒体。 */
const mapMedia = (
  media: typeof TwitterMediaSchema.Type,
  order: number,
): XMedia | null => {
  if (typeof media === "string") {
    return { kind: "image", url: media, previewUrl: Option.none(), order };
  }
  const kind = mapMediaKind(media.type);
  const directUrl = firstNonEmptyString(
    media.url,
    firstNonEmptyString(media.media_url_https, media.mediaUrl),
  );
  const previewUrl = firstNonEmptyString(media.preview_image_url, media.previewUrl);
  const url = kind === "image"
    ? firstNonEmptyString(directUrl, previewUrl)
    : firstNonEmptyString(selectVariantUrl(media), directUrl);
  if (url === undefined && previewUrl !== undefined) {
    return { kind: "image", url: previewUrl, previewUrl: Option.none(), order };
  }
  if (url === undefined || url.length === 0) return null;
  return {
    kind,
    url,
    previewUrl: Option.fromNullable(previewUrl),
    order,
  };
};

/** 提取推文实体中的展开 URL。 */
const mapUrls = (tweet: TwitterTweet): ReadonlyArray<string> => {
  if (tweet.entities === undefined || tweet.entities.urls === undefined) return [];
  return tweet.entities.urls.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    const value = firstNonEmptyString(
      entry.expanded_url,
      firstNonEmptyString(entry.expandedUrl, entry.url),
    );
    return value === undefined ? [] : [value];
  });
};

/** 提取推文媒体并保留供应商返回顺序。 */
const mapMediaList = (tweet: TwitterTweet): ReadonlyArray<XMedia> => {
  const direct = tweet.media === undefined ? [] : tweet.media;
  const extended =
    tweet.extendedEntities === undefined || tweet.extendedEntities.media === undefined
      ? []
      : tweet.extendedEntities.media;
  const mapped = [...direct, ...extended]
    .map(mapMedia)
    .filter((media): media is XMedia => media !== null);
  return mapped
    .filter(
      (media, index, values) =>
        values.findIndex((candidate) => candidate.url === media.url) === index,
    )
    .map((media, order) => ({ ...media, order }));
};

/** 将 TwitterAPI.io 推文转换为领域正文。 */
export const mapTwitterActivityBody = (tweet: TwitterTweet): ActivityBody => ({
  text: firstNonEmptyString(tweet.text, tweet.fullText) || "",
  expandedUrls: mapUrls(tweet),
  media: mapMediaList(tweet),
});
