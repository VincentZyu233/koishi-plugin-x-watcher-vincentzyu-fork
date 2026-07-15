import * as Schema from "effect/Schema";

/** TwitterAPI.io 视频或 GIF 的可播放变体。 */
export const TwitterMediaVariantSchema = Schema.Struct({
  url: Schema.optional(Schema.String),
  bitrate: Schema.optional(Schema.Number),
  content_type: Schema.optional(Schema.String),
  contentType: Schema.optional(Schema.String),
});

/** TwitterAPI.io 媒体实体结构。 */
export const TwitterMediaSchema = Schema.Union(
  Schema.String,
  Schema.Struct({
    type: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    media_url_https: Schema.optional(Schema.String),
    mediaUrl: Schema.optional(Schema.String),
    preview_image_url: Schema.optional(Schema.String),
    previewUrl: Schema.optional(Schema.String),
    variants: Schema.optional(Schema.Array(TwitterMediaVariantSchema)),
  }),
);
