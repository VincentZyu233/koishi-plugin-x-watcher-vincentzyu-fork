import * as Effect from "effect/Effect";
import type { Config } from "./config";
import { ConfigurationError } from "./domain/errors";

/** 判断字符串是否为非空配置值。 */
const isNonBlank = (value: string): boolean => value.trim().length > 0;

/** 校验 Webhook 对外根地址是否使用 HTTPS。 */
const isHttpsBaseUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.search.length === 0 &&
      url.hash.length === 0;
  } catch {
    return false;
  }
};

/** 在 Koishi Schema 之外执行不可被 UI 约束表达的运行时配置校验。 */
export const validateConfig = (
  config: Config,
): Effect.Effect<void, ConfigurationError> =>
  Effect.gen(function* () {
    if (config.provider === "twitterapiio") {
      if (!isNonBlank(config.apiKey)) {
        return yield* Effect.fail(
          new ConfigurationError({ message: "TwitterAPI.io API Key 不能为空" }),
        );
      }
      if (config.mode === "webhook") {
        if (!isHttpsBaseUrl(config.publicBaseUrl)) {
          return yield* Effect.fail(
            new ConfigurationError({
              message: "Webhook publicBaseUrl 必须是不含凭据、查询或片段的 HTTPS 地址",
            }),
          );
        }
        if (!/^[A-Za-z0-9_-]{43,}$/.test(config.callbackToken)) {
          return yield* Effect.fail(
            new ConfigurationError({
              message: "Webhook callbackToken 必须是至少 43 字符的 Base64URL 随机令牌",
            }),
          );
        }
      }
      if (
        config.mode === "polling" &&
        (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1)
      ) {
        return yield* Effect.fail(
          new ConfigurationError({ message: "轮询间隔必须大于或等于 1 分钟" }),
        );
      }
      return;
    }
    if (config.apiKeys.length === 0 || config.apiKeys.some((key) => !isNonBlank(key))) {
      return yield* Effect.fail(
        new ConfigurationError({ message: "Rettiwt 至少需要一个非空 API Key" }),
      );
    }
    if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1) {
      return yield* Effect.fail(
        new ConfigurationError({ message: "轮询间隔必须大于或等于 1 分钟" }),
      );
    }
  });
