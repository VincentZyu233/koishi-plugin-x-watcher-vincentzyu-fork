import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { Tweet } from "rettiwt-api";
import { vi } from "vitest";
import { parseActivityId, parseXUserId } from "../../src/domain/identifiers";
import { RettiwtPollingLayer } from "../../src/infrastructure/providers/rettiwt/layer";
import { XDataSource } from "../../src/ports/source";

/** 保存被虚拟 Rettiwt 客户端调用的方法。 */
const mocks = vi.hoisted(() => ({
  timeline: vi.fn(),
  replies: vi.fn(),
}));

/** 用离线 Rettiwt 客户端替代真实逆向 API。 */
vi.mock("rettiwt-api", () => ({
  Rettiwt: class {
    readonly user = {
      timeline: mocks.timeline,
      replies: mocks.replies,
    };
  },
}));

/** 创建 Rettiwt mapper 所需的最小推文。 */
const makeTweet = (id: string): Tweet => {
  const tweet: Tweet = Object.create(null);
  Object.assign(tweet, {
    id,
    conversationId: id,
    createdAt: "2026-07-15T00:00:00.000Z",
    entities: { hashtags: [], mentionedUsers: [], urls: [] },
    fullText: `Rettiwt 动态 ${id}`,
    lang: "zh",
    tweetBy: {
      id: "9001",
      userName: "effect_ts",
      fullName: "Effect 中文社区",
    },
    url: `https://x.com/effect_ts/status/${id}`,
  });
  return tweet;
};

/** 创建带合法水位但缺少领域核心字段的 Rettiwt 脏推文。 */
const makeMalformedTweet = (id: string): Tweet => {
  const tweet: Tweet = Object.create(null);
  Object.assign(tweet, { id, createdAt: "invalid" });
  return tweet;
};

/** 解析恢复测试使用的稳定 X 用户 ID。 */
const testUserId = () => {
  const result = parseXUserId("9001");
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

/** 解析恢复测试使用的动态水位。 */
const testCursor = (value: string) => {
  const result = parseActivityId(value);
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

describe("Rettiwt 恢复 unique 上限", () => {
  beforeEach(() => {
    mocks.timeline.mockReset();
    mocks.replies.mockReset();
  });

  it.effect("跳过单条脏推文、保留有效项并推进到其可观察 ID", () => {
    mocks.timeline.mockResolvedValue({
      list: [makeTweet("9301"), makeMalformedTweet("9399"), makeTweet("9302")],
      next: "",
    });
    mocks.replies.mockResolvedValue({ list: [], next: "" });

    return Effect.gen(function* () {
      const source = yield* XDataSource;
      const batch = yield* source.fetchAfter(testUserId(), Option.none());
      expect(batch.activities.map((activity) => activity.id)).toEqual(["9301", "9302"]);
      expect(Option.getOrNull(batch.newestId)).toBe("9399");
    }).pipe(
      Effect.provide(
        RettiwtPollingLayer({
          provider: "rettiwt",
          mode: "polling",
          apiKeys: ["offline-test-key"],
          intervalMinutes: 5,
        }),
      ),
    );
  });

  it.effect("只观察到旧动态时不会把保存水位向后回退", () => {
    mocks.timeline.mockResolvedValue({ list: [makeTweet("9300")], next: "" });
    mocks.replies.mockResolvedValue({ list: [], next: "" });
    return Effect.gen(function* () {
      const source = yield* XDataSource;
      const batch = yield* source.fetchAfter(
        testUserId(),
        Option.some(testCursor("9400")),
      );
      expect(batch.activities).toEqual([]);
      expect(Option.isNone(batch.newestId)).toBe(true);
    }).pipe(
      Effect.provide(
        RettiwtPollingLayer({
          provider: "rettiwt",
          mode: "polling",
          apiKeys: ["offline-test-key"],
          intervalMinutes: 5,
        }),
      ),
    );
  });

  it.effect("首页 raw 重复时继续分页直到第 21 个 unique Tweet", () => {
    const firstPageUnique = Array.from({ length: 20 }, (_, index) =>
      makeTweet(String(9_200 + index)),
    );
    mocks.timeline.mockImplementation(
      async (_userId: string, _count: number, cursor: string | undefined) =>
        cursor === undefined
          ? { list: [...firstPageUnique, makeTweet("9200")], next: "page-2" }
          : { list: [makeTweet("9220")], next: "" },
    );
    mocks.replies.mockResolvedValue({ list: [], next: "" });

    return Effect.gen(function* () {
      const source = yield* XDataSource;
      const batch = yield* source.fetchAfter(testUserId(), Option.none());
      expect(mocks.timeline).toHaveBeenCalledTimes(2);
      expect(batch.activities).toHaveLength(20);
      expect(batch.overflow).toBe(true);
      expect(batch.activities[0]?.id).toBe("9201");
      expect(batch.activities.at(-1)?.id).toBe("9220");
      expect(batch.overflowBoundary?.id).toBe("9200");
      expect(Option.getOrNull(batch.newestId)).toBe("9220");
    }).pipe(
      Effect.provide(
        RettiwtPollingLayer({
          provider: "rettiwt",
          mode: "polling",
          apiKeys: ["offline-test-key"],
          intervalMinutes: 5,
        }),
      ),
    );
  });
});
