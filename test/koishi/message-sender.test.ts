import { describe, expect, it } from "@effect/vitest";
import { classifyDeliveryFailure } from "../../src/infrastructure/koishi/delivery-failure";

describe("消息发送错误分类", () => {
  it.each([
    "adapter exploded",
    "400 Bad Request",
    "405 Method Not Allowed",
    "422 Unprocessable Entity",
    "unknown response",
  ])("将不明确错误 %s 保守归类为暂时性", (message) => {
    expect(classifyDeliveryFailure(message).classification).toBe("transient");
  });

  it.each([
    "unsupported message element",
    "invalid media element",
    "HTTP 413 Payload Too Large",
    "HTTP 415 Unsupported Media Type",
    "当前适配器不支持视频",
  ])("只将明确不兼容错误 %s 归类为可降级", (message) => {
    expect(classifyDeliveryFailure(message).classification).toBe("unsupported");
  });
});
