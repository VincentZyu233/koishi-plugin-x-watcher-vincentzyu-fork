import { describe, expect, it } from "@effect/vitest";
import * as Either from "effect/Either";
import { createMessagePlan } from "../../src/domain/message";
import { mapTwitterTweet } from "../../src/infrastructure/providers/twitterapi/mapper";
import { makeTwitterTweet } from "../providers/fixtures/twitterapi";

describe("持久化消息计划", () => {
  it("合并自身与引用媒体、按 URL 去重并冻结顺序", () => {
    const shared = "https://cdn.example/shared.jpg";
    const mapped = mapTwitterTweet(
      makeTwitterTweet("1900000000000000010", {
        media: [shared],
        quoted_tweet: makeTwitterTweet("1900000000000000009", {
          author: { id: "9002", userName: "quoted_user", name: "被引用用户" },
          media: [shared, "https://cdn.example/nested.mp4"],
        }),
      }),
    );
    expect(Either.isRight(mapped)).toBe(true);
    if (Either.isLeft(mapped)) throw mapped.left;
    const plan = createMessagePlan(mapped.right, true);
    expect(plan.media.map((media) => media.url)).toEqual([
      shared,
      "https://cdn.example/nested.mp4",
    ]);
    expect(plan.media.map((media) => media.order)).toEqual([0, 1]);
  });
});
