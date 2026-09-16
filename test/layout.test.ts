import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_LAYOUT, mediaColumns, mediaDimensions } from "../src/render/layout";
import { Config } from "../src/config";

describe("配图布局", () => {
  it("默认 666×333、不裁剪、两列", () => {
    expect(Config({ apiKeys: ["key"] })).toMatchObject({
      takumiMediaMaxWidth: 666, takumiMediaMaxHeight: 333,
      takumiMediaCrop: false, takumiMediaLayout: "grid-2",
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
    expect(mediaDimensions({ width: 1600, height: 900 }, 774, DEFAULT_MEDIA_LAYOUT)).toEqual({ width: 592, height: 333 });
    expect(mediaDimensions({ width: 900, height: 1600 }, 774, DEFAULT_MEDIA_LAYOUT)).toEqual({ width: 187.3125, height: 333 });
    expect(mediaDimensions({ width: 900, height: 900 }, 774, DEFAULT_MEDIA_LAYOUT)).toEqual({ width: 333, height: 333 });
    expect(mediaDimensions({ width: 60, height: 80 }, 774, DEFAULT_MEDIA_LAYOUT)).toEqual({ width: 60, height: 80 });
  });
  it("裁剪框遵守列宽，失败占位不超过高度上限", () => {
    expect(mediaDimensions({ width: 20, height: 20 }, 250, { ...DEFAULT_MEDIA_LAYOUT, crop: true })).toEqual({ width: 250, height: 333 });
    expect(mediaDimensions(null, 250, DEFAULT_MEDIA_LAYOUT)).toEqual({ width: 250, height: 96 });
    expect(mediaDimensions(null, 250, { ...DEFAULT_MEDIA_LAYOUT, maxHeight: 50 })).toEqual({ width: 250, height: 50 });
  });
  it("未填满行仍保留列数，单图始终一列", () => {
    expect(mediaColumns(1, "grid-3")).toBe(1);
    expect(mediaColumns(5, "grid-2")).toBe(2);
    expect(mediaColumns(2, "grid-3")).toBe(3);
    expect(mediaColumns(5, "column")).toBe(1);
  });
});
