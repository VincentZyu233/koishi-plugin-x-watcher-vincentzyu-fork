import type { TakumiMediaCrop, TakumiMediaLayout } from "../config";

export interface MediaLayoutOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly crop: TakumiMediaCrop;
  readonly layout: TakumiMediaLayout;
}

export const DEFAULT_MEDIA_LAYOUT: MediaLayoutOptions = {
  maxWidth: 666, maxHeight: 333, crop: "mild", layout: "grid-2",
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
  if (options.crop === "aggressive") return { width, height: options.maxHeight };
  let sourceWidth = original.width;
  let sourceHeight = original.height;
  if (options.crop === "mild") {
    // 向图片框比例靠拢，但只裁一个方向，至少保留原始面积的 85%。
    const ratio = original.width / original.height;
    const targetRatio = Math.max(ratio * 0.85, Math.min(width / options.maxHeight, ratio / 0.85));
    if (targetRatio < ratio) sourceWidth = original.height * targetRatio;
    else sourceHeight = original.width / targetRatio;
  }
  const scale = Math.min(1, width / sourceWidth, options.maxHeight / sourceHeight);
  return { width: sourceWidth * scale, height: sourceHeight * scale };
}
