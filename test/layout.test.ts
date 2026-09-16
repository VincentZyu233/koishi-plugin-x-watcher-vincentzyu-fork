import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_LAYOUT, mediaColumns, mediaDimensions } from "../src/render/layout";
import { Config } from "../src/config";

describe("配图布局", () => {
  it("默认 666×333、轻微裁剪、两列", () => {
    expect(Config({ apiKeys: ["key"] })).toMatchObject({
      takumiMediaMaxWidth: 666, takumiMediaMaxHeight: 333,
      takumiMediaCrop: "mild", takumiMediaLayout: "grid-2",
    });
  });
  it("拒绝非法尺寸和布局", () => {
    for (const value of [0, -1, 1.5]) {
      expect(() => Config({ apiKeys: ["key"], takumiMediaMaxWidth: value })).toThrow();
      expect(() => Config({ apiKeys: ["key"], takumiMediaMaxHeight: value })).toThrow();
    }
    expect(() => Config({ apiKeys: ["key"], takumiMediaLayout: "bad" as never })).toThrow();
  });
  it("横竖方图等比缩小，小图不放大", () => {
    const options = { ...DEFAULT_MEDIA_LAYOUT, crop: "none" as const };
    expect(mediaDimensions({ width: 1600, height: 900 }, 774, options)).toEqual({ width: 592, height: 333 });
    expect(mediaDimensions({ width: 900, height: 1600 }, 774, options)).toEqual({ width: 187.3125, height: 333 });
    expect(mediaDimensions({ width: 900, height: 900 }, 774, options)).toEqual({ width: 333, height: 333 });
    expect(mediaDimensions({ width: 60, height: 80 }, 774, options)).toEqual({ width: 60, height: 80 });
  });
  it("裁剪框遵守列宽，失败占位不超过高度上限", () => {
    expect(mediaDimensions({ width: 20, height: 20 }, 250, { ...DEFAULT_MEDIA_LAYOUT, crop: "aggressive" })).toEqual({ width: 250, height: 333 });
    expect(mediaDimensions(null, 250, DEFAULT_MEDIA_LAYOUT)).toEqual({ width: 250, height: 96 });
    expect(mediaDimensions(null, 250, { ...DEFAULT_MEDIA_LAYOUT, maxHeight: 50 })).toEqual({ width: 250, height: 50 });
  });
  it("未填满行仍保留列数，单图始终一列", () => {
    expect(mediaColumns(1, "grid-3")).toBe(1);
    expect(mediaColumns(5, "grid-2")).toBe(2);
    expect(mediaColumns(2, "grid-3")).toBe(3);
    expect(mediaColumns(5, "column")).toBe(1);
  });
  it("裁剪仅接受三个字符串档位，不兼容旧布尔值", () => {
    for (const value of ["none", "mild", "aggressive"] as const) {
      expect(Config({ apiKeys: ["key"], takumiMediaCrop: value })).toMatchObject({ takumiMediaCrop: value });
    }
    for (const value of [false, true, "bad"]) {
      expect(() => Config({ apiKeys: ["key"], takumiMediaCrop: value as never })).toThrow();
    }
  });
  it("轻微裁剪对横图和竖图最多损失 15% 面积，仍遵守尺寸限制", () => {
    for (const original of [{ width: 2000, height: 200 }, { width: 200, height: 2000 }]) {
      const result = mediaDimensions(original, 300, { ...DEFAULT_MEDIA_LAYOUT, crop: "mild" });
      const scale = Math.max(result.width / original.width, result.height / original.height);
      const retained = result.width * result.height / (scale * scale * original.width * original.height);
      expect(retained).toBeCloseTo(0.85, 10);
      expect(result.width).toBeLessThanOrEqual(300);
      expect(result.height).toBeLessThanOrEqual(333);
      expect(scale).toBeLessThanOrEqual(1);
    }
  });
  it("轻微裁剪比例接近时填满、同比例不裁剪，小图不放大", () => {
    const options = { ...DEFAULT_MEDIA_LAYOUT, crop: "mild" as const, maxHeight: 100 };
    expect(mediaDimensions({ width: 210, height: 100 }, 200, options)).toEqual({ width: 200, height: 100 });
    expect(mediaDimensions({ width: 400, height: 200 }, 200, options)).toEqual({ width: 200, height: 100 });
    expect(mediaDimensions({ width: 20, height: 20 }, 200, options)).toEqual({ width: 20, height: 17 });
    expect(mediaDimensions(null, 200, options)).toEqual({ width: 200, height: 96 });
  });
});
