import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { Context } from "koishi";
import { parseActivityId, parseXUserId } from "../../src/domain/identifiers";
import { makeTwitterApiDataSource } from "../../src/infrastructure/providers/twitterapi/client";
import { makeTwitterTweet } from "./fixtures/twitterapi";

/** 模拟 TwitterAPI.io 最近推文分页响应。 */
interface TimelinePage {
  readonly tweets: ReadonlyArray<unknown>;
  readonly hasNextPage: boolean;
  readonly nextCursor: string;
}

/** 解析恢复测试使用的稳定 X 用户 ID。 */
const testUserId = () => {
  const result = parseXUserId("9001");
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

/** 解析 TwitterAPI.io 恢复测试使用的动态水位。 */
const testCursor = (value: string) => {
  const result = parseActivityId(value);
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

/** 创建按顺序返回多页时间线的 Koishi HTTP 测试上下文。 */
const makePagedHttpContext = (pages: ReadonlyArray<TimelinePage>) => {
  const context: Context = Object.create(null);
  let index = 0;
  const http = vi.fn(async () => {
    const page = pages[index];
    index += 1;
    if (page === undefined) throw new Error("测试请求超过 fixture 页数");
    return {
      url: "https://api.twitterapi.io/twitter/user/last_tweets",
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      data: {
        tweets: page.tweets,
        has_next_page: page.hasNextPage,
        next_cursor: page.nextCursor,
        provider_added_field: "允许忽略的未来字段",
      },
    };
  });
  Object.defineProperty(context, "http", { value: http });
  return { context, http };
};

/** 创建只有一页的 Koishi HTTP 测试上下文。 */
const makeHttpContext = (tweets: ReadonlyArray<unknown>): Context =>
  makePagedHttpContext([{ tweets, hasNextPage: false, nextCursor: "" }]).context;

describe("TwitterAPI.io 恢复上限", () => {
  it.effect("恢复扫描恰好 20 条时不报告溢出", () => {
    const tweets = Array.from({ length: 20 }, (_, index) =>
      makeTwitterTweet(String(8_500 + index)),
    );
    const source = makeTwitterApiDataSource(makeHttpContext(tweets), "offline-test-key");
    return Effect.gen(function* () {
      const batch = yield* source.fetchAfter(testUserId(), Option.none());
      expect(batch.activities).toHaveLength(20);
      expect(batch.overflow).toBe(false);
      expect(batch.overflowBoundary).toBeNull();
      expect(Option.getOrNull(batch.newestId)).toBe("8519");
    });
  });

  it.effect("恢复扫描第 21 条时只返回 20 条并报告溢出", () => {
    const tweets = Array.from({ length: 21 }, (_, index) =>
      makeTwitterTweet(String(8_600 + index)),
    );
    const source = makeTwitterApiDataSource(makeHttpContext(tweets), "offline-test-key");
    return Effect.gen(function* () {
      const batch = yield* source.fetchAfter(testUserId(), Option.none());
      expect(batch.activities).toHaveLength(20);
      expect(batch.overflow).toBe(true);
      expect(batch.activities[0]?.id).toBe("8601");
      expect(batch.activities.at(-1)?.id).toBe("8620");
      expect(batch.overflowBoundary?.id).toBe("8600");
      expect(Option.getOrNull(batch.newestId)).toBe("8620");
    });
  });

  it.effect("首页 raw 重复时继续分页直到第 21 个 unique Tweet", () => {
    const firstPageUnique = Array.from({ length: 20 }, (_, index) =>
      makeTwitterTweet(String(8_700 + index)),
    );
    const firstPage = [...firstPageUnique, makeTwitterTweet("8700")];
    const fixture = makePagedHttpContext([
      { tweets: firstPage, hasNextPage: true, nextCursor: "page-2" },
      {
        tweets: [makeTwitterTweet("8720")],
        hasNextPage: false,
        nextCursor: "",
      },
    ]);
    const source = makeTwitterApiDataSource(fixture.context, "offline-test-key");
    return Effect.gen(function* () {
      const batch = yield* source.fetchAfter(testUserId(), Option.none());
      expect(fixture.http).toHaveBeenCalledTimes(2);
      expect(batch.activities).toHaveLength(20);
      expect(batch.overflow).toBe(true);
      expect(batch.activities[0]?.id).toBe("8701");
      expect(batch.activities.at(-1)?.id).toBe("8720");
      expect(batch.overflowBoundary?.id).toBe("8700");
      expect(Option.getOrNull(batch.newestId)).toBe("8720");
    });
  });

  it.effect("逐项跳过脏推文、保留有效项并推进到脏项的合法 ID", () => {
    const source = makeTwitterApiDataSource(makeHttpContext([
      makeTwitterTweet("8801"),
      { id: "8899", text: "缺少作者但仍可观察水位" },
      makeTwitterTweet("8802"),
    ]), "offline-test-key");
    return Effect.gen(function* () {
      const batch = yield* source.fetchAfter(testUserId(), Option.none());
      expect(batch.activities.map((activity) => activity.id)).toEqual(["8801", "8802"]);
      expect(Option.getOrNull(batch.newestId)).toBe("8899");
    });
  });

  it.effect("只观察到旧动态时不会返回可回退的最新水位", () => {
    const source = makeTwitterApiDataSource(
      makeHttpContext([makeTwitterTweet("8800")]),
      "offline-test-key",
    );
    return Effect.gen(function* () {
      const batch = yield* source.fetchAfter(
        testUserId(),
        Option.some(testCursor("8900")),
      );
      expect(batch.activities).toEqual([]);
      expect(Option.isNone(batch.newestId)).toBe(true);
    });
  });
});
