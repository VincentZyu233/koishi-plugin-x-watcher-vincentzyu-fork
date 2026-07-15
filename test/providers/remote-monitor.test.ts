import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { Context } from "koishi";
import { parseXHandle } from "../../src/domain/identifiers";
import { makeTwitterApiRemoteMonitor } from "../../src/infrastructure/providers/twitterapi/client";

/** 从用户名解析结果中提取合法测试 handle。 */
const testHandle = () => {
  const result = parseXHandle("effect_ts");
  if (Either.isLeft(result)) throw result.left;
  return result.right;
};

/** 构造 TwitterAPI.io 远端控制测试使用的标准 HTTP 响应。 */
const response = (data: object) => ({
  url: "https://api.twitterapi.io",
  status: 200,
  statusText: "OK",
  headers: new Headers(),
  data,
});

/** 将 HTTP mock 安装为最小 Koishi Context。 */
const makeContext = (http: ReturnType<typeof vi.fn>): Context => {
  const context: Context = Object.create(null);
  Object.defineProperty(context, "http", { value: http });
  return context;
};

describe("TwitterAPI.io 远端监控归属", () => {
  it.effect("只持有本次 add 后新出现的远端 ID", () => {
    const http = vi.fn()
      .mockResolvedValueOnce(response({ status: "success", msg: "ok", data: [] }))
      .mockResolvedValueOnce(response({ status: "success", msg: "accepted" }))
      .mockResolvedValueOnce(response({
        status: "success",
        msg: "ok",
        data: [{ id_for_user: "owned-1", x_user_screen_name: "effect_ts" }],
      }));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      const entry = yield* remote.add(testHandle());
      expect(entry.remoteId).toBe("owned-1");
      expect(http).toHaveBeenCalledTimes(3);
    });
  });

  it.effect("同名条目在 add 前已存在时拒绝接管且不发送 POST", () => {
    const http = vi.fn().mockResolvedValueOnce(response({
      status: "success",
      msg: "ok",
      data: [{ id_for_user: "unknown-1", x_user_screen_name: "effect_ts" }],
    }));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      const result = yield* Effect.either(remote.add(testHandle()));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left.message).toContain("无法确认归属");
      expect(http).toHaveBeenCalledTimes(1);
      expect(http.mock.calls[0]?.[0]).toBe("GET");
    });
  });

  it.effect("add 响应丢失时记录候选 ID 但拒绝自动接管", () => {
    const http = vi.fn()
      .mockResolvedValueOnce(response({ status: "success", msg: "ok", data: [] }))
      .mockRejectedValueOnce(new Error("connection reset after submit"))
      .mockResolvedValueOnce(response({
        status: "success",
        msg: "ok",
        data: [{ id_for_user: "owned-2", x_user_screen_name: "effect_ts" }],
      }));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      const result = yield* Effect.either(remote.add(testHandle()));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.disposition).toBe("manual");
        expect(result.left.candidateRemoteIds).toEqual(["owned-2"]);
      }
      expect(http).toHaveBeenCalledTimes(3);
    });
  });

  it.effect("崩溃后重试看到同名条目时进入人工协调而不再 POST", () => {
    const http = vi.fn().mockResolvedValueOnce(response({
      status: "success",
      msg: "ok",
      data: [{ id_for_user: "uncertain-1", x_user_screen_name: "effect_ts" }],
    }));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      const result = yield* Effect.either(remote.add(testHandle()));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.disposition).toBe("manual");
        expect(result.left.candidateRemoteIds).toEqual(["uncertain-1"]);
      }
      expect(http).toHaveBeenCalledTimes(1);
    });
  });

  it.effect("remove 响应丢失但列表已不存在时按幂等成功处理", () => {
    const http = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset after submit"))
      .mockResolvedValueOnce(response({ status: "success", msg: "ok", data: [] }));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      yield* remote.remove("owned-1");
      expect(http).toHaveBeenCalledTimes(2);
      expect(http.mock.calls[1]?.[0]).toBe("GET");
    });
  });

  it.effect("拒绝把缺少必需字段的含糊列表响应当作空列表", () => {
    const http = vi.fn().mockResolvedValueOnce(response({}));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      const listResult = yield* Effect.either(remote.list());
      expect(Either.isLeft(listResult)).toBe(true);
    });
  });

  it.effect("删除明确成功但列表仍存在时保留本地所有权并返回失败", () => {
    const http = vi.fn()
      .mockResolvedValueOnce(response({ status: "success", msg: "accepted" }))
      .mockResolvedValueOnce(response({
        status: "success",
        msg: "ok",
        data: [{ id_for_user: "owned-1", x_user_screen_name: "effect_ts" }],
      }));
    const remote = makeTwitterApiRemoteMonitor(makeContext(http), "offline-key");
    return Effect.gen(function* () {
      const result = yield* Effect.either(remote.remove("owned-1"));
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left.message).toContain("仍存在");
    });
  });
});
