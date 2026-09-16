import type { TakumiMediaLayout } from "../config";

export interface MediaLayoutOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly crop: boolean;
  readonly layout: TakumiMediaLayout;
}

export const DEFAULT_MEDIA_LAYOUT: MediaLayoutOptions = {
  maxWidth: 666, maxHeight: 333, crop: false, layout: "grid-2",
};
export const MEDIA_GAP = 14;

export function mediaColumns(count: number, layout: TakumiMediaLayout): number {
  return count === 1 || layout === "column" ? 1 : layout === "grid-3" ? 3 : 2;
}

/** 按原图比例计算实际占用尺寸，不用固定高度占位。 */
export function mediaDimensions(
  original: { width: number; height: number } | null,
  columnWidth: number,
  options: MediaLayoutOptions,
): { width: number; height: number } {
  const width = Math.min(columnWidth, options.maxWidth);
  if (original === null) return { width, height: Math.min(96, options.maxHeight) };
  if (options.crop) return { width, height: options.maxHeight };
  const scale = Math.min(1, width / original.width, options.maxHeight / original.height);
  return { width: original.width * scale, height: original.height * scale };
}
