import { Schema } from "koishi";

export type OutputMode = "text" | "text-media" | "card" | "card-text" | "card-text-media";
export type PushActivityType = "post" | "reply";
export type WatcherAvatarRefreshMode = "cache" | "placeholder" | "always";
export type TakumiImageFormat = "jpg" | "png" | "webp";
export type TakumiMediaLayout = "grid-2" | "column" | "grid-3";
export type TakumiMediaCrop = "none" | "mild" | "aggressive";
export const FONT_ASSET_PATH_RELATIVE_TO_BASE_DIR: ReadonlyArray<string> = [
  "data",
  "fonts",
  "LXGWWenKaiMono-Regular.ttf",
];

interface CommonConfig {
  readonly outputMode?: OutputMode;
  readonly fontAssetPathRelativeToBaseDir?: string[];
  readonly activityTypes?: PushActivityType[];
  readonly maxPostCount?: number;
  readonly maxReplyCount?: number;
  readonly latestDefaultUsername?: string;
  readonly recentDefaultUsername?: string;
  readonly recentDefaultCount?: number;
  readonly enableQuote?: boolean;
  readonly enableWaitingHint?: boolean;
  readonly watcherAvatarRefreshMode?: WatcherAvatarRefreshMode;
  readonly takumiImageFormat?: TakumiImageFormat;
  readonly takumiImageQuality?: number;
  readonly takumiMediaMaxWidth?: number;
  readonly takumiMediaMaxHeight?: number;
  readonly takumiMediaCrop?: TakumiMediaCrop;
  readonly takumiMediaLayout?: TakumiMediaLayout;
  readonly takumiImageMaxSizeMiB?: number;
  readonly enableProxy?: boolean;
  readonly proxyUrl?: string;
}

/** Rettiwt 轮询配置。 */
export interface RettiwtPollingConfig extends CommonConfig {
  readonly provider: "rettiwt";
  readonly mode: "polling";
  readonly apiKeys: string[];
  readonly interval: number;
}

/** TwitterAPI.io REST 轮询配置。 */
export interface TwitterApiPollingConfig extends CommonConfig {
  readonly provider: "twitterapiio";
  readonly mode: "polling";
  readonly apiKey: string;
  readonly interval: number;
}

/** TwitterAPI.io Account Stream 配置。 */
export interface TwitterApiWebSocketConfig extends CommonConfig {
  readonly provider: "twitterapiio";
  readonly mode: "websocket";
  readonly apiKey: string;
  readonly interval: number;
}

/** 插件只允许启用一个 provider 和一种运行模式。 */
export type Config = RettiwtPollingConfig | TwitterApiPollingConfig | TwitterApiWebSocketConfig;

const IntervalSchema = Schema.number().default(5).min(1).description("⏱️ 检查间隔（分钟）");

const TwitterApiKeySchema = Schema.string()
  .role("secret")
  .min(1)
  .description("🔑 TwitterAPI.io API Key")
  .required();

const OutputModeSchema = Schema.union([
  Schema.const("text").description("📝 纯文本"),
  Schema.const("text-media").description("📝📎 文本＋图片附件"),
  Schema.const("card").description("🖼️ Takumi 图片卡片"),
  Schema.const("card-text").description("🖼️📝 Takumi 图片＋文本"),
  Schema.const("card-text-media").description("🖼️📝📎 Takumi 图片＋文本＋图片附件"),
]).role("radio").default("card-text")
  .description("🖼️ 消息输出模式；附件由插件下载后发送，不依赖协议端访问 X");

const ActivityTypesSchema = Schema.array(Schema.union([
  Schema.const("post").description("📰 推文"),
  Schema.const("reply").description("💬 回复"),
]))
  .role("checkbox")
  .default(["post", "reply"])
  .description("📨 自动推送的动态类型；引用和转推仍由 watch 命令的独立选项控制");

const WatcherAvatarRefreshModeSchema = Schema.union([
  Schema.const("cache").description("💾 缺失时补查并缓存（默认）"),
  Schema.const("placeholder").description("🔤 仅使用缓存，缺失时显示首字母"),
  Schema.const("always").description("🔄 每次列表时刷新头像"),
])
  .role("radio")
  .default("cache")
  .description("🧑‍🖼️ xlist 头像缺失或更新时的处理方式");

const TakumiImageFormatSchema = Schema.union([
  Schema.const("jpg").description("📷 JPG（默认，可压缩）"),
  Schema.const("png").description("🖼️ PNG（无损）"),
  Schema.const("webp").description("🌐 WebP"),
])
  .role("radio")
  .default("jpg")
  .description("📸 Takumi 图片输出格式；JPG 默认可明显减小 OneBot 上传体积");

/** Koishi 控制台使用的判别联合配置。 */
// export const Config: Schema<Config> = Schema.union([
//   Schema.object({
//     // Koishi 的联合表单不会替隐藏的 const 字段自动写值，因此默认分支必须在解码时补齐判别字段。
//     provider: Schema.const("rettiwt").default("rettiwt"),
//     mode: Schema.const("polling").default("polling"),
//     apiKeys: Schema.array(Schema.string().role("secret").min(1))
//       .min(1)
//       .description("🍪 Rettiwt Cookie API Key 池")
//       .required(),
//     interval: IntervalSchema,
//   }).description("🔄 Rettiwt 轮询"),
//   Schema.object({
//     provider: Schema.const("twitterapiio").default("twitterapiio"),
//     mode: Schema.const("polling").default("polling"),
//     apiKey: TwitterApiKeySchema,
//     interval: IntervalSchema,
//   }).description("🌐 TwitterAPI.io REST 轮询"),
//   Schema.object({
//     provider: Schema.const("twitterapiio").default("twitterapiio"),
//     mode: Schema.const("websocket").required(),
//     apiKey: TwitterApiKeySchema,
//     interval: IntervalSchema,
//   }).description("📡 TwitterAPI.io Account Stream"),
// ]).description("🧭 选择数据源");

export const Config = Schema.intersect([
  Schema.object({
    enableQuote: Schema.boolean()
      .default(true)
      .description("💬 指令触发的所有回复是否引用触发消息；主动订阅推送不引用"),
    enableWaitingHint: Schema.boolean()
      .default(true)
      .description("⏳ xlatest 和 xrecent 查询及渲染期间是否显示等待提示"),
    outputMode: OutputModeSchema,
  }).description("💬 消息设置"),
  Schema.object({
    recentDefaultUsername: Schema.string()
      .pattern(/^[A-Za-z0-9_]{1,15}$/)
      .default("OpenAI")
      .description("🔎 xrecent 省略用户名时查询的账号（不含 @）：[https://x.com/OpenAI](https://x.com/OpenAI)"),
    recentDefaultCount: Schema.number()
      .min(1)
      .max(50)
      .step(1)
      .default(5)
      .description("🔢 xrecent 默认每类获取数量；表示推文和回复各取此数量，必须是 1～50 的整数"),
    latestDefaultUsername: Schema.string()
      .pattern(/^[A-Za-z0-9_]{1,15}$/)
      .default("amsrntk3")
      .description("👤 xlatest 省略用户名时查询的账号（不含 @）：[https://x.com/amsrntk3](https://x.com/amsrntk3)"),
  }).description("🔎 即时查询设置"),
  Schema.object({
    // Koishi 的联合表单不会替隐藏的 const 字段自动写值，因此默认分支必须在解码时补齐判别字段。
    provider: Schema.const("rettiwt").default("rettiwt"),
    mode: Schema.const("polling").default("polling"),
    apiKeys: Schema.array(Schema.string().role("secret").min(1))
      .min(1)
      .description("🍪 Rettiwt Cookie API Key 池")
      .required(),
    interval: IntervalSchema,
    activityTypes: ActivityTypesSchema,
    maxPostCount: Schema.number()
      .default(5)
      .description("📰 单轮每条订阅最多推送的最新推文数；0 或负数表示不限量"),
    maxReplyCount: Schema.number()
      .default(5)
      .description("💬 单轮每条订阅最多推送的最新回复数；0 或负数表示不限量"),
  }).description("📡 订阅设置"),
  Schema.object({
    takumiImageFormat: TakumiImageFormatSchema,
    takumiMediaMaxWidth: Schema.number().min(1).step(1).default(666)
      .description("配图最大宽度（px，正整数）；同时受卡片列宽限制"),
    takumiMediaMaxHeight: Schema.number().min(1).step(1).default(333)
      .description("配图最大高度（px，正整数）"),
    takumiMediaCrop: Schema.union([
      Schema.const("none").description("🖼️ 完全不裁剪"),
      Schema.const("mild").description("✂️ 轻微裁剪"),
      Schema.const("aggressive").description("🔲 激进裁剪"),
    ]).role("radio").default("mild")
      .description("裁剪方式：完全不裁剪保留完整画面；轻微裁剪居中且最多损失 15% 面积，允许不铺满；前两者不放大小图。激进裁剪居中填满图片框，允许放大且不限制裁剪量"),
    takumiMediaLayout: Schema.union([
      Schema.const("grid-2").description("↔️ 两列网格"),
      Schema.const("column").description("⬇️ 单列纵排"),
      Schema.const("grid-3").description("🔳 三列网格"),
    ]).role("radio").default("grid-2")
      .description("多图排列方式；从左到右、从上到下，末行不足时靠左"),
    takumiImageMaxSizeMiB: Schema.number().min(0.01).default(5)
      .description("📦 每张卡片和图片附件的大小上限（MiB），不是整条消息上限；超限时使用 FFmpeg 转为 JPEG 压缩"),
    takumiImageQuality: Schema.number()
      .min(0)
      .max(100)
      .step(1)
      .default(50)
      .description("🎚️ JPG 输出质量（0～100）；PNG 和 WebP 下当前 Takumi WASM 会忽略此值"),
    fontAssetPathRelativeToBaseDir: Schema.array(Schema.string().min(1))
      .role("table")
      .default([...FONT_ASSET_PATH_RELATIVE_TO_BASE_DIR])
      .disabled()
      .description("🔤 Takumi 字体路径片段；相对于 Koishi 根目录 ctx.baseDir，仅供查看且不允许修改"),
    watcherAvatarRefreshMode: WatcherAvatarRefreshModeSchema,
  }).description("🖼️ 图片渲染设置"),
  Schema.object({
    enableProxy: Schema.boolean().default(false).description("🔌 启用插件代理"),
    proxyUrl: Schema.string()
      .default("http://127.0.0.1:7890")
      .description("🌐 代理服务器地址，同时用于 Rettiwt 与 Node fetch"),
  }).description("🛡️ 代理设置"),
]);
