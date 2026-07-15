import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ActivityKind, XActivity } from "../../src/domain/activity";
import { deduplicateActivities } from "../../src/domain/activity";
import { mapTwitterTweet } from "../../src/infrastructure/providers/twitterapi/mapper";
import {
  LastTweetsResponseSchema,
  TweetDetailsResponseSchema,
  type TwitterTweet,
} from "../../src/infrastructure/providers/twitterapi/schema";
import {
  decodeRealtimeObject,
  decodeRealtimeText,
} from "../../src/infrastructure/providers/twitterapi/realtime";
import {
  makeFastTweetEnvelope,
  makeFullTweetEnvelope,
  makeTwitterTweet,
} from "./fixtures/twitterapi";

/** 断言 TwitterAPI.io mapper 成功并取出领域动态。 */
const mapSuccessfully = (tweet: TwitterTweet, hint?: string): XActivity => {
  const result = mapTwitterTweet(tweet, hint);
  expect(Either.isRight(result)).toBe(true);
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("TwitterAPI.io payload 与领域映射", () => {
  it.effect("宽松解码顶层及 data 包裹的最近推文响应", () => {
    const tweet = {
      ...makeTwitterTweet("8101"),
      provider_added_field: { future: true },
    };
    return Effect.gen(function* () {
      const topLevel = yield* Schema.decodeUnknown(LastTweetsResponseSchema)({
        tweets: [tweet],
        has_next_page: false,
        next_cursor: "",
        response_added_field: 1,
      });
      const wrapped = yield* Schema.decodeUnknown(LastTweetsResponseSchema)({
        data: {
          tweets: [tweet],
          has_next_page: false,
          next_cursor: "",
          response_added_field: 2,
        },
      });
      expect("tweets" in topLevel ? topLevel.tweets : []).toHaveLength(1);
      expect("data" in wrapped ? wrapped.data.tweets : []).toHaveLength(1);
    });
  });

  it.effect("宽松解码 Tweet Details 支持的三种数组包装", () => {
    const tweet = makeTwitterTweet("8102");
    return Effect.gen(function* () {
      const responses = yield* Effect.all([
        Schema.decodeUnknown(TweetDetailsResponseSchema)({ tweets: [tweet], extra: true }),
        Schema.decodeUnknown(TweetDetailsResponseSchema)({ data: [tweet], extra: true }),
        Schema.decodeUnknown(TweetDetailsResponseSchema)([tweet]),
      ]);
      expect(responses).toHaveLength(3);
    });
  });

  const classificationCases: ReadonlyArray<
    readonly [string, TwitterTweet, ActivityKind]
  > = [
    ["普通推文", makeTwitterTweet("8201"), "post"],
    ["回复", makeTwitterTweet("8202", { isReply: true, inReplyToId: "7101" }), "reply"],
    [
      "引用",
      makeTwitterTweet("8203", {
        quoted_tweet: makeTwitterTweet("7102", {
          author: { id: "9002", userName: "quoted_user", name: "被引用用户" },
        }),
      }),
      "quote",
    ],
    [
      "转推",
      makeTwitterTweet("8204", {
        retweeted_tweet: makeTwitterTweet("7103", {
          author: { id: "9003", userName: "retweeted_user", name: "被转推用户" },
        }),
      }),
      "retweet",
    ],
  ];

  it.each(classificationCases)("将%s分类为 %s", (_label, tweet, expected) => {
    const activity = mapSuccessfully(tweet);
    expect(activity.kind).toBe(expected);
    expect(activity.authorHandle).toBe("effect_ts");
  });

  it("按 Tweet ID 去重并保留首次映射结果", () => {
    const first = mapSuccessfully(makeTwitterTweet("8301", { text: "首次" }));
    const duplicate = mapSuccessfully(
      makeTwitterTweet("8301", { text: "重复", isReply: true }),
    );
    const unique = deduplicateActivities([first, duplicate]);
    expect(unique).toHaveLength(1);
    expect(unique[0]?.body.text).toBe("首次");
    expect(unique[0]?.kind).toBe("post");
  });

  it("为视频与 GIF 选择最高码率 MP4 变体并保留预览图", () => {
    const activity = mapSuccessfully(makeTwitterTweet("8351", {
      media: [{
        type: "animated_gif",
        preview_image_url: "https://cdn.example.com/8351.jpg",
        variants: [
          { url: "https://cdn.example.com/8351.m3u8", content_type: "application/x-mpegURL" },
          { url: "https://cdn.example.com/8351-low.mp4", content_type: "video/mp4", bitrate: 256_000 },
          { url: "https://cdn.example.com/8351.mp4", content_type: "video/mp4", bitrate: 832_000 },
        ],
      }],
    }));
    expect(activity.body.media[0]?.kind).toBe("gif");
    expect(activity.body.media[0]?.url).toBe("https://cdn.example.com/8351.mp4");
    expect(Option.getOrNull(activity.body.media[0]?.previewUrl ?? Option.none())).toBe(
      "https://cdn.example.com/8351.jpg",
    );
  });

  it("在视频缺少可播放地址时把预览图安全降级为图片", () => {
    const activity = mapSuccessfully(makeTwitterTweet("8352", {
      media: [{
        type: "video",
        preview_image_url: "https://cdn.example.com/8352.jpg",
      }],
    }));
    expect(activity.body.media[0]).toMatchObject({
      kind: "image",
      url: "https://cdn.example.com/8352.jpg",
    });
  });

  it.effect("fast 与 full 事件使用相同 Tweet ID 幂等键", () =>
    Effect.gen(function* () {
      const fast = yield* decodeRealtimeObject(makeFastTweetEnvelope("8401"));
      const full = yield* decodeRealtimeText(JSON.stringify(makeFullTweetEnvelope("8401")));
      expect(fast).toHaveLength(1);
      expect(full).toHaveLength(1);
      expect(fast[0]?.eventKey).toBe("activity:8401");
      expect(full[0]?.eventKey).toBe(fast[0]?.eventKey);
      expect(fast[0]?.reduced).toBe(true);
      expect(full[0]?.reduced).toBe(false);
      expect(Option.isSome(fast[0]?.activityId ?? Option.none())).toBe(true);
    }),
  );

});
