import { Context, Logger } from "@koishijs/core";
import { describe, expect, it, vi, afterEach } from "vitest";
import { createAttachmentOutput, createMediaDownload } from "../src/media";
import type { XActivity } from "../src/domain";
import { createImageLimiter } from "../src/render/image";
import { request, Agent } from "undici";
import { createDispatcher } from "../src/proxy";

vi.mock("undici", () => ({
  request: vi.fn(),
  Agent: vi.fn(function () { return { close: vi.fn(async () => {}) }; }),
}));
vi.mock("../src/proxy", () => ({ createDispatcher: vi.fn(() => ({ close: vi.fn(async () => {}) })) }));
afterEach(() => vi.clearAllMocks());

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const activity: XActivity = {
  id: "1", authorId: "1", username: "test", fullname: "Test", kind: "post",
  text: "hello", url: "https://x.com/test/status/1", createdAt: new Date(),
  media: [{ kind: "image", url: "https://pbs.twimg.com/test.png" }],
};
const logger = new Logger("media-test");

describe("图片附件", () => {
  it("下载后发送二进制并使用大小处理器返回的 MIME", async () => {
    const download = vi.fn(async () => png);
    const output = createAttachmentOutput(new Context(), logger, download, async () => ({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mimeType: "image/jpeg",
    }));
    const message = await output([activity, activity], true);
    expect(download).toHaveBeenCalledTimes(1);
    expect(message).toContain("第 1 条动态");
    expect(message).toContain("第 2 条动态");
    expect(message).toContain("data:image/jpeg;base64,");
    expect(message).not.toContain("https://pbs.twimg.com");
  });

  it("最多并发三个下载、保持顺序并保留部分成功的结果", async () => {
    let active = 0;
    let maximum = 0;
    const download = vi.fn(async (url: string) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, url.endsWith("0") ? 15 : 1));
      active -= 1;
      if (url.endsWith("1")) throw new Error("download timeout");
      return png;
    });
    const output = createAttachmentOutput(new Context(), logger, download, async image => image);
    const items = Array.from({ length: 6 }, (_, index) => ({
      ...activity, id: String(index), media: [{ kind: "image" as const, url: `https://example.com/${index}` }],
    }));
    const message = await output(items, true);
    expect(maximum).toBe(3);
    expect(message.match(/<img/g)).toHaveLength(5);
    expect(message).toContain("第 2 条动态 · 图片 1加载失败");
    expect(message.indexOf("第 1 条动态")).toBeLessThan(message.indexOf("第 2 条动态"));
    expect(message.indexOf("第 2 条动态")).toBeLessThan(message.indexOf("第 3 条动态"));
  });

  it("GIF 抽首帧，视频跳过，无效内容仅提示", async () => {
    const ctx = new Context();
    const builder = { input: vi.fn(), outputOption: vi.fn(), run: vi.fn(async () => png) };
    builder.input.mockReturnValue(builder);
    builder.outputOption.mockReturnValue(builder);
    Object.defineProperty(ctx, "ffmpeg", { value: { builder: () => builder } });
    const download = vi.fn(async (url: string) => Buffer.from(url.endsWith("gif") ? "GIF89a" : "<html>error</html>"));
    const output = createAttachmentOutput(ctx, logger, download, async image => image);
    const message = await output([{ ...activity, media: [
      { kind: "gif", url: "https://example.com/gif" },
      { kind: "video", url: "https://example.com/video" },
      { kind: "image", url: "https://example.com/bad" },
    ] }], false);
    expect(download).toHaveBeenCalledTimes(2);
    expect(builder.outputOption).toHaveBeenCalledWith("-frames:v", "1", "-c:v", "png", "-f", "image2pipe");
    expect(message).toContain("data:image/png;base64,");
    expect(message).toContain("图片 3加载失败");
  });

  it("图片附件同样受每张大小限制", async () => {
    const ctx = new Context();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const builder = { input: vi.fn(), outputOption: vi.fn(), run: vi.fn(async () => jpeg) };
    builder.input.mockReturnValue(builder);
    builder.outputOption.mockReturnValue(builder);
    Object.defineProperty(ctx, "ffmpeg", { value: { builder: () => builder } });
    const output = createAttachmentOutput(ctx, logger, async () => Buffer.concat([png, Buffer.alloc(20_000)]), createImageLimiter(ctx, logger, 0.01));
    expect(await output([activity], false)).toContain(jpeg.toString("base64"));
    expect(builder.run).toHaveBeenCalledOnce();
  });
});

describe("附件网络", () => {
  it.each([false, true])("代理 enabled=%s 时使用独立 dispatcher 与 15 秒超时", async enabled => {
    const ctx = new Context();
    const response = { statusCode: 200, headers: {}, body: { arrayBuffer: async () => png } };
    vi.mocked(request).mockResolvedValue(response as never);
    const output = createMediaDownload(ctx, { enabled, url: "socks5://127.0.0.1:7890" });
    expect(await output("https://pbs.twimg.com/test.png")).toEqual(png);
    expect(createDispatcher).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(Agent).toHaveBeenCalledTimes(enabled ? 0 : 1);
    expect(request).toHaveBeenCalledWith("https://pbs.twimg.com/test.png", expect.objectContaining({
      dispatcher: expect.anything(), signal: expect.any(AbortSignal), headersTimeout: 15000, bodyTimeout: 15000,
    }));
    await ctx.stop();
  });

  it("HTTP 错误关闭响应且不发送 URL，重定向有上限", async () => {
    const ctx = new Context();
    const destroy = vi.fn();
    const download = createMediaDownload(ctx, { enabled: false, url: "" });
    vi.mocked(request).mockResolvedValue({ statusCode: 403, headers: {}, body: { destroy } } as never);
    await expect(download("https://example.com")).rejects.toThrow("HTTP 403");
    expect(destroy).toHaveBeenCalledOnce();
    vi.mocked(request).mockClear();
    vi.mocked(request).mockResolvedValue({ statusCode: 302, headers: { location: "/next" }, body: { destroy } } as never);
    await expect(download("https://example.com")).rejects.toThrow("重定向超过 3 次");
    expect(request).toHaveBeenCalledTimes(4);
    await ctx.stop();
  });
});
