import type { Context, Logger } from "koishi";

export interface FfmpegBuilder {
  readonly input: (data: Buffer) => FfmpegBuilder;
  readonly outputOption: (...options: string[]) => FfmpegBuilder;
  readonly run: (type: "buffer") => Promise<Buffer>;
}

export interface FfmpegService {
  readonly builder: () => FfmpegBuilder;
}

export function getFfmpegService(ctx: Context): FfmpegService | undefined {
  return Reflect.get(ctx, "ffmpeg");
}

export interface OutputImage {
  readonly buffer: Buffer;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
}

export type ImageProcessor = (image: OutputImage) => Promise<OutputImage>;

/** 卡片与附件共用大小限制；每次从原图编码，避免反复有损压缩。 */
export function createImageLimiter(ctx: Context, logger: Logger, maxMiB = 5): ImageProcessor {
  if (!Number.isFinite(maxMiB) || maxMiB <= 0) throw new Error("图片大小上限必须大于 0 MiB");
  const maxBytes = Math.floor(maxMiB * 1024 * 1024);
  return async (image) => {
    if (image.buffer.length <= maxBytes) return image;
    const ffmpeg = getFfmpegService(ctx);
    if (ffmpeg === undefined) throw new Error("图片超限，缺少 ffmpeg 服务");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const scale = attempt < 3 ? 1 : Math.pow(0.75, attempt - 2);
      const quality = [5, 10, 16][Math.min(attempt, 2)] ?? 16;
      const buffer = await ffmpeg.builder()
        .input(image.buffer)
        .outputOption(
          "-frames:v", "1", "-vf", `scale=max(2\\,trunc(iw*${scale}/2)*2):max(2\\,trunc(ih*${scale}/2)*2)`,
          "-c:v", "mjpeg", "-q:v", String(quality), "-pix_fmt", "yuvj420p", "-f", "image2pipe",
        )
        .run("buffer");
      if (buffer.length === 0 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
        throw new Error("FFmpeg 未返回有效 JPEG 图片");
      }
      if (buffer.length <= maxBytes) {
        logger.info(`图片超限压缩完成：${image.buffer.length} → ${buffer.length} 字节，上限 ${maxBytes} 字节，JPEG，第 ${attempt + 1} 次`);
        return { buffer, mimeType: "image/jpeg" };
      }
    }
    throw new Error(`图片经过 8 次压缩仍超过 ${maxMiB} MiB，停止发送超限图片`);
  };
}
