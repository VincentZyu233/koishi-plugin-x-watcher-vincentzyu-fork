import { errorMessage } from "./errors";
import { h, type Context, type Logger } from "koishi";
import { Agent, request } from "undici";
import { createDispatcher, type ProxyOptions } from "./proxy";
import type { XActivity, XMedia } from "./domain";
import { getFfmpegService, type ImageProcessor, type OutputImage } from "./render/image";

export type MediaDownload = (url: string) => Promise<Buffer>;

/** 独立 dispatcher，所有供应商共用；关闭代理时保证直连。 */
export function createMediaDownload(ctx: Context, options: ProxyOptions): MediaDownload {
  const dispatcher = options.enabled ? createDispatcher(options.url) : new Agent();
  ctx.on("dispose", async () => { await dispatcher.close(); });
  return async (url) => {
    const signal = AbortSignal.timeout(15_000);
    let target = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await request(target, {
        dispatcher, signal, headersTimeout: 15_000, bodyTimeout: 15_000,
      });
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && typeof location === "string") {
        response.body.destroy();
        target = new URL(location, target).href;
        continue;
      }
      if (response.statusCode >= 200 && response.statusCode < 300) {
        return Buffer.from(await response.body.arrayBuffer());
      }
      response.body.destroy();
      throw new Error(`媒体下载 HTTP ${response.statusCode}`);
    }
    throw new Error("媒体下载重定向超过 3 次");
  };
}

function imageMime(buffer: Buffer): OutputImage["mimeType"] | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export function createAttachmentOutput(ctx: Context, logger: Logger, download: MediaDownload, processImage: ImageProcessor) {
  return async (activities: ReadonlyArray<XActivity>, numbered: boolean): Promise<string> => {
    const cache = new Map<string, Promise<Buffer>>();
    const jobs = activities.flatMap((activity, activityIndex) => activity.media
      .map((media, mediaIndex) => ({ activity, activityIndex, media, mediaIndex }))
      .filter(({ media }) => media.kind !== "video"));
    const output = new Array<string>(jobs.length);
    let cursor = 0;
    const prepare = async (media: XMedia): Promise<OutputImage> => {
      let pending = cache.get(media.url);
      if (pending === undefined) {
        pending = download(media.url);
        cache.set(media.url, pending);
      }
      let buffer = await pending;
      let mimeType = imageMime(buffer);
      if (media.kind === "gif" || buffer.toString("ascii", 0, 3) === "GIF") {
        const ffmpeg = getFfmpegService(ctx);
        if (ffmpeg === undefined) throw new Error("首帧解码缺少 FFmpeg 服务");
        buffer = await ffmpeg.builder().input(buffer)
          .outputOption("-frames:v", "1", "-c:v", "png", "-f", "image2pipe").run("buffer");
        mimeType = imageMime(buffer);
      }
      if (mimeType === null || buffer.length === 0) throw new Error("媒体解码失败：不是有效的 JPG、PNG 或 WebP 图片");
      logger.debug(`附件处理前：${buffer.length} 字节，${mimeType}`);
      return processImage({ buffer, mimeType });
    };
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const index = cursor++;
        const job = jobs[index];
        if (job === undefined) continue;
        const label = `${numbered ? `第 ${job.activityIndex + 1} 条动态 · ` : ""}图片 ${job.mediaIndex + 1}`;
        try {
          const image = await prepare(job.media);
          logger.debug(`动态 ${job.activity.id} 附件 ${job.mediaIndex + 1}：${image.buffer.length} 字节，${image.mimeType}`);
          output[index] = `${numbered ? h.text(label) + "\n" : ""}${h.image(image.buffer, image.mimeType)}`;
        } catch (error) {
          logger.warn(`动态 ${job.activity.id} 附件 ${job.mediaIndex + 1} 下载或处理失败：${errorMessage(error instanceof Error ? error : String(error))}`);
          output[index] = h.text(`（${label}加载失败，请查看原文）`).toString();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, worker));
    return output.join("\n");
  };
}
