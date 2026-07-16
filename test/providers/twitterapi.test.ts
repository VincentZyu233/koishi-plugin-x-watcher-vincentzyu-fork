import { describe, expect, it } from "vitest";
import type { Context } from "koishi";
import {
  createTwitterApiDataSource,
  decodeTwitterApiActivityPage,
  decodeTwitterApiUser,
  type TwitterApiContext,
} from "../../src/providers/twitterapi";

/** 编译期确认真实 Koishi Context 可直接注入工厂。 */
function createWithKoishiContext(ctx: Context) {
  return createTwitterApiDataSource(ctx, "compile-only-key");
}

void createWithKoishiContext;

interface RecordedRequest {
  readonly url: string;
  readonly responseType: string;
  readonly headers: Headers;
}

function textResponse(
  text: string,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(text, { status, headers });
}

function jsonResponse(
  value: object,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return textResponse(JSON.stringify(value), status, {
    "content-type": "application/json",
    ...headers,
  });
}

function tweetFixture(id: string, createdAt: Date) {
  return {
    id,
    url: `https://x.com/example/status/${id}`,
    text: `tweet-${id}`,
    createdAt: createdAt.toISOString(),
    author: {
      id: "100",
      userName: "Example",
      name: "示例用户",
    },
    entities: {
      hashtags: [],
      urls: [],
      user_mentions: [],
    },
  };
}

function snowflakeFor(date: Date, sequence = 0): string {
  const timestamp = BigInt(date.getTime()) - 1_288_834_974_657n;
  return ((timestamp << 22n) + BigInt(sequence)).toString();
}

function requestAt(
  requests: ReadonlyArray<RecordedRequest>,
  index: number,
): RecordedRequest {
  const request = requests[index];
  if (request === undefined) throw new Error(`缺少第 ${index + 1} 个请求`);
  return request;
}

async function createHttpHarness(
  responses: Array<Response | Error>,
): Promise<{
  readonly ctx: TwitterApiContext;
  readonly requests: Array<RecordedRequest>;
}> {
  const requests: Array<RecordedRequest> = [];
  const ctx: TwitterApiContext = {
    http: async (url, config) => {
      const requestUrl = new URL(url);
      for (const [key, value] of Object.entries(config.params)) {
        requestUrl.searchParams.set(key, String(value));
      }
      requests.push({
        url: requestUrl.toString(),
        responseType: config.responseType,
        headers: new Headers(config.headers),
      });
      const response = responses.shift();
      if (response === undefined) throw new Error("测试响应队列已耗尽");
      if (response instanceof Error) throw response;
      return {
        status: response.status,
        data: await response.text(),
        headers: response.headers,
      };
    },
  };
  return { ctx, requests };
}

describe("TwitterAPI.io 解码", () => {
  it("严格接受官方 data 包装的用户响应", () => {
    const wrapped = decodeTwitterApiUser(JSON.stringify({
      data: {
        id: "101",
        userName: "WrappedUser",
        name: "Wrapped User",
      },
      status: "success",
    }));

    expect(wrapped).toEqual({
      ok: true,
      value: {
        id: "101",
        username: "WrappedUser",
        fullname: "Wrapped User",
      },
    });
  });

  it("拒绝缺字段和非法 JSON", () => {
    const missing = decodeTwitterApiUser(JSON.stringify({
      id: "100",
      userName: "UndocumentedRoot",
      name: "Undocumented Root",
    }));
    const invalid = decodeTwitterApiUser("{");
    const explicitError = decodeTwitterApiUser(JSON.stringify({
      data: { id: "100", userName: "Example", name: "Example" },
      status: "error",
    }));

    expect(missing.ok).toBe(false);
    expect(invalid.ok).toBe(false);
    expect(explicitError.ok).toBe(false);
    if (!missing.ok) expect(missing.error.kind).toBe("decode");
    if (!invalid.ok) expect(invalid.error.kind).toBe("decode");
  });

  it("识别四类动态并归一、去重媒体", () => {
    const createdAt = new Date("2026-07-16T01:00:00.000Z");
    const decoded = decodeTwitterApiActivityPage(JSON.stringify({
      tweets: [
          {
            ...tweetFixture("200", createdAt),
            media: [{
              type: "photo",
              media_url_https: "https://pbs.twimg.com/one.jpg",
            }],
            extendedEntities: {
              media: [{
                type: "photo",
                media_url_https: "https://pbs.twimg.com/one.jpg",
              }],
            },
          },
          {
            ...tweetFixture("201", createdAt),
            isReply: true,
            extended_entities: {
              media: [{
                type: "video",
                media_url_https: "https://pbs.twimg.com/video-preview.jpg",
                variants: [
                  {
                    content_type: "application/x-mpegURL",
                    url: "https://video.twimg.com/list.m3u8",
                  },
                  {
                    content_type: "video/mp4",
                    bitrate: 256000,
                    url: "https://video.twimg.com/low.mp4",
                  },
                  {
                    content_type: "video/mp4",
                    bitrate: 832000,
                    url: "https://video.twimg.com/high.mp4",
                  },
                ],
              }],
            },
          },
          {
            ...tweetFixture("202", createdAt),
            quoted_tweet: { id: "102" },
            entities: {
              media: [{
                type: "animated_gif",
                media_url_https: "https://pbs.twimg.com/gif-preview.jpg",
                video_info: {
                  variants: [{
                    content_type: "video/mp4",
                    url: "https://video.twimg.com/gif.mp4",
                  }],
                },
              }],
            },
          },
          {
            ...tweetFixture("203", createdAt),
            retweeted_tweet: {
              id: "101",
              extendedEntities: {
                media: [{
                  type: "photo",
                  media_url_https: "https://pbs.twimg.com/retweet.jpg",
                }],
              },
            },
            isReply: true,
          },
      ],
      has_next_page: false,
      next_cursor: "",
    }));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.value.activities.map((activity) => activity.kind)).toEqual([
      "post",
      "reply",
      "quote",
      "retweet",
    ]);
    expect(decoded.value.activities[0]).toMatchObject({
      media: [{ kind: "image", url: "https://pbs.twimg.com/one.jpg" }],
    });
    expect(decoded.value.activities[1]).toMatchObject({
      media: [{ kind: "video", url: "https://video.twimg.com/high.mp4" }],
    });
    expect(decoded.value.activities[2]).toMatchObject({
      media: [{ kind: "gif", url: "https://video.twimg.com/gif.mp4" }],
    });
    expect(decoded.value.activities[3]).toMatchObject({
      media: [{ kind: "image", url: "https://pbs.twimg.com/retweet.jpg" }],
    });
  });
});

describe("TwitterAPI.io 数据源", () => {
  it("通过正确端点、文本响应和密钥解析用户", async () => {
    const harness = await createHttpHarness([
      jsonResponse({
        data: { id: "100", userName: "Example", name: "示例用户" },
        status: "success",
      }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.resolveUser("Example");

    expect(result).toEqual({
      ok: true,
      value: { id: "100", username: "Example", fullname: "示例用户" },
    });
    const request = requestAt(harness.requests, 0);
    const url = new URL(request.url);
    expect(url.pathname).toBe("/twitter/user/info");
    expect(url.searchParams.get("userName")).toBe("Example");
    expect(request.responseType).toBe("text");
    expect(request.headers.get("X-API-Key")).toBe("secret-key");
  });

  it("用 last_tweets 建立包含回复的最新水位", async () => {
    const createdAt = new Date("2026-07-16T01:00:00.000Z");
    const harness = await createHttpHarness([
      jsonResponse({
        tweets: [
          tweetFixture("900000000000000001", createdAt),
          tweetFixture("900000000000000003", createdAt),
          tweetFixture("900000000000000002", createdAt),
        ],
        has_next_page: true,
        next_cursor: "unused",
      }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.fetchBaseline({
      id: "100",
      username: "Example",
      fullname: "示例用户",
    });

    expect(result).toEqual({ ok: true, value: "900000000000000003" });
    const url = new URL(requestAt(harness.requests, 0).url);
    expect(url.pathname).toBe("/twitter/user/last_tweets");
    expect(url.searchParams.get("userId")).toBe("100");
    expect(url.searchParams.get("includeReplies")).toBe("true");
  });

  it("完整翻页、按水位过滤、去重并从旧到新排序", async () => {
    const cursorDate = new Date("2026-07-16T01:00:00.000Z");
    const firstDate = new Date("2026-07-16T01:01:00.000Z");
    const secondDate = new Date("2026-07-16T01:02:00.000Z");
    const oldId = snowflakeFor(new Date("2026-07-16T00:59:00.000Z"));
    const cursorId = snowflakeFor(cursorDate);
    const firstId = snowflakeFor(firstDate);
    const secondId = snowflakeFor(secondDate);
    const harness = await createHttpHarness([
      jsonResponse({
        tweets: [
          tweetFixture(secondId, secondDate),
        ],
        has_next_page: true,
        next_cursor: "page-2",
      }),
      jsonResponse({
        tweets: [
          tweetFixture(firstId, firstDate),
          tweetFixture(oldId, new Date("2026-07-16T00:59:00.000Z")),
        ],
        has_next_page: true,
        next_cursor: "page-3-must-not-be-read",
      }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");
    const until = new Date("2026-07-16T01:03:00.000Z");

    const result = await source.fetchAfter(
      { id: "100", username: "Example", fullname: "示例用户" },
      { lastId: cursorId, enabledAt: new Date("2026-07-15T00:00:00.000Z") },
      until,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.activities.map((activity) => activity.id)).toEqual([
      firstId,
      secondId,
    ]);
    expect(result.value.newestId).toBe(secondId);
    expect(harness.requests).toHaveLength(2);

    const firstUrl = new URL(requestAt(harness.requests, 0).url);
    const secondUrl = new URL(requestAt(harness.requests, 1).url);
    expect(firstUrl.pathname).toBe("/twitter/tweet/advanced_search");
    expect(firstUrl.searchParams.get("queryType")).toBe("Latest");
    expect(firstUrl.searchParams.get("cursor")).toBeNull();
    expect(firstUrl.searchParams.get("query")).toBe(
      `from:Example include:nativeretweets since_time:${Math.floor(cursorDate.getTime() / 1_000)} until_time:${Math.floor(until.getTime() / 1_000)}`,
    );
    expect(secondUrl.searchParams.get("cursor")).toBe("page-2");
  });

  it("分页游标变化但动态 ID 不前进时拒绝继续请求", async () => {
    const createdAt = new Date("2026-07-16T01:01:00.000Z");
    const tweetId = snowflakeFor(createdAt);
    const harness = await createHttpHarness([
      jsonResponse({
        tweets: [tweetFixture(tweetId, createdAt)],
        has_next_page: true,
        next_cursor: "page-2",
      }),
      jsonResponse({
        tweets: [tweetFixture(tweetId, createdAt)],
        has_next_page: true,
        next_cursor: "page-3",
      }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.fetchAfter(
      { id: "100", username: "Example", fullname: "示例用户" },
      { lastId: null, enabledAt: new Date("2026-07-16T01:00:00.000Z") },
      new Date("2026-07-16T01:02:00.000Z"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("decode");
    expect(harness.requests).toHaveLength(2);
  });

  it("空中间页携带有效游标时继续翻页而不漏动态", async () => {
    const createdAt = new Date("2026-07-16T01:01:00.000Z");
    const tweetId = snowflakeFor(createdAt);
    const harness = await createHttpHarness([
      jsonResponse({
        tweets: [],
        has_next_page: true,
        next_cursor: "page-2",
      }),
      jsonResponse({
        tweets: [tweetFixture(tweetId, createdAt)],
        has_next_page: false,
        next_cursor: "",
      }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.fetchAfter(
      { id: "100", username: "Example", fullname: "示例用户" },
      { lastId: null, enabledAt: new Date("2026-07-16T01:00:00.000Z") },
      new Date("2026-07-16T01:02:00.000Z"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.activities.map((activity) => activity.id)).toEqual([
      tweetId,
    ]);
    expect(result.value.newestId).toBe(tweetId);
    expect(harness.requests).toHaveLength(2);
    const secondUrl = new URL(requestAt(harness.requests, 1).url);
    expect(secondUrl.searchParams.get("cursor")).toBe("page-2");
  });

  it("检测重复分页游标并拒绝返回部分结果", async () => {
    const createdAt = new Date("2026-07-16T01:01:00.000Z");
    const tweetId = snowflakeFor(createdAt);
    const page = {
      tweets: [tweetFixture(tweetId, createdAt)],
      has_next_page: true,
      next_cursor: "same-cursor",
    };
    const harness = await createHttpHarness([
      jsonResponse(page),
      jsonResponse(page),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.fetchAfter(
      { id: "100", username: "Example", fullname: "示例用户" },
      { lastId: null, enabledAt: new Date("2026-07-16T01:00:00.000Z") },
      new Date("2026-07-16T01:02:00.000Z"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("decode");
    expect(harness.requests).toHaveLength(2);
  });

  it("网络、429 和 5xx 最多额外重试两次", async () => {
    const userBody = {
      data: { id: "100", userName: "Example", name: "示例用户" },
    };
    const networkHarness = await createHttpHarness([
      new Error("offline"),
      new Error("offline"),
      jsonResponse(userBody),
    ]);
    const networkSource = createTwitterApiDataSource(
      networkHarness.ctx,
      "secret-key",
    );
    const networkResult = await networkSource.resolveUser("Example");
    expect(networkResult.ok).toBe(true);
    expect(networkHarness.requests).toHaveLength(3);

    const serverHarness = await createHttpHarness([
      textResponse("unavailable", 503, { "Retry-After": "0" }),
      textResponse("limited", 429, { "Retry-After": "0" }),
      jsonResponse(userBody),
    ]);
    const serverSource = createTwitterApiDataSource(
      serverHarness.ctx,
      "secret-key",
    );
    const serverResult = await serverSource.resolveUser("Example");
    expect(serverResult.ok).toBe(true);
    expect(serverHarness.requests).toHaveLength(3);
  });

  it("限流重试耗尽后保留 Retry-After", async () => {
    const harness = await createHttpHarness([
      textResponse("limited", 429, { "Retry-After": "0" }),
      textResponse("limited", 429, { "Retry-After": "0" }),
      textResponse("limited", 429, { "Retry-After": "0" }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.resolveUser("Example");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("rate-limit");
      expect(result.error.retryAfterMilliseconds).toBe(0);
    }
    expect(harness.requests).toHaveLength(3);
  });

  it.each([
    [400, "unavailable"],
    [401, "authentication"],
    [403, "authentication"],
  ])("HTTP %i 不重试并返回 %s", async (status, kind) => {
    const harness = await createHttpHarness([
      textResponse("client error", status),
      jsonResponse({ data: { id: "100", userName: "x", name: "x" } }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.resolveUser("Example");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
    expect(harness.requests).toHaveLength(1);
  });

  it("成功响应解码失败时不重试", async () => {
    const harness = await createHttpHarness([
      textResponse("{"),
      jsonResponse({ data: { id: "100", userName: "x", name: "x" } }),
    ]);
    const source = createTwitterApiDataSource(harness.ctx, "secret-key");

    const result = await source.resolveUser("Example");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("decode");
    expect(harness.requests).toHaveLength(1);
  });
});
