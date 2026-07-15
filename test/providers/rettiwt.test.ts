import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { ActivityKind, XActivity } from "../../src/domain/activity";
import { classifyRettiwtError } from "../../src/infrastructure/providers/rettiwt/error-classification";
import { mapRettiwtTweet } from "../../src/infrastructure/providers/rettiwt/mapper";
import {
  makeRettiwtTweet,
  type RettiwtFixtureKind,
} from "./fixtures/rettiwt";

/** 断言 Rettiwt mapper 成功并取出领域动态。 */
const mapSuccessfully = (
  id: string,
  kind: RettiwtFixtureKind,
): XActivity => {
  const result = mapRettiwtTweet(makeRettiwtTweet(id, kind));
  expect(Either.isRight(result)).toBe(true);
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("Rettiwt 领域映射", () => {
  const classificationCases: ReadonlyArray<
    readonly [RettiwtFixtureKind, ActivityKind]
  > = [
    ["post", "post"],
    ["reply", "reply"],
    ["quote", "quote"],
    ["retweet", "retweet"],
  ];

  it.each(classificationCases)("将 %s 分类为 %s", (fixtureKind, expected) => {
    const activity = mapSuccessfully("9101", fixtureKind);
    expect(activity.kind).toBe(expected);
    expect(activity.authorId).toBe("9001");
    expect(activity.authorHandle).toBe("effect_ts");
  });

  it("映射展开链接、视频与缩略图", () => {
    const activity = mapSuccessfully("9102", "post");
    expect(activity.body.expandedUrls).toEqual(["https://effect.website/docs"]);
    expect(activity.body.media).toHaveLength(1);
    expect(activity.body.media[0]?.kind).toBe("video");
    expect(activity.body.media[0]?.url).toBe("https://cdn.example.com/9102.mp4");
    expect(Option.getOrNull(activity.body.media[0]?.previewUrl ?? Option.none())).toBe(
      "https://cdn.example.com/9102.jpg",
    );
  });

  it("映射引用与转推的嵌套正文", () => {
    const quote = mapSuccessfully("9103", "quote");
    const retweet = mapSuccessfully("9104", "retweet");
    expect(Option.getOrNull(quote.reference)?.kind).toBe("quote");
    expect(Option.getOrNull(quote.reference)?.authorHandle).toBe("quoted_user");
    expect(Option.getOrNull(retweet.reference)?.kind).toBe("retweet");
    expect(Option.getOrNull(retweet.reference)?.authorHandle).toBe("retweeted_user");
  });

  it("映射回复目标 ID", () => {
    const reply = mapSuccessfully("9105", "reply");
    expect(Option.getOrNull(reply.replyToId)).toBe("7001");
  });

  it.each([
    "Invalid authentication data",
    "Failed to authenticate",
    "Not authorized to access requested resource",
  ])("将 SDK 认证文案 %s 识别为认证错误", (message) => {
    expect(classifyRettiwtError(new Error(message))._tag).toBe("AuthenticationError");
  });

  it("识别 SDK 普通对象携带的认证文案", () => {
    expect(classifyRettiwtError({ message: "Not authorized" })._tag).toBe(
      "AuthenticationError",
    );
  });
});
