import { Schema } from "koishi";

/** Rettiwt 轮询配置。 */
export interface RettiwtPollingConfig {
  readonly provider: "rettiwt";
  readonly mode: "polling";
  readonly apiKeys: string[];
  readonly interval: number;
}

/** TwitterAPI.io REST 轮询配置。 */
export interface TwitterApiPollingConfig {
  readonly provider: "twitterapiio";
  readonly mode: "polling";
  readonly apiKey: string;
  readonly interval: number;
}

/** TwitterAPI.io Account Stream 配置。 */
export interface TwitterApiWebSocketConfig {
  readonly provider: "twitterapiio";
  readonly mode: "websocket";
  readonly apiKey: string;
  readonly interval: number;
}

/** 插件只允许启用一个 provider 和一种运行模式。 */
export type Config = RettiwtPollingConfig | TwitterApiPollingConfig | TwitterApiWebSocketConfig;

const IntervalSchema = Schema.number().default(5).min(1).description("检查间隔（分钟）");

const TwitterApiKeySchema = Schema.string()
  .role("secret")
  .min(1)
  .description("TwitterAPI.io API Key")
  .required();

/** Koishi 控制台使用的判别联合配置。 */
// export const Config: Schema<Config> = Schema.union([
//   Schema.object({
//     // Koishi 的联合表单不会替隐藏的 const 字段自动写值，因此默认分支必须在解码时补齐判别字段。
//     provider: Schema.const("rettiwt").default("rettiwt"),
//     mode: Schema.const("polling").default("polling"),
//     apiKeys: Schema.array(Schema.string().role("secret").min(1))
//       .min(1)
//       .description("Rettiwt Cookie API Key 池")
//       .required(),
//     interval: IntervalSchema,
//   }).description("Rettiwt 轮询"),
//   Schema.object({
//     provider: Schema.const("twitterapiio").default("twitterapiio"),
//     mode: Schema.const("polling").default("polling"),
//     apiKey: TwitterApiKeySchema,
//     interval: IntervalSchema,
//   }).description("TwitterAPI.io REST 轮询"),
//   Schema.object({
//     provider: Schema.const("twitterapiio").default("twitterapiio"),
//     mode: Schema.const("websocket").required(),
//     apiKey: TwitterApiKeySchema,
//     interval: IntervalSchema,
//   }).description("TwitterAPI.io Account Stream"),
// ]).description("选择数据源");

export const Config = Schema.object({
  // Koishi 的联合表单不会替隐藏的 const 字段自动写值，因此默认分支必须在解码时补齐判别字段。
  provider: Schema.const("rettiwt").default("rettiwt"),
  mode: Schema.const("polling").default("polling"),
  apiKeys: Schema.array(Schema.string().role("secret").min(1))
    .min(1)
    .description("Rettiwt Cookie API Key 池")
    .required(),
  interval: IntervalSchema,
}).description("Rettiwt 轮询");
