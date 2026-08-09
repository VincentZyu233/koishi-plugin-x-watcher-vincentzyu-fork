import { describe, expect, it } from "vitest";
import { Config } from "../src/config";

// describe("插件配置", () => {
//   it("只填写 Rettiwt API Key 池时补齐默认 provider 和 mode", () => {
//     // @ts-expect-error Schema 输入允许省略会在解码阶段补齐的判别字段
//     expect(Config({ apiKeys: ["key-a", "key-b"] })).toEqual({
//       provider: "rettiwt",
//       mode: "polling",
//       apiKeys: ["key-a", "key-b"],
//       interval: 5,
//     });
//   });
//
//   it("接受三种判别联合并为 interval 提供默认值", () => {
//     // @ts-expect-error Schema 输入允许省略有默认值的 interval
//     expect(Config({
//       provider: "rettiwt",
//       mode: "polling",
//       apiKeys: ["key-a", "key-b"],
//     })).toEqual({
//       provider: "rettiwt",
//       mode: "polling",
//       apiKeys: ["key-a", "key-b"],
//       interval: 5,
//     });
//     // @ts-expect-error Schema 输入允许省略默认的 polling mode
//     expect(Config({
//       provider: "twitterapiio",
//       apiKey: "key",
//       interval: 2,
//     })).toMatchObject({ provider: "twitterapiio", mode: "polling" });
//     expect(Config({
//       provider: "twitterapiio",
//       mode: "websocket",
//       apiKey: "key",
//       interval: 3,
//     })).toMatchObject({ provider: "twitterapiio", mode: "websocket" });
//   });
//
//   it("拒绝旧 auth_key、非法模式和小于一分钟的间隔", () => {
//     // @ts-expect-error 故意验证已删除的旧配置
//     expect(() => Config({ auth_key: "legacy", interval: 5 })).toThrow();
//     expect(() => Config({
//       provider: "rettiwt",
//       // @ts-expect-error 故意验证 Rettiwt 不支持 websocket
//       mode: "websocket",
//       apiKeys: ["key"],
//       interval: 5,
//     })).toThrow();
//     expect(() => Config({
//       provider: "twitterapiio",
//       mode: "polling",
//       apiKey: "key",
//       interval: 0,
//     })).toThrow();
//   });
// });

const decodeConfig = Config as (input: unknown) => unknown;

describe("插件配置（仅 Rettiwt）", () => {
  it("只填写 Rettiwt API Key 池时补齐默认配置", () => {
    expect(Config({ apiKeys: ["key-a", "key-b"] })).toEqual({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["key-a", "key-b"],
      interval: 5,
      proxy: {
        enabled: false,
        url: "http://127.0.0.1:7890",
      },
    });
  });

  it("接受显式 Rettiwt 轮询配置", () => {
    expect(Config({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["key"],
      interval: 2,
    })).toEqual({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["key"],
      interval: 2,
      proxy: {
        enabled: false,
        url: "http://127.0.0.1:7890",
      },
    });
  });

  it("接受显式 HTTP 代理配置", () => {
    expect(Config({
      apiKeys: ["key"],
      proxy: {
        enabled: true,
        url: "http://127.0.0.1:7890",
      },
    })).toMatchObject({
      proxy: {
        enabled: true,
        url: "http://127.0.0.1:7890",
      },
    });
  });

  it("拒绝 TwitterAPI.io、旧配置和非法 Rettiwt 参数", () => {
    expect(() => decodeConfig({
      provider: "twitterapiio",
      mode: "polling",
      apiKey: "key",
      interval: 5,
    })).toThrow();
    expect(() => decodeConfig({
      provider: "twitterapiio",
      mode: "websocket",
      apiKey: "key",
      interval: 5,
    })).toThrow();
    expect(() => decodeConfig({ auth_key: "legacy", interval: 5 })).toThrow();
    expect(() => decodeConfig({
      provider: "rettiwt",
      mode: "websocket",
      apiKeys: ["key"],
      interval: 5,
    })).toThrow();
    expect(() => decodeConfig({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["key"],
      interval: 0,
    })).toThrow();
  });
});
