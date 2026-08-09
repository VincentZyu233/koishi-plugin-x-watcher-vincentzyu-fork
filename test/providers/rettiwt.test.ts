import { describe, expect, it } from "vitest";

import type { XUser } from "../../src/domain";
import {
  createRettiwtDataSource,
  type RettiwtClient,
  type RettiwtClientConfiguration,
  type RettiwtPage,
  type RettiwtTweetData,
  type RettiwtUserData,
} from "../../src/providers/rettiwt";

const resolvedUser: RettiwtUserData = {
  id: "42",
  username: "alice",
  fullname: "Alice",
};

const domainUser: XUser = {
  id: "42",
  username: "alice",
  fullname: "Alice",
};

interface FakeClientBehavior {
  readonly resolve?: () => Promise<RettiwtUserData | null>;
  readonly timeline?: (cursor: string | null) => Promise<RettiwtPage>;
  readonly replies?: (cursor: string | null) => Promise<RettiwtPage>;
}

function emptyPage(): RettiwtPage {
  return { tweets: [], nextCursor: null };
}

function createFakeClient(
  behavior: FakeClientBehavior = {},
): RettiwtClient {
  const resolve = behavior.resolve;
  const timeline = behavior.timeline;
  const replies = behavior.replies;
  return {
    resolveUser: resolve === undefined
      ? async () => resolvedUser
      : async () => resolve(),
    fetchTimeline: timeline === undefined
      ? async () => emptyPage()
      : async (_userId, cursor) => timeline(cursor),
    fetchReplies: replies === undefined
      ? async () => emptyPage()
      : async (_userId, cursor) => replies(cursor),
  };
}

function makeFactory(
  clients: ReadonlyMap<string, RettiwtClient>,
): (
  apiKey: string,
  configuration: RettiwtClientConfiguration,
) => RettiwtClient {
  return (apiKey) => {
    const client = clients.get(apiKey);
    if (client === undefined) throw new Error("missing fake client");
    return client;
  };
}

function makeTweet(
  id: string,
  createdAt: string,
  changes: Partial<RettiwtTweetData> = {},
): RettiwtTweetData {
  return {
    id,
    authorId: "42",
    username: "alice",
    fullname: "Alice",
    text: `tweet-${id}`,
    createdAt,
    url: `https://x.com/alice/status/${id}`,
    media: [],
    replyTo: null,
    hasQuote: false,
    hasRetweet: false,
    ...changes,
  };
}

describe("createRettiwtDataSource", () => {
  it("按顺序构造客户端并强制关闭 SDK 重试与日志", async () => {
    const configurations: RettiwtClientConfiguration[] = [];
    const keys: string[] = [];
    const service = createRettiwtDataSource({
      apiKeys: ["first-key", "second-key"],
      createClient: (apiKey, configuration) => {
        keys.push(apiKey);
        configurations.push(configuration);
        return createFakeClient();
      },
    });

    const result = await service.resolveUser("alice");

    expect(result).toEqual({ ok: true, value: domainUser });
    expect(keys).toEqual(["first-key", "second-key"]);
    expect(configurations).toEqual([
      { maxRetries: 0, logging: false },
      { maxRetries: 0, logging: false },
    ]);
  });

  it("把显式代理传给每个 Rettiwt 客户端", async () => {
    const configurations: RettiwtClientConfiguration[] = [];
    const service = createRettiwtDataSource({
      apiKeys: ["first-key", "second-key"],
      proxy: "http://127.0.0.1:7890/",
      createClient: (_apiKey, configuration) => {
        configurations.push(configuration);
        return createFakeClient();
      },
    });

    expect((await service.resolveUser("alice")).ok).toBe(true);
    expect(configurations).toEqual([
      {
        maxRetries: 0,
        logging: false,
        proxy: "http://127.0.0.1:7890/",
      },
      {
        maxRetries: 0,
        logging: false,
        proxy: "http://127.0.0.1:7890/",
      },
    ]);
  });

  it("隔离构造失败的凭据且日志不包含 key", async () => {
    const messages: string[] = [];
    const secret = "very-secret-cookie";
    const secondary = createFakeClient();
    const service = createRettiwtDataSource({
      apiKeys: [secret, "working-key"],
      logger: { warn: (message) => messages.push(message) },
      createClient: (apiKey) => {
        if (apiKey === secret) throw new Error(`bad ${secret}`);
        return secondary;
      },
    });

    const result = await service.resolveUser("alice");

    expect(result.ok).toBe(true);
    expect(messages).toHaveLength(1);
    expect(messages.join(" ")).not.toContain(secret);
    expect(messages[0]).toContain("#1");
  });

  it("认证失败后永久隔离当前凭据并回退到下一枚", async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const primary = createFakeClient({
      resolve: async () => {
        primaryCalls += 1;
        throw new Error("401 Unauthorized");
      },
    });
    const secondary = createFakeClient({
      resolve: async () => {
        secondaryCalls += 1;
        return resolvedUser;
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["primary", "secondary"],
      createClient: makeFactory(new Map([
        ["primary", primary],
        ["secondary", secondary],
      ])),
    });

    await service.resolveUser("alice");
    await service.resolveUser("alice");

    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(2);
  });

  it("429 缺少响应头时回退冷却当前凭据 60 秒", async () => {
    let clock = 1_000;
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const primary = createFakeClient({
      resolve: async () => {
        primaryCalls += 1;
        if (primaryCalls === 1) throw new Error("429 Too Many Requests");
        return resolvedUser;
      },
    });
    const secondary = createFakeClient({
      resolve: async () => {
        secondaryCalls += 1;
        return resolvedUser;
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["primary", "secondary"],
      now: () => clock,
      createClient: makeFactory(new Map([
        ["primary", primary],
        ["secondary", secondary],
      ])),
    });

    await service.resolveUser("alice");
    await service.resolveUser("alice");
    clock += 60_001;
    await service.resolveUser("alice");

    expect(primaryCalls).toBe(2);
    expect(secondaryCalls).toBe(2);
  });

  it("其他传输错误不会隔离凭据，后续调用仍从第一枚开始", async () => {
    let primaryCalls = 0;
    let secondaryCalls = 0;
    const primary = createFakeClient({
      resolve: async () => {
        primaryCalls += 1;
        throw new Error("socket hang up");
      },
    });
    const secondary = createFakeClient({
      resolve: async () => {
        secondaryCalls += 1;
        return resolvedUser;
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["primary", "secondary"],
      createClient: makeFactory(new Map([
        ["primary", primary],
        ["secondary", secondary],
      ])),
    });

    await service.resolveUser("alice");
    await service.resolveUser("alice");

    expect(primaryCalls).toBe(2);
    expect(secondaryCalls).toBe(2);
  });

  it("所有凭据冷却时返回剩余重试时间", async () => {
    let clock = 10_000;
    const limited = createFakeClient({
      resolve: async () => {
        throw new Error("rate limit 429");
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["limited"],
      now: () => clock,
      createClient: makeFactory(new Map([["limited", limited]])),
    });

    const first = await service.resolveUser("alice");
    clock += 10_000;
    const second = await service.resolveUser("alice");

    expect(first).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "rate-limit",
        message: "Rettiwt 请求受到速率限制",
        retryAfterMilliseconds: 60_000,
      },
    });
    expect(second).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "rate-limit",
        message: "所有 Rettiwt 凭据的用户解析均处于冷却期",
        retryAfterMilliseconds: 50_000,
      },
    });
  });

  it("按端点采用响应头 reset，timeline 限流不阻塞用户解析", async () => {
    let clock = 1_000;
    let timelineCalls = 0;
    let resolveCalls = 0;
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      now: () => clock,
      createClient: (_apiKey, _configuration, observeRateLimit) =>
        createFakeClient({
          resolve: async () => {
            resolveCalls += 1;
            return resolvedUser;
          },
          timeline: async () => {
            timelineCalls += 1;
            observeRateLimit("timeline", {
              remaining: 0,
              resetAt: 31_000,
            });
            throw new Error("429 Too Many Requests");
          },
        }),
    });

    const first = await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );
    const second = await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );
    const resolved = await service.resolveUser("alice");

    expect(first).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "rate-limit",
        message: "Rettiwt 请求受到速率限制",
        retryAfterMilliseconds: 31_000,
      },
    });
    expect(second).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "rate-limit",
        message: "所有 Rettiwt 凭据的推文时间线均处于冷却期",
        retryAfterMilliseconds: 31_000,
      },
    });
    expect(resolved.ok).toBe(true);
    expect(timelineCalls).toBe(1);
    expect(resolveCalls).toBe(1);

    clock = 32_001;
    await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );
    expect(timelineCalls).toBe(2);
  });

  it("成功响应 remaining 为零时会在下一次调用前主动冷却该端点", async () => {
    let timelineCalls = 0;
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      now: () => 1_000,
      createClient: (_apiKey, _configuration, observeRateLimit) =>
        createFakeClient({
          timeline: async () => {
            timelineCalls += 1;
            observeRateLimit("timeline", {
              remaining: 0,
              resetAt: 61_000,
            });
            return emptyPage();
          },
        }),
    });

    expect((await service.fetchBaseline(domainUser)).ok).toBe(true);
    const result = await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "rate-limit",
        message: "所有 Rettiwt 凭据的推文时间线均处于冷却期",
        retryAfterMilliseconds: 61_000,
      },
    });
    expect(timelineCalls).toBe(1);
  });

  it("用户不存在时返回稳定的 not-found 错误", async () => {
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => createFakeClient({
        resolve: async () => null,
      }),
    });

    const result = await service.resolveUser("nobody");

    expect(result).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "not-found",
        message: "X 用户不存在",
        retryAfterMilliseconds: null,
      },
    });
  });

  it("基线合并 timeline 与 replies，并忽略其他账号动态", async () => {
    const client = createFakeClient({
      timeline: async () => ({
        tweets: [
          makeTweet("300", "2026-07-10T00:00:00.000Z"),
          makeTweet("999", "2026-07-10T00:00:00.000Z", {
            authorId: "other",
            username: "other",
          }),
        ],
        nextCursor: "unused",
      }),
      replies: async () => ({
        tweets: [makeTweet("350", "2026-07-10T01:00:00.000Z")],
        nextCursor: null,
      }),
    });
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => client,
    });

    const result = await service.fetchBaseline(domainUser);

    expect(result).toEqual({ ok: true, value: "350" });
  });

  it("分页合并两类时间线，越过水位后停止并去重升序", async () => {
    const timelineCursors: Array<string | null> = [];
    const replyCursors: Array<string | null> = [];
    const timelinePages = new Map<string, RettiwtPage>([
      ["first", {
        tweets: [
          makeTweet("50", "2026-07-01T00:00:00.000Z"),
          makeTweet("500", "2026-07-11T00:00:00.000Z"),
          makeTweet("400", "2026-07-04T00:00:00.000Z", {
            media: [{ kind: "image", url: "https://img/400.jpg" }],
          }),
        ],
        nextCursor: "t1",
      }],
      ["t1", {
        tweets: [
          makeTweet("300", "2026-07-03T00:00:00.000Z", {
            hasQuote: true,
          }),
          makeTweet("100", "2026-07-02T00:00:00.000Z"),
        ],
        nextCursor: "t2",
      }],
      ["t2", {
        tweets: [makeTweet("90", "2026-07-01T12:00:00.000Z")],
        nextCursor: "must-not-fetch",
      }],
    ]);
    const replyPages = new Map<string, RettiwtPage>([
      ["first", {
        tweets: [
          makeTweet("400", "2026-07-04T00:00:00.000Z"),
          makeTweet("350", "2026-07-03T12:00:00.000Z", {
            replyTo: "12",
          }),
          makeTweet("250", "2026-07-02T12:00:00.000Z", {
            hasRetweet: true,
          }),
        ],
        nextCursor: "r1",
      }],
      ["r1", {
        tweets: [makeTweet("80", "2026-07-01T06:00:00.000Z")],
        nextCursor: "must-not-fetch",
      }],
    ]);
    const client = createFakeClient({
      timeline: async (cursor) => {
        timelineCursors.push(cursor);
        const key = cursor === null ? "first" : cursor;
        const page = timelinePages.get(key);
        if (page === undefined) throw new Error(`unexpected timeline ${key}`);
        return page;
      },
      replies: async (cursor) => {
        replyCursors.push(cursor);
        const key = cursor === null ? "first" : cursor;
        const page = replyPages.get(key);
        if (page === undefined) throw new Error(`unexpected replies ${key}`);
        return page;
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => client,
    });

    const result = await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );

    expect(timelineCursors).toEqual([null, "t1"]);
    expect(replyCursors).toEqual([null, "r1"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.newestId).toBe("400");
    expect(result.value.activities.map((activity) => activity.id)).toEqual([
      "250",
      "300",
      "350",
      "400",
    ]);
    expect(result.value.activities.map((activity) => activity.kind)).toEqual([
      "retweet",
      "quote",
      "reply",
      "post",
    ]);
    expect(result.value.activities[3]).toMatchObject({
      media: [{ kind: "image", url: "https://img/400.jpg" }],
    });
  });

  it("无 Snowflake 水位时以启用时间过滤，并不会被首屏置顶旧帖截断", async () => {
    const cursors: Array<string | null> = [];
    const client = createFakeClient({
      timeline: async (cursor) => {
        cursors.push(cursor);
        if (cursor === null) {
          return {
            tweets: [
              makeTweet("10", "2026-06-01T00:00:00.000Z"),
              makeTweet("30", "2026-07-05T00:00:00.000Z"),
            ],
            nextCursor: "next",
          };
        }
        return {
          tweets: [makeTweet("20", "2026-06-30T00:00:00.000Z")],
          nextCursor: "must-not-fetch",
        };
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => client,
    });

    const result = await service.fetchAfter(
      domainUser,
      { lastId: null, enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );

    expect(cursors).toEqual([null, "next"]);
    expect(result).toEqual({
      ok: true,
      value: {
        activities: [makeTweet("30", "2026-07-05T00:00:00.000Z")].map(
          () => ({
            id: "30",
            authorId: "42",
            username: "alice",
            fullname: "Alice",
            kind: "post",
            text: "tweet-30",
            createdAt: new Date("2026-07-05T00:00:00.000Z"),
            url: "https://x.com/alice/status/30",
            media: [],
          }),
        ),
        newestId: "30",
      },
    });
  });

  it("空 Snowflake 水位下同页新帖后出现旧帖时停止，不触发重复游标", async () => {
    const cursors: Array<string | null> = [];
    const client = createFakeClient({
      timeline: async (cursor) => {
        cursors.push(cursor);
        return {
          tweets: [
            makeTweet("300", "2026-07-03T00:00:00.000Z"),
            makeTweet("100", "2025-09-01T00:00:00.000Z"),
          ],
          nextCursor: "same",
        };
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => client,
    });

    const result = await service.fetchAfter(
      domainUser,
      { lastId: null, enabledAt: new Date("2025-09-09T08:00:29.878Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );

    expect(cursors).toEqual([null]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activities.map((activity) => activity.id)).toEqual([
      "300",
    ]);
  });

  it("空末页原样返回请求游标时安全结束分页", async () => {
    const cursors: Array<string | null> = [];
    const client = createFakeClient({
      timeline: async (cursor) => {
        cursors.push(cursor);
        if (cursor === null) {
          return {
            tweets: [makeTweet("200", "2026-07-02T00:00:00.000Z")],
            nextCursor: "terminal",
          };
        }
        return { tweets: [], nextCursor: "terminal" };
      },
    });
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => client,
    });

    const result = await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );

    expect(cursors).toEqual([null, "terminal"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.activities.map((activity) => activity.id)).toEqual([
      "200",
    ]);
  });

  it("重复分页游标作为解码失败返回，不提交不完整批次", async () => {
    const looping = createFakeClient({
      timeline: async () => ({
        tweets: [makeTweet("200", "2026-07-02T00:00:00.000Z")],
        nextCursor: "same",
      }),
    });
    const service = createRettiwtDataSource({
      apiKeys: ["key"],
      createClient: () => looping,
    });

    const result = await service.fetchAfter(
      domainUser,
      { lastId: "100", enabledAt: new Date("2026-07-01T00:00:00.000Z") },
      new Date("2026-07-10T00:00:00.000Z"),
    );

    expect(result).toEqual({
      ok: false,
      error: {
        provider: "rettiwt",
        kind: "decode",
        message: "Rettiwt 返回了重复的分页游标",
        retryAfterMilliseconds: null,
      },
    });
  });
});
