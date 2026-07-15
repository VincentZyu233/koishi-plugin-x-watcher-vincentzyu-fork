import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import {
  compareActivityId,
  isActivityAfter,
  parseActivityId,
  parseXHandle,
  parseXUserId,
} from "../../src/domain/identifiers";

/** 从测试输入的 Either 中提取成功值。 */
const expectRight = <A, E>(value: Either.Either<A, E>): A => {
  if (Either.isLeft(value)) throw new Error(String(value.left));
  return value.right;
};

describe("领域标识", () => {
  it("只接受十进制字符串作为稳定用户 ID 与动态 ID", () => {
    expect(Either.isRight(parseXUserId("1234567890123456789"))).toBe(true);
    expect(Either.isRight(parseActivityId("987654321"))).toBe(true);
    expect(Either.isLeft(parseXUserId(""))).toBe(true);
    expect(Either.isLeft(parseXUserId("12a34"))).toBe(true);
    expect(Either.isLeft(parseActivityId(12345))).toBe(true);
  });

  it("去除用户名的 @、空白并统一为小写", () => {
    const handle = expectRight(parseXHandle("  @OpenAI_Dev  "));
    expect(handle).toBe("openai_dev");
  });

  it("拒绝不合法或超过 15 个字符的用户名", () => {
    expect(Either.isLeft(parseXHandle("has-hyphen"))).toBe(true);
    expect(Either.isLeft(parseXHandle("abcdefghijklmnop"))).toBe(true);
    expect(Either.isLeft(parseXHandle("@"))).toBe(true);
  });

  it("按 Snowflake 数值长度与字典序比较动态 ID", () => {
    const older = expectRight(parseActivityId("999"));
    const newer = expectRight(parseActivityId("1000"));
    const newest = expectRight(parseActivityId("1001"));

    expect(compareActivityId(older, newer)).toBeLessThan(0);
    expect(compareActivityId(newer, newest)).toBeLessThan(0);
    expect(isActivityAfter(newest, newer)).toBe(true);
    expect(isActivityAfter(newer, newest)).toBe(false);
  });
});
