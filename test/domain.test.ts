import { describe, expect, it } from "vitest";
import {
  compareSnowflake,
  compileFilter,
  normalizeActivityOrder,
  normalizeHandle,
  snowflakeDate,
  type XActivity,
} from "../src/domain";

function activity(id: string, text: string): XActivity {
  return {
    id,
    authorId: "42",
    username: "Example",
    fullname: "Example User",
    kind: "post",
    text,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://x.com/Example/status/${id}`,
    media: [],
  };
}

describe("领域纯函数", () => {
  it("规范化带 @ 的用户名并拒绝非法输入", () => {
    expect(normalizeHandle(" @OpenAI ")).toEqual({
      ok: true,
      value: "OpenAI",
    });
    expect(normalizeHandle("not-valid!").ok).toBe(false);
    expect(normalizeHandle("abcdefghijklmnop").ok).toBe(false);
  });

  it("以字符串精确比较超过安全整数范围的 Snowflake", () => {
    expect(compareSnowflake("999999999999999999", "1000000000000000000"))
      .toBe(-1);
    expect(compareSnowflake("00042", "42")).toBe(0);
  });

  it("按 Snowflake 去重并从旧到新排序", () => {
    const normalized = normalizeActivityOrder([
      activity("30", "third"),
      activity("10", "first"),
      activity("20", "second"),
      activity("20", "duplicate"),
    ]);
    expect(normalized.map((item) => item.id)).toEqual(["10", "20", "30"]);
    expect(normalized.map((item) => item.text)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("固定使用大小写无关正则并拒绝非法规则", () => {
    const compiled = compileFilter("hello");
    expect(compiled.ok).toBe(true);
    if (compiled.ok && compiled.value !== null) {
      expect(compiled.value.test("HELLO world")).toBe(true);
    }
    expect(compileFilter("[").ok).toBe(false);
  });

  it("从合法 Snowflake 计算时间并安全处理非法值", () => {
    expect(snowflakeDate("20")).toBeInstanceOf(Date);
    expect(snowflakeDate("invalid")).toBeNull();
  });
});
