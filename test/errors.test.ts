import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/errors";

describe("发送错误摘要", () => {
  it("剔除图片数据并保留 OneBot 错误码", () => {
    const error = new Error(`send failed base64://${"A".repeat(10000)} retcode: 1200`);
    Object.defineProperty(error, "code", { value: 1200 });
    expect(errorMessage(error)).toContain("retcode: 1200");
    expect(errorMessage(error)).toContain("[code=1200]");
    expect(errorMessage(error).length).toBeLessThan(200);
  });
  it("处理 data URI 和超长普通消息", () => {
    expect(errorMessage("data:image/png;base64,AAAA")).not.toContain("AAAA");
    expect(errorMessage("x".repeat(3000)).length).toBe(1501);
  });
});
