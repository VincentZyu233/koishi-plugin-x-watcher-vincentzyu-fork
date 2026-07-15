import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { Config } from "../src/config";
import { validateConfig } from "../src/config-validation";

/** 执行运行时配置校验并返回 Either。 */
const validate = (config: Config) => Effect.runSync(Effect.either(validateConfig(config)));

describe("显式 provider 配置", () => {
  it("接受合法 TwitterAPI.io polling 与 Rettiwt key 池", () => {
    expect(Either.isRight(validate({
      provider: "twitterapiio",
      mode: "polling",
      apiKey: "twitter-key",
      intervalMinutes: 5,
    }))).toBe(true);
    expect(Either.isRight(validate({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["cookie-key-1", "cookie-key-2"],
      intervalMinutes: 5,
    }))).toBe(true);
  });

  it("Webhook 只接受 HTTPS 与至少 43 字符 Base64URL token", () => {
    const base = {
      provider: "twitterapiio" as const,
      mode: "webhook" as const,
      apiKey: "twitter-key",
      callbackToken: "a".repeat(43),
    };
    expect(Either.isRight(validate({ ...base, publicBaseUrl: "https://bot.example" }))).toBe(true);
    expect(Either.isRight(validate({ ...base, publicBaseUrl: "https://bot.example/koishi/" }))).toBe(true);
    expect(Either.isLeft(validate({ ...base, publicBaseUrl: "http://bot.example" }))).toBe(true);
    expect(Either.isLeft(validate({
      ...base,
      publicBaseUrl: "https://bot.example?token=leak",
    }))).toBe(true);
    expect(Either.isLeft(validate({
      ...base,
      publicBaseUrl: "https://user:password@bot.example",
    }))).toBe(true);
    expect(Either.isLeft(validate({
      ...base,
      publicBaseUrl: "https://bot.example",
      callbackToken: "too-short",
    }))).toBe(true);
  });
});
