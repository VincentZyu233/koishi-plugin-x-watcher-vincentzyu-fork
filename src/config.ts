import { Schema } from "koishi";

export type OutputFormat = "image" | "text";
export type PushActivityType = "post" | "reply";
export const FONT_ASSET_PATH_RELATIVE_TO_BASE_DIR: ReadonlyArray<string> = [
  "data",
  "fonts",
  "LXGWWenKaiMono-Regular.ttf",
];

interface CommonConfig {
  readonly outputFormats?: OutputFormat[];
  readonly fontAssetPathRelativeToBaseDir?: string[];
  readonly activityTypes?: PushActivityType[];
  readonly maxPostCount?: number;
  readonly maxReplyCount?: number;
  readonly latestDefaultUsername?: string;
  readonly recentDefaultUsername?: string;
  readonly recentDefaultCount?: number;
  readonly enableQuote?: boolean;
  readonly enableWaitingHint?: boolean;
}

/** Rettiwt 轮询配置。 */
export interface RettiwtPollingConfig extends CommonConfig {
  readonly provider: "rettiwt";
  readonly mode: "polling";
  readonly apiKeys: string[];
  readonly interval: number;
  readonly proxy: ProxyConfig;
}

/** Rettiwt 与其原生 fetch 依赖共享的显式代理配置。 */
export interface ProxyConfig {
  readonly enabled: boolean;
  readonly url: string;
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

const OutputFormatsSchema = Schema.array(Schema.union([
  Schema.const("image").description("🖼️ 图片"),
  Schema.const("text").description("📝 文字"),
]))
  .role("checkbox")
  .min(1)
  .default(["image", "text"])
  .description("🖼️ 推送消息的输出格式；同时选择时在同一条消息中先图后文");

const ActivityTypesSchema = Schema.array(Schema.union([
  Schema.const("post").description("📰 推文"),
  Schema.const("reply").description("💬 回复"),
]))
  .role("checkbox")
  .default(["post", "reply"])
  .description("📨 自动推送的动态类型；引用和转推仍由 watch 命令的独立选项控制");

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
    outputFormats: OutputFormatsSchema,
  }).description("💬 消息设置"),
  Schema.object({
    fontAssetPathRelativeToBaseDir: Schema.array(Schema.string().min(1))
      .role("table")
      .default([...FONT_ASSET_PATH_RELATIVE_TO_BASE_DIR])
      .disabled()
      .description("🔤 Takumi 字体路径片段；相对于 Koishi 根目录 ctx.baseDir，仅供查看且不允许修改"),
  }).description("🖼️ 图片渲染设置"),
  Schema.object({
    recentDefaultUsername: Schema.string()
      .pattern(/^[A-Za-z0-9_]{1,15}$/)
      .default("OpenAI")
      .description("🔎 xrecent 省略用户名时查询的账号（不含 @）：[https://x.com/OpenAI](https://x.com/OpenAI)"),
    recentDefaultCount: Schema.number()
      .min(1)
      .max(50)
      .step(1)
      .default(10)
      .description("🔢 xrecent 默认每类获取数量；表示推文和回复各取此数量，必须是 1～50 的整数"),
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
      .default(10)
      .description("📰 单轮每条订阅最多推送的最新推文数；0 或负数表示不限量"),
    maxReplyCount: Schema.number()
      .default(10)
      .description("💬 单轮每条订阅最多推送的最新回复数；0 或负数表示不限量"),
    latestDefaultUsername: Schema.string()
      .pattern(/^[A-Za-z0-9_]{1,15}$/)
      .default("amsrntk3")
      .description("👤 xlatest 省略用户名时查询的账号（不含 @）：[https://x.com/amsrntk3](https://x.com/amsrntk3)"),
  }).description("📡 订阅设置"),
  Schema.object({
    proxy: Schema.object({
      enabled: Schema.boolean().default(false).description("🔌 启用显式代理"),
      url: Schema.string()
        .default("http://127.0.0.1:7890")
        .description("🌐 HTTP/HTTPS 代理地址，同时用于 Rettiwt 与 Node fetch"),
    }).default({
      enabled: false,
      url: "http://127.0.0.1:7890",
    }).description("🛡️ 代理设置"),
  }).description("🛡️ 代理设置"),
]);
