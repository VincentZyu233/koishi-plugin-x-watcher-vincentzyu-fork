import { imageSize } from "image-size";
import { DEFAULT_MEDIA_LAYOUT, MEDIA_GAP, mediaColumns, mediaDimensions, type MediaLayoutOptions } from "./layout";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { container, image, text, type Node } from "@takumi-rs/helpers";
import type { Renderer as TakumiRendererInstance } from "@takumi-rs/wasm/node";
import type { Context, Logger } from "koishi";
import {
  FONT_ASSET_PATH_RELATIVE_TO_BASE_DIR,
  type TakumiImageFormat,
} from "../config";
import type { XActivity, XMedia, XUser } from "../domain";
import type { WatcherRecord } from "../database";
import { HELP_COMMANDS, type HelpCommand } from "../help";
import { getFfmpegService, type FfmpegService } from "./image";

const WIDTH = 900;
const nodeRequire = createRequire(
  typeof __filename === "string" ? __filename : join(process.cwd(), "index.js"),
);
const takumiModule: typeof import("@takumi-rs/wasm/node") = nodeRequire("@takumi-rs/wasm/node");

export interface TakumiImageOptions {
  readonly format: TakumiImageFormat;
  readonly quality: number;
  readonly mediaMaxWidth?: number;
  readonly mediaMaxHeight?: number;
  readonly mediaCrop?: boolean;
  readonly mediaLayout?: MediaLayoutOptions["layout"];
}

const palette = {
  background: "#ffffff",
  surface: "#ffffff",
  text: "#0f1419",
  muted: "#536471",
  accent: "#1d9bf0",
  border: "#eff3f4",
  success: "#16875b",
  disabled: "#8b98a5",
};

function formatTime(date: Date): string {
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function actionLabel(kind: XActivity["kind"]): string {
  return { post: "推文", reply: "回复", quote: "引用", retweet: "转推" }[kind];
}

function estimateTextLines(value: string, charactersPerLine: number): number {
  return value.split(/\r?\n/).reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0,
  );
}

function initials(value: string): string {
  const trimmed = value.trim();
  const first = [...trimmed][0];
  return first === undefined ? "X" : first.toUpperCase();
}

function avatarNode(activity: XActivity, avatar: Uint8Array | null): Node {
  if (avatar !== null) {
    return image({
      src: avatar,
      width: 72,
      height: 72,
      style: { width: 72, height: 72, borderRadius: 36, objectFit: "cover" },
    });
  }
  return container({
    style: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: palette.accent,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    },
    children: [text(initials(activity.fullname), {
      color: "#ffffff",
      fontSize: 34,
      fontWeight: 800,
    })],
  });
}

function tweetCard(
  activity: XActivity,
  avatar: Uint8Array | null,
  media: ReadonlyArray<RenderedMedia>,
  options: MediaLayoutOptions,
): Node {
  const grid = mediaGrid(media, options, WIDTH - 28 * 2 - 34 * 2 - 2);
  const children: Node[] = [
    container({
      style: { display: "flex", alignItems: "center", gap: 18 },
      children: [
        avatarNode(activity, avatar),
        container({
          style: { display: "flex", flexDirection: "column", gap: 3, flex: 1 },
          children: [
            text(activity.fullname, { fontSize: 28, fontWeight: 700, color: palette.text }),
            text(`@${activity.username}`, { fontSize: 19, color: palette.muted }),
          ],
        }),
        container({
          style: {
            padding: "8px 14px",
            backgroundColor: "#eff3f4",
            borderRadius: 999,
          },
          children: [text(actionLabel(activity.kind), {
            fontSize: 18,
            fontWeight: 700,
            color: palette.text,
          })],
        }),
      ],
    }),
    text(activity.text.trim() || "（无文字内容）", {
      fontSize: 27,
      lineHeight: 1.55,
      color: palette.text,
    }),
  ];
  if (grid !== null) children.push(grid);
  children.push(
    container({
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 8,
        paddingTop: 18,
        borderTop: `1px solid ${palette.border}`,
      },
      children: [
        text(`发布时间：${formatTime(activity.createdAt)}`, { fontSize: 17, color: palette.muted }),
        text(activity.url, { fontSize: 16, color: palette.accent }),
      ],
    }),
  );
  return container({
    style: {
      width: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 22,
      padding: 34,
      backgroundColor: palette.surface,
      border: `1px solid ${palette.border}`,
      borderRadius: 0,
    },
    children,
  });
}

interface RenderedMedia {
  readonly media: XMedia;
  readonly data: Uint8Array | null;
  readonly failureLabel: string;
}

function mediaGrid(items: ReadonlyArray<RenderedMedia>, options: MediaLayoutOptions, contentWidth: number): Node | null {
  if (items.length === 0) return null;
  const columns = mediaColumns(items.length, options.layout);
  const columnWidth = (contentWidth - MEDIA_GAP * (columns - 1)) / columns;
  const cells = items.map((item) => {
    let original: { width: number; height: number } | null = null;
    if (item.data !== null) {
      try {
        const metadata = imageSize(item.data);
        if (metadata.width > 0 && metadata.height > 0) original = metadata;
      } catch { /* 无法读尺寸时保留原顺序并显示占位。 */ }
    }
    const size = mediaDimensions(original, columnWidth, options);
    const node = item.data !== null && original !== null
      ? image({
        src: item.data, ...size,
        style: { ...size, objectFit: options.crop ? "cover" : "contain", borderRadius: 10 },
      })
      : container({
        style: {
          ...size, display: "flex", alignItems: "center", justifyContent: "center",
          backgroundColor: "#eff3f4", borderRadius: 10, overflow: "hidden",
        },
        children: [text(item.failureLabel || "图片尺寸读取失败", { fontSize: 18, color: palette.muted })],
      });
    return container({
      style: { width: columnWidth, height: size.height, display: "flex", justifyContent: "center", alignItems: "flex-start", flexShrink: 0 },
      children: [node],
    });
  });
  const rows: Node[] = [];
  for (let index = 0; index < cells.length; index += columns) {
    rows.push(container({
      style: { width: contentWidth, display: "flex", gap: MEDIA_GAP, alignItems: "flex-start", justifyContent: "flex-start" },
      children: cells.slice(index, index + columns),
    }));
  }
  return container({
    style: { width: "100%", display: "flex", flexDirection: "column", gap: MEDIA_GAP, alignItems: "center" },
    children: rows,
  });
}

function recentActivityCard(
  activity: XActivity,
  avatar: Uint8Array | null,
  media: ReadonlyArray<RenderedMedia>,
  options: MediaLayoutOptions,
): Node {
  const grid = mediaGrid(media, options, WIDTH - 28 * 2 - 26 * 2 - 2);
  const children: Node[] = [
    container({
      style: { display: "flex", alignItems: "center", gap: 14 },
      children: [
        avatarNode(activity, avatar),
        container({
          style: { display: "flex", flexDirection: "column", gap: 2, flex: 1 },
          children: [
            text(activity.fullname, { fontSize: 25, fontWeight: 600, color: palette.text }),
            text(`@${activity.username} · ${formatTime(activity.createdAt)}`, { fontSize: 17, color: palette.muted }),
          ],
        }),
        text(actionLabel(activity.kind), { fontSize: 17, fontWeight: 600, color: palette.accent }),
      ],
    }),
    text(activity.text.trim() || "（无文字内容）", {
      fontSize: 24,
      lineHeight: 1.5,
      color: palette.text,
    }),
  ];
  if (grid !== null) children.push(grid);
  children.push(text(`原文：${activity.url}`, { fontSize: 15, color: palette.accent }));
  return container({
    style: {
      width: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 16,
      padding: 26,
      backgroundColor: palette.surface,
      border: `1px solid ${palette.border}`,
    },
    children,
  });
}

function watcherAvatarNode(watcher: WatcherRecord, avatar: Uint8Array | null): Node {
  if (avatar !== null) {
    return image({
      src: avatar,
      width: 36,
      height: 36,
      style: { width: 36, height: 36, borderRadius: 18, objectFit: "cover" },
    });
  }
  return container({
    style: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: palette.accent,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    children: [text(initials(watcher.twitter_fullname), {
      color: "#ffffff",
      fontSize: 17,
      fontWeight: 650,
    })],
  });
}

function watcherRow(watcher: WatcherRecord, avatar: Uint8Array | null): Node {
  const cells = [
    watcher.active ? "订阅中" : "已取消",
    watcher.filter_regexp === null
      ? "无"
      : watcher.filter_regexp.trim() || "无",
    watcher.media ? "包含" : "不含",
    watcher.include_quote ? "开启" : "关闭",
    watcher.include_retweet ? "开启" : "关闭",
  ];
  const widths = [210, 100, 210, 90, 90, 90];
  return container({
    style: {
      width: "100%",
      display: "flex",
      alignItems: "center",
      minHeight: 58,
      padding: "10px 12px",
      borderBottom: `1px solid ${palette.border}`,
      backgroundColor: palette.surface,
    },
    children: [
      container({
        style: {
          width: widths[0],
          display: "flex",
          alignItems: "center",
          gap: 10,
        },
        children: [
          watcherAvatarNode(watcher, avatar),
          text(`@${watcher.twitter_username}`, {
            fontSize: 16,
            lineHeight: 1.35,
            color: palette.text,
            fontWeight: 400,
          }),
        ],
      }),
      ...cells.map((cell, index) => text(cell, {
        width: widths[index + 1],
        fontSize: 16,
        lineHeight: 1.35,
        color: index === 0
          ? watcher.active ? palette.success : palette.disabled
          : palette.text,
        fontWeight: index === 0 ? 500 : 400,
      })),
    ],
  });
}

function watcherTable(
  watchers: ReadonlyArray<WatcherRecord>,
  avatars: ReadonlyArray<Uint8Array | null>,
): Node {
  const labels = ["订阅", "状态", "过滤条件", "媒体", "引用", "转推"];
  const widths = [210, 100, 210, 90, 90, 90];
  return container({
    style: {
      width: "100%",
      display: "flex",
      flexDirection: "column",
      border: `1px solid ${palette.border}`,
      borderRadius: 0,
      overflow: "hidden",
    },
    children: [
      container({
        style: {
          display: "flex",
          padding: "12px",
          backgroundColor: "#f7f9f9",
        },
        children: labels.map((label, index) => text(label, {
          width: widths[index],
          fontSize: 16,
          fontWeight: 500,
          color: palette.text,
        })),
      }),
      ...watchers.map((watcher, index) => watcherRow(
        watcher,
        avatars[index] ?? null,
      )),
    ],
  });
}

function helpCommandCard(command: HelpCommand): Node {
  const children: Node[] = [
    text(command.syntax, { fontSize: 21, fontWeight: 600, color: palette.text }),
    text(command.description, { fontSize: 18, color: palette.muted }),
    text(`别名：${command.aliases.join("、")}`, { fontSize: 16, color: palette.accent }),
  ];
  if (command.options.length > 0) {
    children.push(container({
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "12px 14px",
        backgroundColor: "#f7f9f9",
        borderRadius: 8,
      },
      children: command.options.map((option) => text(
        `${option.syntax}  ${option.description}`,
        { fontSize: 16, lineHeight: 1.4, color: palette.text },
      )),
    }));
  }
  return container({
    style: {
      width: "100%",
      display: "flex",
      flexDirection: "column",
      gap: 9,
      padding: 24,
      backgroundColor: palette.surface,
      border: `1px solid ${palette.border}`,
      borderRadius: 0,
    },
    children,
  });
}

export interface TakumiRenderer {
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly renderActivity: (activity: XActivity, includeMedia: boolean) => Promise<Buffer>;
  readonly renderWatcherList: (watchers: ReadonlyArray<WatcherRecord>) => Promise<Buffer>;
  readonly renderRecentActivities: (
    user: XUser,
    activities: ReadonlyArray<XActivity>,
  ) => Promise<ReadonlyArray<Buffer>>;
  readonly renderHelp: () => Promise<Buffer>;
}

function mimeTypeFor(format: TakumiImageFormat): "image/jpeg" | "image/png" | "image/webp" {
  if (format === "jpg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function rendererFormatFor(format: TakumiImageFormat): "jpeg" | "png" | "webp" {
  return format === "jpg" ? "jpeg" : format;
}

export function createTakumiRenderer(
  ctx: Context,
  logger: Logger,
  imageOptions: TakumiImageOptions = { format: "jpg", quality: 50 },
): TakumiRenderer {
  const mediaOptions: MediaLayoutOptions = {
    maxWidth: imageOptions.mediaMaxWidth ?? DEFAULT_MEDIA_LAYOUT.maxWidth,
    maxHeight: imageOptions.mediaMaxHeight ?? DEFAULT_MEDIA_LAYOUT.maxHeight,
    crop: imageOptions.mediaCrop ?? DEFAULT_MEDIA_LAYOUT.crop,
    layout: imageOptions.mediaLayout ?? DEFAULT_MEDIA_LAYOUT.layout,
  };
  for (const value of [mediaOptions.maxWidth, mediaOptions.maxHeight]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("配图尺寸必须是正整数");
  }
  const fontPath = join(ctx.baseDir, ...FONT_ASSET_PATH_RELATIVE_TO_BASE_DIR);
  if (!existsSync(fontPath)) {
    throw new Error(`Takumi 中文字体不存在：${fontPath}`);
  }
  const renderer: TakumiRendererInstance = new takumiModule.Renderer({
    fonts: [readFileSync(fontPath)],
  });
  const outputFormat = rendererFormatFor(imageOptions.format);
  const mimeType = mimeTypeFor(imageOptions.format);

  const renderImage = (
    root: Node,
    width: number,
    height: number | undefined,
  ): Buffer => Buffer.from(renderer.render(root, {
    width,
    ...(height === undefined ? {} : { height }),
    format: outputFormat,
    ...(outputFormat === "jpeg" ? { quality: imageOptions.quality } : {}),
  }));

  const fetchAvatar = async (url: string | undefined): Promise<Uint8Array | null> => {
    if (url === undefined || url.length === 0) return null;
    try {
      const data = await ctx.http.get<ArrayBuffer>(url, { responseType: "arraybuffer" });
      return new Uint8Array(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`下载 X 头像失败，使用文字占位头像：${message}`);
      return null;
    }
  };

  const assetCache = new Map<string, Promise<Uint8Array | null>>();
  const fetchAsset = (url: string | undefined, label: string): Promise<Uint8Array | null> => {
    if (url === undefined || url.length === 0) return Promise.resolve(null);
    const cached = assetCache.get(url);
    if (cached !== undefined) return cached;
    const pending = ctx.http.get<ArrayBuffer>(url, { responseType: "arraybuffer" })
      .then((data) => new Uint8Array(data))
      .catch((error: Error) => {
        logger.warn(`下载 X ${label}失败，使用占位内容：${error.message}`);
        return null;
      });
    assetCache.set(url, pending);
    return pending;
  };

  const frameCache = new Map<string, Promise<Uint8Array | null>>();
  const extractFirstFrame = (
    ffmpeg: FfmpegService,
    url: string,
    data: Uint8Array,
  ): Promise<Uint8Array | null> => {
    const cached = frameCache.get(url);
    if (cached !== undefined) return cached;
    const pending = ffmpeg.builder()
      .input(Buffer.from(data))
      .outputOption("-frames:v", "1", "-f", "image2pipe", "-vcodec", "png")
      .run("buffer")
      .then((frame) => frame.length === 0 ? null : new Uint8Array(frame))
      .catch((error: Error) => {
        logger.warn(`FFmpeg 提取 X 媒体首帧失败：${error.message}`);
        return null;
      });
    frameCache.set(url, pending);
    return pending;
  };

  const renderMedia = async (media: XMedia): Promise<RenderedMedia> => {
    const kindLabel = media.kind === "gif" ? "GIF" : media.kind === "video" ? "视频" : "图片";
    const previewSource = media.previewUrl === undefined
      ? media.kind === "image" ? media.url : undefined
      : media.previewUrl;
    const preview = await fetchAsset(previewSource, `${kindLabel}封面`);
    if (preview !== null) return { media, data: preview, failureLabel: "" };
    if (media.kind === "image") {
      return { media, data: null, failureLabel: "图片加载失败" };
    }
    const ffmpeg = getFfmpegService(ctx);
    if (ffmpeg === undefined) {
      return {
        media,
        data: null,
        failureLabel: `FFmpeg 服务未启用，无法显示${kindLabel}封面`,
      };
    }
    const source = await fetchAsset(media.url, `${kindLabel}媒体流`);
    if (source === null) {
      return { media, data: null, failureLabel: `${kindLabel}媒体下载失败` };
    }
    const frame = await extractFirstFrame(ffmpeg, media.url, source);
    return {
      media,
      data: frame,
      failureLabel: frame === null ? `${kindLabel}首帧提取失败` : "",
    };
  };

  return {
    mimeType,
    renderActivity: async (activity, includeMedia) => {
      const avatar = await fetchAvatar(activity.avatarUrl);
      const renderedMedia: RenderedMedia[] = [];
      if (includeMedia) {
        for (const media of activity.media) {
          renderedMedia.push(await renderMedia(media));
        }
      }
      const root = container({
        style: { width: WIDTH, padding: 28, backgroundColor: palette.background },
        children: [tweetCard(activity, avatar, renderedMedia, mediaOptions)],
      });
      return renderImage(root, WIDTH, undefined);
    },
    renderWatcherList: async (watchers) => {
      const avatars = await Promise.all(
        watchers.map((watcher) => fetchAvatar(watcher.twitter_avatar_url ?? undefined)),
      );
      const rowsHeight = watchers.reduce((total, watcher) =>
        total + Math.max(58, estimateTextLines(watcher.filter_regexp ?? "无", 18) * 25 + 20), 0);
      const height = Math.max(250, 170 + rowsHeight);
      const root = container({
        style: {
          width: WIDTH,
          display: "flex",
          flexDirection: "column",
          gap: 18,
          padding: 28,
          backgroundColor: palette.background,
        },
        children: [
          text("X / Twitter 频道订阅", { fontSize: 32, fontWeight: 650, color: palette.text }),
          text(`共 ${watchers.length} 条订阅`, { fontSize: 17, color: palette.muted }),
          watcherTable(watchers, avatars),
        ],
      });
      return renderImage(root, WIDTH, height);
    },
    renderRecentActivities: async (user, activities) => {
      const pageCount = Math.ceil(activities.length / 10);
      const pages: Buffer[] = [];
      for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
        const pageActivities = activities.slice(pageIndex * 10, pageIndex * 10 + 10);
        const cards: Node[] = [];
        for (const activity of pageActivities) {
          const avatar = await fetchAsset(activity.avatarUrl, "头像");
          const renderedMedia: RenderedMedia[] = [];
          for (const media of activity.media) {
            renderedMedia.push(await renderMedia(media));
          }
          cards.push(recentActivityCard(activity, avatar, renderedMedia, mediaOptions));
        }
        const root = container({
          style: {
            width: WIDTH,
            display: "flex",
            flexDirection: "column",
            gap: 14,
            padding: 28,
            backgroundColor: palette.background,
          },
          children: [
            container({
              style: { display: "flex", alignItems: "center" },
              children: [
                text(`${user.fullname} (@${user.username}) 最近动态`, { flex: 1, fontSize: 31, fontWeight: 650, color: palette.text }),
                text(`第 ${pageIndex + 1}/${pageCount} 页`, { fontSize: 17, color: palette.muted }),
              ],
            }),
            ...cards,
          ],
        });
        try {
          pages.push(renderImage(root, WIDTH, undefined));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Takumi 最近动态第 ${pageIndex + 1} 页渲染失败，已跳过：${message}`);
        }
      }
      return pages;
    },
    renderHelp: async () => {
      const root = container({
        style: {
          width: WIDTH,
          display: "flex",
          flexDirection: "column",
          gap: 14,
          padding: 28,
          backgroundColor: palette.background,
        },
        children: [
          text("X Watcher 指令帮助", { fontSize: 34, fontWeight: 650, color: palette.text }),
          text("订阅、查询和管理 X / Twitter 动态", { fontSize: 18, color: palette.muted }),
          ...HELP_COMMANDS.map((command) => helpCommandCard(command)),
        ],
      });
      return renderImage(root, WIDTH, undefined);
    },
  };
}
