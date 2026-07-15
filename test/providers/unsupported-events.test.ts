import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import {
  decodeRealtimeObject,
  decodeRealtimeText,
} from "../../src/infrastructure/providers/twitterapi/realtime";
import { makeTwitterTweet } from "./fixtures/twitterapi";

describe("TwitterAPI.io 不受支持实时事件", () => {
  it.effect("忽略 like/follow 等 fast_tweet 类型", () =>
    Effect.gen(function* () {
      const events = yield* decodeRealtimeObject({
        event_type: "fast_tweet",
        timestamp: 1_700_000_000_000,
        tweet: {
          id: "1900000000000000001",
          screen_name: "effect_ts",
          text: "liked",
          type: "like",
          created_ms: 1_700_000_000_000,
        },
      });
      expect(events).toEqual([]);
    }),
  );

  it.effect("忽略编辑、删除及未来未知 event_type", () =>
    Effect.gen(function* () {
      const deleted = yield* decodeRealtimeText(
        JSON.stringify({ event_type: "tweet_delete", timestamp: 1 }),
      );
      const future = yield* decodeRealtimeObject({
        event_type: "future_social_event",
        timestamp: 2,
      });
      expect(deleted).toEqual([]);
      expect(future).toEqual([]);
    }),
  );

  it.effect("已知事件结构损坏时仍返回类型化解码失败", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        decodeRealtimeObject({ event_type: "fast_tweet", timestamp: 1 }),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left._tag).toBe("DecodeError");
    }),
  );

  it.effect("标准批次逐项跳过脏推文并保留同批有效事件", () =>
    Effect.gen(function* () {
      const events = yield* decodeRealtimeObject({
        event_type: "tweet",
        timestamp: 1_700_000_000_000,
        tweets: [
          { id: "1900000000000000001", text: "missing author" },
          makeTwitterTweet("1900000000000000002"),
        ],
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventKey).toBe("activity:1900000000000000002");
    }),
  );
});
