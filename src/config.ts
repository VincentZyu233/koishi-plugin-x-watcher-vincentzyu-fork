import { Schema } from "koishi";

/** TwitterAPI.io REST 轮询配置。 */
export interface TwitterApiPollingConfig {
  readonly provider: "twitterapiio";
  readonly mode: "polling";
  readonly apiKey: string;
  readonly intervalMinutes: number;
}

/** TwitterAPI.io WebSocket 配置。 */
export interface TwitterApiWebSocketConfig {
  readonly provider: "twitterapiio";
  readonly mode: "websocket";
  readonly apiKey: string;
}

/** TwitterAPI.io Webhook 配置。 */
export interface TwitterApiWebhookConfig {
  readonly provider: "twitterapiio";
  readonly mode: "webhook";
  readonly apiKey: string;
  readonly publicBaseUrl: string;
  readonly callbackToken: string;
}

/** Rettiwt 轮询配置。 */
export interface RettiwtPollingConfig {
  readonly provider: "rettiwt";
  readonly mode: "polling";
  readonly apiKeys: string[];
  readonly intervalMinutes: number;
}

/** 插件支持的完整配置联合。 */
export type Config =
  | TwitterApiPollingConfig
  | TwitterApiWebSocketConfig
  | TwitterApiWebhookConfig
  | RettiwtPollingConfig;

/** TwitterAPI.io 密钥字段。 */
const TwitterApiKeySchema = Schema.string()
  .role("secret")
  .min(1)
  .description("TwitterAPI.io API Key")
  .required();

/** 轮询间隔字段。 */
const IntervalSchema = Schema.number()
  .default(5)
  .min(1)
  .description("轮询间隔（分钟）");

/** 插件的 Koishi 配置 Schema。 */
export const Config = Schema.union([
  Schema.object({
    provider: Schema.const("twitterapiio").required(),
    mode: Schema.const("polling").required(),
    apiKey: TwitterApiKeySchema,
    intervalMinutes: IntervalSchema,
  }).description("TwitterAPI.io REST 轮询"),
  Schema.object({
    provider: Schema.const("twitterapiio").required(),
    mode: Schema.const("websocket").required(),
    apiKey: TwitterApiKeySchema,
  }).description("TwitterAPI.io Account Stream WebSocket"),
  Schema.object({
    provider: Schema.const("twitterapiio").required(),
    mode: Schema.const("webhook").required(),
    apiKey: TwitterApiKeySchema,
    publicBaseUrl: Schema.string().description("可公网访问的 HTTPS 根地址").required(),
    callbackToken: Schema.string()
      .role("secret")
      .min(43)
      .description("至少 32 随机字节的 Base64URL 回调令牌")
      .required(),
  }).description("TwitterAPI.io Account Stream Webhook"),
  Schema.object({
    provider: Schema.const("rettiwt").required(),
    mode: Schema.const("polling").required(),
    apiKeys: Schema.array(Schema.string().role("secret").min(1))
      .min(1)
      .description("Rettiwt Cookie API Key 池")
      .required(),
    intervalMinutes: IntervalSchema,
  }).description("Rettiwt 实验性轮询"),
]);

/** 返回当前配置选择的数据源名称。 */
export const providerLabel = (config: Config): string =>
  config.provider === "twitterapiio" ? "TwitterAPI.io" : "Rettiwt";
