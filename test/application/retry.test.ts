import { describe, expect, it } from "@effect/vitest";
import { retryDelayCapMillis } from "../../src/application/workers";

describe("可靠任务全抖动退避", () => {
  it("从 5 秒开始指数增长并封顶一小时", () => {
    expect(retryDelayCapMillis(1)).toBe(5_000);
    expect(retryDelayCapMillis(2)).toBe(10_000);
    expect(retryDelayCapMillis(3)).toBe(20_000);
    expect(retryDelayCapMillis(100)).toBe(60 * 60_000);
  });
});
