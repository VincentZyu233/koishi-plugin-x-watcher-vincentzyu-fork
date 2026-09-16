import { describe, expect, it } from "vitest";
import {
  Config,
  type TakumiImageFormat,
  type WatcherAvatarRefreshMode,
} from "../src/config";

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
      outputMode: "card-text",
      fontAssetPathRelativeToBaseDir: ["data", "fonts", "LXGWWenKaiMono-Regular.ttf"],
      activityTypes: ["post", "reply"],
      maxPostCount: 5,
      maxReplyCount: 5,
      latestDefaultUsername: "amsrntk3",
      recentDefaultUsername: "OpenAI",
      recentDefaultCount: 5,
      enableQuote: true,
      enableWaitingHint: true,
      watcherAvatarRefreshMode: "cache",
      takumiImageFormat: "jpg",
      takumiImageQuality: 50,
      takumiMediaMaxWidth: 666,
      takumiMediaMaxHeight: 333,
      takumiMediaCrop: "mild",
      takumiMediaLayout: "grid-2",
      takumiImageMaxSizeMiB: 5,
      enableProxy: false,
      proxyUrl: "http://127.0.0.1:7890",
    });
  });

  it("接受显式 Rettiwt 轮询配置", () => {
    expect(Config({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["key"],
      interval: 2,
      outputMode: "card-text",
      fontAssetPathRelativeToBaseDir: ["data", "fonts", "LXGWWenKaiMono-Regular.ttf"],
      activityTypes: ["reply"],
      maxPostCount: 3,
      maxReplyCount: -1,
      latestDefaultUsername: "amsrntk3",
      recentDefaultUsername: "OpenAI",
      recentDefaultCount: 3,
      enableQuote: true,
      enableWaitingHint: false,
      watcherAvatarRefreshMode: "cache",
    })).toEqual({
      provider: "rettiwt",
      mode: "polling",
      apiKeys: ["key"],
      interval: 2,
      outputMode: "card-text",
      fontAssetPathRelativeToBaseDir: ["data", "fonts", "LXGWWenKaiMono-Regular.ttf"],
      activityTypes: ["reply"],
      maxPostCount: 3,
      maxReplyCount: -1,
      latestDefaultUsername: "amsrntk3",
      recentDefaultUsername: "OpenAI",
      recentDefaultCount: 3,
      enableQuote: true,
      enableWaitingHint: false,
      watcherAvatarRefreshMode: "cache",
      takumiImageFormat: "jpg",
      takumiImageQuality: 50,
      takumiMediaMaxWidth: 666,
      takumiMediaMaxHeight: 333,
      takumiMediaCrop: "mild",
      takumiMediaLayout: "grid-2",
      takumiImageMaxSizeMiB: 5,
      enableProxy: false,
      proxyUrl: "http://127.0.0.1:7890",
    });
  });

  it("限制 xrecent 默认每类数量为 1～50 的整数", () => {
    for (const recentDefaultCount of [0, -1, 1.5, 51]) {
      expect(() => decodeConfig({
        apiKeys: ["key"],
        recentDefaultCount,
      })).toThrow();
    }
    expect(Config({ apiKeys: ["key"], recentDefaultCount: 50 })).toMatchObject({
      recentDefaultCount: 50,
    });
  });

  it("接受 xlist 头像的三种刷新策略", () => {
    const modes: ReadonlyArray<WatcherAvatarRefreshMode> = [
      "cache",
      "placeholder",
      "always",
    ];
    for (const watcherAvatarRefreshMode of modes) {
      expect(Config({ apiKeys: ["key"], watcherAvatarRefreshMode })).toMatchObject({
        watcherAvatarRefreshMode,
      });
    }
    expect(() => decodeConfig({
      apiKeys: ["key"],
      watcherAvatarRefreshMode: "invalid",
    })).toThrow();
  });

  it("接受 Takumi 三种图片格式", () => {
    const formats: ReadonlyArray<TakumiImageFormat> = ["jpg", "png", "webp"];
    for (const takumiImageFormat of formats) {
      expect(Config({ apiKeys: ["key"], takumiImageFormat })).toMatchObject({
        takumiImageFormat,
      });
    }
    expect(() => decodeConfig({
      apiKeys: ["key"],
      takumiImageFormat: "gif",
    })).toThrow();
  });

  it("接受顶层代理配置", () => {
    expect(Config({
      apiKeys: ["key"],
      enableProxy: true,
      proxyUrl: "socks5://127.0.0.1:7890",
    })).toMatchObject({
      enableProxy: true,
      proxyUrl: "socks5://127.0.0.1:7890",
    });
  });

  it("输出模式默认为卡片加文本且拒绝无效模式", () => {
    expect(Config({ apiKeys: ["key"] })).toMatchObject({ outputMode: "card-text" });
    expect(() => Config({ apiKeys: ["key"], outputMode: "invalid" as never })).toThrow();
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
