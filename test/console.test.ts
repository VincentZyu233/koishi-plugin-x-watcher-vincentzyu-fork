import { Context } from "@koishijs/core";
import SQLite from "@koishijs/plugin-database-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extendWatcherTable, updateWatcherCursor } from "../src/database";
import { createConsoleService, registerConsole, type ConsolePhase } from "../src/console";
import { success } from "../src/domain";
import { createWatcher, withManagementLock } from "../src/subscriptions";
import { OfflineConsole } from "./console-fixture";
import AuthService from "@koishijs/plugin-auth";
import type { Client } from "@koishijs/console";

const contexts: Context[] = [];
async function setup() {
  const ctx = new Context();
  contexts.push(ctx);
  // @ts-expect-error console 与工作区 Cordis 的 Inject 类型版本不同
  ctx.plugin(OfflineConsole);
  // @ts-expect-error 上游 Driver 泛型与 exactOptionalPropertyTypes 不兼容
  ctx.plugin(SQLite, { path: ":memory:" });
  await ctx.start();
  extendWatcherTable(ctx);
  Object.defineProperty(ctx, "bots", { value: [{ platform: "onebot", selfId: "bot", status: 1, user: { name: "离线测试" } }] });
  let phase: ConsolePhase = "ready";
  const source = {
    provider: "rettiwt" as const,
    resolveUser: vi.fn(async (username: string) => success({ id: "42", username, fullname: "Example" })),
    fetchBaseline: vi.fn(async () => success("500")),
    fetchAfter: vi.fn(async () => success({ activities: [], newestId: null })),
  };
  const sync = vi.fn(async () => true);
  const service = createConsoleService(ctx, source, "polling", sync, () => phase);
  const input = { username: "OpenAI", platform: "onebot", botId: "bot", channelId: "group",
    rules: { filter: null, media: false, quote: false, retweet: false } };
  async function current() { return (await service.state()).rows[0]!; }
  async function mutation(action: "update" | "deactivate" | "reactivate" | "delete") {
    const row = await current();
    return { id: row.id, revision: row.revision, action, botId: row.botId, rules: input.rules };
  }
  return { ctx, source, sync, service, input, current, mutation, setPhase: (value: ConsolePhase) => { phase = value; } };
}
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.stop(); });

describe("控制台订阅管理", () => {
  it("同一稳定 X ID 跨频道共享非空头像，不串到同名的其他用户且不写库或查询 API", async () => {
    const e = await setup();
    await e.service.create(e.input);
    await e.service.create({ ...e.input, channelId: "other" });
    await e.service.create({ ...e.input, channelId: "third" });
    await e.service.create({ ...e.input, channelId: "different-user" });
    await e.ctx.database.set("x_watcher", { channelId: "group" }, { twitter_avatar_url: "https://example.com/old.png" });
    await e.ctx.database.set("x_watcher", { channelId: "other" }, { twitter_avatar_url: "https://example.com/current.png" });
    await e.ctx.database.set("x_watcher", { channelId: "third" }, { twitter_avatar_url: "  " });
    await e.ctx.database.set("x_watcher", { channelId: "different-user" }, { twitter_id: "99" });
    e.source.resolveUser.mockClear();
    const before = await e.ctx.database.get("x_watcher", {});
    const result = await e.service.state();
    expect(result.rows.filter(row => row.twitter_id === "42").map(row => row.twitter_avatar_url))
      .toEqual(Array(3).fill("https://example.com/current.png"));
    expect(result.rows.find(row => row.twitter_id === "99")?.twitter_avatar_url).toBeNull();
    expect(e.source.resolveUser).not.toHaveBeenCalled();
    expect(await e.ctx.database.get("x_watcher", {})).toEqual(before);
  });
  it("并发新增只有一条记录，建立水位并标记来源", async () => {
    const e = await setup();
    const result = await Promise.allSettled([e.service.create(e.input), e.service.create(e.input)]);
    expect(result.map(row => row.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect((await e.service.state()).rows).toHaveLength(1);
    expect(await e.current()).toMatchObject({ userId: "console:x-watcher", last_tweet_id: "500", active: true });
  });
  it("网页与命令共享创建锁，不产生重复记录", async () => {
    const e = await setup();
    const cli = withManagementLock(e.ctx, () => createWatcher(e.ctx,
      { ...e.input, userId: "chat-user" }, { id: "42", username: "OpenAI", fullname: "Example" },
      "500", null, e.input.rules));
    const result = await Promise.allSettled([cli, e.service.create(e.input)]);
    expect(result[1]?.status).toBe("rejected");
    expect((await e.service.state()).rows).toHaveLength(1);
  });
  it("worker 更新水位不令编辑失效，修改规则也不回滚水位", async () => {
    const e = await setup(); await e.service.create(e.input);
    const edit = await e.mutation("update");
    const [row] = await e.ctx.database.get("x_watcher", {});
    expect((await updateWatcherCursor(e.ctx, row!, "600")).ok).toBe(true);
    await e.service.mutate({ ...edit, rules: { ...edit.rules, media: true } });
    expect(await e.current()).toMatchObject({ media: true, last_tweet_id: "600" });
    await expect(e.service.mutate(edit)).rejects.toThrow("订阅已变更");
  });
  it("软取消后编辑保持停用；恢复重建基线；永久删除只删目标", async () => {
    const e = await setup(); await e.service.create(e.input);
    await e.service.create({ ...e.input, channelId: "other" });
    await e.service.mutate(await e.mutation("deactivate"));
    await e.service.mutate({ ...await e.mutation("update"), rules: { ...e.input.rules, quote: true } });
    expect(await e.current()).toMatchObject({ active: false, include_quote: true });
    e.source.fetchBaseline.mockResolvedValue(success("900"));
    await e.service.mutate(await e.mutation("reactivate"));
    expect(await e.current()).toMatchObject({ active: true, last_tweet_id: "900", include_quote: true });
    await e.service.mutate(await e.mutation("delete"));
    expect((await e.service.state()).rows.map(row => row.channelId)).toEqual(["other"]);
  });
  it("本地操作不访问 X；同步失败返回待重试且不回滚", async () => {
    const e = await setup(); await e.service.create(e.input);
    e.source.resolveUser.mockRejectedValue(new Error("offline"));
    e.source.fetchBaseline.mockRejectedValue(new Error("offline"));
    e.sync.mockRejectedValue(new Error("stream unavailable"));
    const result = await e.service.mutate(await e.mutation("deactivate"));
    expect(result.pendingSync).toBe(true);
    expect((await e.current()).active).toBe(false);
    await e.service.mutate(await e.mutation("delete"));
    expect((await e.service.state()).rows).toEqual([]);
  });
  it("服务未就绪及异步解析期间卸载均禁止创建", async () => {
    const e = await setup();
    for (const phase of ["initializing", "failed", "disposed"] as const) {
      e.setPhase(phase);
      await expect(e.service.create(e.input)).rejects.toThrow("暂时无法管理");
    }
    e.setPhase("ready");
    e.source.fetchBaseline.mockImplementation(async () => { e.setPhase("disposed"); return success("500"); });
    await expect(e.service.create(e.input)).rejects.toThrow("暂时无法管理");
    expect(await e.ctx.database.get("x_watcher", {})).toEqual([]);
  });
  it("拒绝无效参数、正则、错误机器人及旧删除快照", async () => {
    const e = await setup();
    await expect(e.service.create({ ...e.input, botId: "missing" })).rejects.toThrow("机器人");
    await expect(e.service.create({ ...e.input, rules: { ...e.input.rules, filter: "[" } })).rejects.toThrow("正则");
    await expect(e.service.create({ ...e.input, channelId: "" })).rejects.toThrow();
    await e.service.create(e.input);
    const stale = await e.mutation("delete");
    await e.service.mutate(await e.mutation("deactivate"));
    await expect(e.service.mutate(stale)).rejects.toThrow("订阅已变更");
  });
  it("所有 RPC 要求 authority 3，卸载清理页面和监听器", async () => {
    const e = await setup();
    const scope = e.ctx.plugin({ apply(ctx: Context) { registerConsole(ctx, e.service); } });
    const names = ["x-watcher/state", "x-watcher/create", "x-watcher/mutate"];
    for (const name of names) expect(e.ctx.console.listeners[name]?.authority).toBe(3);
    expect(Object.keys(e.ctx.console.entries)).toHaveLength(1);
    scope.dispose();
    for (const name of names) expect(e.ctx.console.listeners[name]).toBeUndefined();
    expect(Object.keys(e.ctx.console.entries)).toHaveLength(0);
  });
  it("真实 auth 拦截未登录、过期及低权限请求，允许权限 3", async () => {
    const e = await setup();
    e.ctx.plugin(AuthService, AuthService.Config({ admin: { enabled: false } }));
    await e.ctx.lifecycle.flush();
    e.ctx.plugin({ inject: ["console"], apply(ctx: Context) { registerConsole(ctx, e.service); } });
    for (const name of ["x-watcher/state", "x-watcher/create", "x-watcher/mutate"]) {
      const listener = e.ctx.console.listeners[name]!;
      expect(await e.ctx.serial("console/intercept", {} as Client, listener)).toBe(true);
      for (const auth of [
        { authority: 2, expiredAt: Date.now() + 100000 },
        { authority: 3, expiredAt: Date.now() - 1000 },
      ]) expect(await e.ctx.serial("console/intercept", { auth } as Client, listener)).toBe(true);
      expect(await e.ctx.serial("console/intercept", {
        auth: { authority: 3, expiredAt: Date.now() + 100000 },
      } as Client, listener)).not.toBe(true);
    }
  });
});
