import { Tweet, TweetMedia } from "rettiwt-api";

/** Rettiwt 推文 fixture 支持的活动种类。 */
export type RettiwtFixtureKind = "post" | "reply" | "quote" | "retweet";

/** 创建 mapper 所需的最小 Rettiwt 推文结构。 */
const makeBaseTweet = (id: string): Tweet =>
  Object.assign(Object.create(Tweet.prototype), {
    id,
    conversationId: id,
    createdAt: "2026-07-15T00:00:00.000Z",
    entities: {
      hashtags: [],
      mentionedUsers: [],
      urls: ["https://effect.website/docs"],
    },
    fullText: `Rettiwt 动态 ${id}`,
    lang: "zh",
    media: [Object.assign(Object.create(TweetMedia.prototype), {
      id: `media-${id}`,
      type: "VIDEO",
      url: `https://cdn.example.com/${id}.mp4`,
      thumbnailUrl: `https://cdn.example.com/${id}.jpg`,
    })],
    tweetBy: {
      id: "9001",
      userName: "effect_ts",
      fullName: "Effect 中文社区",
    },
    url: `https://x.com/effect_ts/status/${id}`,
  });

/** 创建指定种类的 Rettiwt 推文 fixture。 */
export const makeRettiwtTweet = (
  id: string,
  kind: RettiwtFixtureKind,
): Tweet => {
  const tweet = makeBaseTweet(id);
  if (kind === "reply") {
    tweet.replyTo = "7001";
  }
  if (kind === "quote") {
    tweet.quoted = Object.assign(Object.create(Tweet.prototype), {
      ...makeBaseTweet("7002"),
      tweetBy: {
        id: "9002",
        userName: "quoted_user",
        fullName: "被引用用户",
      },
    });
  }
  if (kind === "retweet") {
    tweet.retweetedTweet = Object.assign(Object.create(Tweet.prototype), {
      ...makeBaseTweet("7003"),
      tweetBy: {
        id: "9003",
        userName: "retweeted_user",
        fullName: "被转推用户",
      },
    });
  }
  return tweet;
};
