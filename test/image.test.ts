import { Context, Logger } from "@koishijs/core";
import { describe, expect, it } from "vitest";
import { createImageLimiter, type FfmpegBuilder } from "../src/render/image";

function fixture(results: Buffer[]) {
  const ctx = new Context();
  const options: string[][] = [];
  const inputs: Buffer[] = [];
  const builder: FfmpegBuilder = {
    input: (data) => { inputs.push(data); return builder; },
    outputOption: (...args) => { options.push(args); return builder; },
    run: async () => results.shift() ?? Buffer.from([255, 216, ...new Array(100).fill(0)]),
  };
  Object.defineProperty(ctx, "ffmpeg", { value: { builder: () => builder } });
  return { ctx, options, inputs };
}

describe("图片大小兜底", () => {
  it("默认 5 MiB，边界以内保留原图且不调用 FFmpeg", async () => {
    const { ctx, options } = fixture([]);
    const image = { buffer: Buffer.alloc(5 * 1024 * 1024), mimeType: "image/png" as const };
    expect(await createImageLimiter(ctx, new Logger("test"))(image)).toBe(image);
    expect(options).toHaveLength(0);
  });

  it("超限重试从原图编码并更新 MIME", async () => {
    const { ctx, options, inputs } = fixture([
      Buffer.from([255, 216, ...new Array(100).fill(0)]),
      Buffer.from([255, 216, 255, 217]),
    ]);
    const image = { buffer: Buffer.alloc(200), mimeType: "image/webp" as const };
    const result = await createImageLimiter(ctx, new Logger("test"), 50 / 1024 / 1024)(image);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(50);
    expect(options).toHaveLength(2);
    expect(inputs.every((input) => input === image.buffer)).toBe(true);
  });

  it("尝试次数有上限且缩小尺寸，失败不返回超限图片", async () => {
    const { ctx, options } = fixture([]);
    await expect(createImageLimiter(ctx, new Logger("test"), 50 / 1024 / 1024)({
      buffer: Buffer.alloc(200), mimeType: "image/png",
    })).rejects.toThrow("8 次");
    expect(options).toHaveLength(8);
    expect(options[3]?.join(" ")).toContain("0.75");
  });

  it("拒绝空转码结果", async () => {
    const { ctx } = fixture([Buffer.alloc(0)]);
    await expect(createImageLimiter(ctx, new Logger("test"), 50 / 1024 / 1024)({
      buffer: Buffer.alloc(200), mimeType: "image/png",
    })).rejects.toThrow("有效 JPEG");
  });
});
