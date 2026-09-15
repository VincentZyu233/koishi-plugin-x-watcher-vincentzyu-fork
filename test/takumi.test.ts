import { resolve } from "node:path";
import { Context, Logger } from "@koishijs/core";
import { describe, expect, it } from "vitest";
import { createTakumiRenderer } from "../src/render/takumi";

function renderingContext(): Context {
  const ctx = new Context();
  Object.defineProperty(ctx, "baseDir", {
    value: resolve(__dirname, "../../.."),
  });
  return ctx;
}

function expectPng(buffer: Buffer): void {
  expect(buffer.length).toBeGreaterThan(10_000);
  expect([...buffer.subarray(0, 8)]).toEqual([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
}

function pngHeight(buffer: Buffer): number {
  return buffer.readUInt32BE(20);
}

function pageAt(pages: ReadonlyArray<Buffer>, index: number): Buffer {
  const page = pages[index];
  if (page === undefined) throw new Error(`缺少第 ${index + 1} 页`);
  return page;
}

describe("Takumi WASM 图片渲染", () => {
  it("渲染 X 风格推文卡片", async () => {
    const renderer = createTakumiRenderer(
      renderingContext(),
      new Logger("takumi-test"),
    );
    const image = await renderer.renderActivity({
      id: "2099756963429245110",
      authorId: "42",
      username: "thsottiaux",
      fullname: "Tibo",
      kind: "reply",
      text: "@jxnlco bet\nMidnight coding is the best coding.",
      createdAt: new Date("2026-09-15T07:07:26.000Z"),
      url: "https://x.com/thsottiaux/status/2099756963429245110",
      media: [],
    });
    expectPng(image);
  });

  it("渲染频道订阅表格", async () => {
    const renderer = createTakumiRenderer(
      renderingContext(),
      new Logger("takumi-test"),
    );
    const now = new Date("2026-09-15T07:07:26.000Z");
    const image = await renderer.renderWatcherList([{
      id: 1,
      platform: "test",
      channelId: "channel",
      userId: "operator",
      botId: "bot",
      twitter_fullname: "Tibo",
      twitter_username: "thsottiaux",
      twitter_id: "42",
      last_tweet_id: "2099756963429245110",
      filter_regexp: "release|model",
      media: true,
      include_quote: false,
      include_retweet: false,
      active: true,
      enabled_at: now,
      create_at: now,
      update_at: now,
    }]);
    expectPng(image);
  });

  it("最近动态每十条分页并支持多媒体占位宫格", async () => {
    const renderer = createTakumiRenderer(
      renderingContext(),
      new Logger("takumi-test"),
    );
    const activities = Array.from({ length: 11 }, (_value, index) => ({
      id: String(500 - index),
      authorId: "42",
      username: "OpenAI",
      fullname: "OpenAI",
      kind: index % 2 === 0 ? "post" as const : "reply" as const,
      text: `recent activity ${index}`,
      createdAt: new Date("2026-09-15T07:07:26.000Z"),
      url: `https://x.com/OpenAI/status/${500 - index}`,
      media: Array.from({ length: index < 4 ? index + 1 : 0 }, (_item, mediaIndex) => ({
        kind: "video" as const,
        url: `https://video/${index}-${mediaIndex}.mp4`,
      })),
    }));
    const pages = await renderer.renderRecentActivities({
      id: "42",
      username: "OpenAI",
      fullname: "OpenAI",
    }, activities);
    expect(pages).toHaveLength(2);
    pages.forEach(expectPng);
    expect(pngHeight(pageAt(pages, 0))).toBeLessThan(6_000);
    expect(pngHeight(pageAt(pages, 1))).toBeLessThan(1_000);
  });

  it("GIF 和视频缺少封面时通过 FFmpeg 抽取首帧并缓存结果", async () => {
    const ctx = renderingContext();
    const downloaded: string[] = [];
    let frameCalls = 0;
    const frame = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    Object.defineProperty(ctx, "http", {
      value: {
        get: async (url: string) => {
          downloaded.push(url);
          return Buffer.from("fake-video");
        },
      },
    });
    Object.defineProperty(ctx, "ffmpeg", {
      value: {
        builder: () => ({
          input: () => ({
            outputOption: () => ({
              run: async () => {
                frameCalls += 1;
                return frame;
              },
            }),
          }),
        }),
      },
    });
    const renderer = createTakumiRenderer(ctx, new Logger("takumi-test"));
    const activity = {
      id: "500",
      authorId: "42",
      username: "OpenAI",
      fullname: "OpenAI",
      kind: "post" as const,
      text: "video preview fallback",
      createdAt: new Date("2026-09-15T07:07:26.000Z"),
      url: "https://x.com/OpenAI/status/500",
      media: [
        { kind: "gif" as const, url: "https://video/shared.mp4" },
        { kind: "video" as const, url: "https://video/shared.mp4" },
      ],
    };

    const pages = await renderer.renderRecentActivities({
      id: "42",
      username: "OpenAI",
      fullname: "OpenAI",
    }, [activity]);

    expect(pages).toHaveLength(1);
    expectPng(pageAt(pages, 0));
    expect(downloaded).toEqual(["https://video/shared.mp4"]);
    expect(frameCalls).toBe(1);
  });
});
