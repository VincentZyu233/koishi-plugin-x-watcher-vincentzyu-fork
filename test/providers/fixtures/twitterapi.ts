import type { TwitterTweet } from "../../../src/infrastructure/providers/twitterapi/schema";

/** 创建字段完整但可局部覆盖的 TwitterAPI.io 推文 fixture。 */
export const makeTwitterTweet = (
  id: string,
  overrides: Partial<TwitterTweet> = {},
): TwitterTweet => ({
  id,
  url: `https://x.com/effect_ts/status/${id}`,
  text: `动态 ${id}`,
  createdAt: "2026-07-15T00:00:00.000Z",
  author: {
    id: "9001",
    userName: "effect_ts",
    name: "Effect 中文社区",
  },
  ...overrides,
});

/** 创建 TwitterAPI.io fast_tweet 实时事件 fixture。 */
export const makeFastTweetEnvelope = (id: string) => ({
  event_type: "fast_tweet",
  timestamp: 1_752_537_600_000,
  tweet: {
    id,
    screen_name: "effect_ts",
    display_name: "Effect 中文社区",
    text: `动态 ${id}`,
    type: "tweet",
    created_ms: 1_752_537_600_000,
    user_id: "9001",
    provider_added_field: "允许忽略的未来字段",
  },
  envelope_added_field: true,
});

/** 创建 TwitterAPI.io 标准 tweet 实时事件 fixture。 */
export const makeFullTweetEnvelope = (id: string) => ({
  event_type: "tweet",
  timestamp: 1_752_537_600_000,
  tweets: [
    {
      ...makeTwitterTweet(id),
      provider_added_field: "允许忽略的未来字段",
    },
  ],
  envelope_added_field: true,
});
