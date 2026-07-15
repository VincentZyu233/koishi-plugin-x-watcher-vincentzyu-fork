import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import { compileFilter, matchesFilter } from "../../src/domain/filter";

describe("RE2 过滤规则", () => {
  it("以不区分大小写的方式匹配", () => {
    const compiled = compileFilter("openai\\s+news");
    expect(Either.isRight(compiled)).toBe(true);
    if (Either.isRight(compiled)) {
      expect(compiled.right.pattern).toBe("openai\\s+news");
      expect(compiled.right.test("OPENAI News")).toBe(true);
      expect(compiled.right.test("unrelated text")).toBe(false);
    }
  });

  it.each(["(?<=prefix)suffix", "(repeat)\\1"])(
    "拒绝 RE2 不支持的语法：%s",
    (pattern) => {
      expect(Either.isLeft(compileFilter(pattern))).toBe(true);
    },
  );

  it("无过滤规则时直接放行", () => {
    expect(matchesFilter(null, "anything")).toEqual(Either.right(true));
  });

  it("拒绝空白过滤规则", () => {
    expect(compileFilter("   ")).toEqual(Either.left("过滤规则不能为空"));
  });
});
