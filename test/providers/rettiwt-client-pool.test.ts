import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import { vi } from "vitest";
import { parseXHandle, parseXUserId } from "../../src/domain/identifiers";
import { RettiwtPollingLayer } from "../../src/infrastructure/providers/rettiwt/layer";
import { XDataSource } from "../../src/ports/source";

/** 保存 Rettiwt 客户端构造顺序与测试方法。 */
const mocks = vi.hoisted(() => ({
  timeline: vi.fn(),
  replies: vi.fn(),
  details: vi.fn(),
  constructorKeys: new Array<string>(),
}));

/** 用可同步抛出认证异常的离线 Rettiwt 客户端替代 SDK。 */
vi.mock("rettiwt-api", () => ({
  Rettiwt: class {
    readonly user = {
      timeline: mocks.timeline,
      replies: mocks.replies,
      details: mocks.details,
    };

    constructor(config: { readonly apiKey: string }) {
      mocks.constructorKeys.push(config.apiKey);
      if (config.apiKey === "bad-constructor") {
        throw new Error("Invalid authentication data");
      }
    }
  },
}));

/** 解析客户端池测试使用的稳定用户 ID。 */
const testUserId = () => {
  const result = parseXUserId("9001");
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

/** 解析客户端池测试使用的用户名。 */
const testHandle = () => {
  const result = parseXHandle("effect_ts");
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

/** 创建客户端池测试使用的 Rettiwt Layer。 */
const testLayer = (apiKeys: Array<string>) =>
  RettiwtPollingLayer({
    provider: "rettiwt",
    mode: "polling",
    apiKeys,
    intervalMinutes: 5,
  });

describe("Rettiwt 客户端池", () => {
  beforeEach(() => {
    mocks.timeline.mockReset();
    mocks.replies.mockReset();
    mocks.details.mockReset();
    mocks.constructorKeys.length = 0;
  });

  it.effect("隔离构造器认证异常后继续使用下一把健康 key", () => {
    mocks.timeline.mockResolvedValue({ list: [{ id: "9199" }], next: "" });
    mocks.replies.mockResolvedValue({ list: [], next: "" });
    return Effect.gen(function* () {
      const source = yield* XDataSource;
      const latest = yield* source.fetchLatestId(testUserId());
      expect(Option.getOrNull(latest)).toBe("9199");
      expect(mocks.constructorKeys).toEqual(["bad-constructor", "good-constructor"]);
    }).pipe(Effect.provide(testLayer(["bad-constructor", "good-constructor"])));
  });

  it.effect("隔离请求阶段认证失败的 key 且后续不再重试它", () => {
    mocks.details
      .mockRejectedValueOnce(new Error("Failed to authenticate"))
      .mockResolvedValue({
        id: "9001",
        userName: "effect_ts",
        fullName: "Effect 中文社区",
      });
    return Effect.gen(function* () {
      const source = yield* XDataSource;
      yield* source.resolveUser(testHandle());
      yield* source.resolveUser(testHandle());
      expect(mocks.details).toHaveBeenCalledTimes(3);
    }).pipe(Effect.provide(testLayer(["expired-key", "healthy-key"])));
  });

  it.effect("全部构造失败时以类型化认证错误结束 Layer", () =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        Effect.gen(function* () {
          yield* XDataSource;
        }).pipe(Effect.provide(testLayer(["bad-constructor"]))),
      );
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left._tag).toBe("AuthenticationError");
    }),
  );
});
