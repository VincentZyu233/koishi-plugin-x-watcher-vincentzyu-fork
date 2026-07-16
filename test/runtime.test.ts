import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "@koishijs/plugin-database-sqlite";
import { Bot, Context, h, Logger } from "@koishijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extendWatcherTable, type WatcherRecord } from "../src/database";
import { sourceError, success, type XActivity } from "../src/domain";
import { createAccountStreamRuntime } from "../src/runtime";
import type {
  AccountStreamService,
  MonitorEntry,
  StreamHandlers,
  XDataSourceService,
} from "../src/services";

interface SentMessage {
  readonly channelId: string;
  readonly content: string;
}

// @ts-expect-error 上游 Bot 泛型在 exactOptionalPropertyTypes 下约束过窄
class StreamTestBot extends Bot<Context, object> {
  readonly messages: SentMessage[] = [];
  readonly failingChannels = new Set<string>();
  failuresRemaining = 0;

  constructor(ctx: Context) {
    super(ctx, {}, "test");
    this.platform = "test";
    this.selfId = "bot";
  }

  async sendMessage(
    channelId: string,
    content: h.Fragment,
  ): Promise<string[]> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("send failed once");
    }
    if (this.failingChannels.has(channelId)) throw new Error("send failed");
    this.messages.push({ channelId, content: String(content) });
    return [`stream-${this.messages.length}`];
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }
}

interface RuntimeEnvironment {
  readonly ctx: Context;
  readonly bot: StreamTestBot;
  readonly directory: string;
}

interface ClosedConnection {
  readonly code: number;
  readonly reason: string;
}

interface FakeStream {
  readonly service: AccountStreamService;
  readonly connections: StreamHandlers[];
  readonly closed: ClosedConnection[];
  readonly added: string[];
  readonly removed: string[];
  readonly monitors: () => ReadonlyArray<MonitorEntry>;
  readonly setStatus: (handle: string, status: MonitorEntry["status"]) => void;
}

const environments: RuntimeEnvironment[] = [];

async function createEnvironment(): Promise<RuntimeEnvironment> {
  const directory = mkdtempSync(join(tmpdir(), "x-watcher-runtime-"));
  const ctx = new Context();
  // @ts-expect-error 上游 Driver 泛型与 exactOptionalPropertyTypes 不兼容
  ctx.plugin(SQLite, { path: join(directory, "runtime.db") });
  await ctx.start();
  extendWatcherTable(ctx);
  const bot = new StreamTestBot(ctx);
  const environment = { ctx, bot, directory };
  environments.push(environment);
  return environment;
}

async function createWatcher(
  ctx: Context,
  values: Partial<WatcherRecord>,
): Promise<WatcherRecord> {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return ctx.database.create("x_watcher", {
    platform: "test",
    channelId: "channel",
    userId: "operator",
    botId: "bot",
    twitter_fullname: "Example User",
    twitter_username: "Example",
    twitter_id: "42",
    last_tweet_id: "100",
    filter_regexp: null,
    media: false,
    include_quote: false,
    include_retweet: false,
    active: true,
    enabled_at: now,
    create_at: now,
    update_at: now,
    ...values,
  });
}

function activity(id: string, text: string): XActivity {
  return {
    id,
    authorId: "42",
    username: "Example",
    fullname: "Example User",
    kind: "post",
    text,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    url: `https://x.com/Example/status/${id}`,
    media: [],
  };
}

function createSource(
  fetchAfter: XDataSourceService["fetchAfter"],
): XDataSourceService {
  return {
    provider: "twitterapiio",
    resolveUser: async () => success({
      id: "42",
      username: "Example",
      fullname: "Example User",
    }),
    fetchBaseline: async () => success("100"),
    fetchAfter,
  };
}

function createFakeStream(
  initial: ReadonlyArray<MonitorEntry>,
  closeSynchronously = true,
  initialListFailures = 0,
): FakeStream {
  let monitors = initial.map((monitor) => ({ ...monitor }));
  const connections: StreamHandlers[] = [];
  const closed: ClosedConnection[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  let nextMonitorId = 1;
  let listFailuresRemaining = initialListFailures;

  const service: AccountStreamService = {
    listMonitors: async () => {
      if (listFailuresRemaining > 0) {
        listFailuresRemaining -= 1;
        return {
          ok: false,
          error: sourceError(
            "twitterapiio",
            "transport",
            "temporary list failure",
          ),
        };
      }
      return success(monitors.map((monitor) => ({ ...monitor })));
    },
    addMonitor: async (handle) => {
      added.push(handle);
      monitors.push({
        idForUser: `added-${nextMonitorId}`,
        handle,
        status: "waiting",
      });
      nextMonitorId += 1;
      return success(undefined);
    },
    removeMonitor: async (idForUser) => {
      removed.push(idForUser);
      monitors = monitors.filter((monitor) => monitor.idForUser !== idForUser);
      return success(undefined);
    },
    connect: (handlers) => {
      connections.push(handlers);
      return success({
        close: (code, reason) => {
          closed.push({ code, reason });
          if (closeSynchronously) handlers.onClosed(code, reason);
        },
      });
    },
  };

  return {
    service,
    connections,
    closed,
    added,
    removed,
    monitors: () => monitors.map((monitor) => ({ ...monitor })),
    setStatus: (handle, status) => {
      monitors = monitors.map((monitor) =>
        monitor.handle.toLowerCase() === handle.toLowerCase()
          ? { ...monitor, status }
          : monitor
      );
    },
  };
}

function firstConnection(stream: FakeStream): StreamHandlers {
  const handlers = stream.connections[0];
  if (handlers === undefined) throw new Error("测试期望已有 Stream 连接");
  return handlers;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  let attempts = 0;
  while (!predicate() && attempts < 100) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    attempts += 1;
  }
  if (!predicate()) throw new Error("等待异步状态超时");
}

afterEach(async () => {
  vi.useRealTimers();
  for (const environment of environments.splice(0)) {
    await environment.ctx.stop();
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

describe("Account Stream runtime", () => {
  it("精确对账远端列表且仅在最后一个本地订阅取消后删除", async () => {
    const { ctx } = await createEnvironment();
    await createWatcher(ctx, { channelId: "channel-a" });
    await createWatcher(ctx, { channelId: "channel-b" });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "active" },
      { idForUser: "duplicate", handle: "example", status: "active" },
      { idForUser: "extra", handle: "Other", status: "active" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      createSource(async () => success({ activities: [], newestId: null })),
      stream.service,
      new Logger("runtime-test"),
      5,
    );

    await runtime.start();
    expect(stream.monitors()).toEqual([
      { idForUser: "keep", handle: "Example", status: "active" },
    ]);
    expect(stream.removed).toEqual(["duplicate", "extra"]);
    expect(stream.added).toEqual([]);

    await ctx.database.set(
      "x_watcher",
      { channelId: "channel-a" },
      { active: false },
    );
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(true);
    }
    expect(stream.monitors()).toHaveLength(1);

    await ctx.database.set(
      "x_watcher",
      { channelId: "channel-b" },
      { active: false },
    );
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(true);
    }
    expect(stream.monitors()).toEqual([]);
    expect(stream.removed).toEqual(["duplicate", "extra", "keep"]);
    runtime.dispose();
  });

  it("connected 后先补漏，再按顺序排空并去重缓存事件", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    let release = (): void => undefined;
    let fetches = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = createSource(async () => {
      fetches += 1;
      await gate;
      return success({ activities: [activity("101", "gap")], newestId: "101" });
    });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "active" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      source,
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    await runtime.start();

    const handlers = firstConnection(stream);
    const recovery = handlers.onConnected();
    await waitFor(() => fetches === 1);
    const newer = handlers.onActivities([
      activity("103", "newer live"),
    ]);
    const older = handlers.onActivities([
      activity("102", "older live"),
      activity("102", "duplicate"),
    ]);
    release();
    await Promise.all([recovery, newer, older]);

    expect(bot.messages).toHaveLength(3);
    expect(bot.messages[0] === undefined ? "" : bot.messages[0].content)
      .toContain("status/101");
    expect(bot.messages[1] === undefined ? "" : bot.messages[1].content)
      .toContain("status/102");
    expect(bot.messages[2] === undefined ? "" : bot.messages[2].content)
      .toContain("status/103");
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("103");
    runtime.dispose();
  });

  it("monitor 首次进入 active 时只做一次账号补漏，failed 不删除重建", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    let fetches = 0;
    const source = createSource(async () => {
      fetches += 1;
      return success({ activities: [activity("101", "activation")], newestId: "101" });
    });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "waiting" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      source,
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    await runtime.start();
    expect(fetches).toBe(0);

    stream.setStatus("Example", "active");
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(true);
    }
    expect(fetches).toBe(0);
    await firstConnection(stream).onConnected();
    await waitFor(() => fetches === 1 && bot.messages.length === 1);
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(true);
    }
    expect(fetches).toBe(1);

    stream.setStatus("Example", "failed");
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(false);
    }
    expect(stream.added).toEqual([]);
    expect(stream.removed).toEqual([]);

    stream.setStatus("Example", "active");
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(true);
    }
    expect(fetches).toBe(1);
    runtime.dispose();
  });

  it("active 状态尚未同步时先补配置窗口缺口再投递首条流事件", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    let fetches = 0;
    const source = createSource(async () => {
      fetches += 1;
      if (fetches === 1) {
        return success({ activities: [], newestId: null });
      }
      return success({
        activities: [activity("150", "activation gap")],
        newestId: "150",
      });
    });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "waiting" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      source,
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    await runtime.start();
    const handlers = firstConnection(stream);
    await handlers.onConnected();

    // 远端实际已激活但 list 仍返回 waiting，首条事件不能先把水位从 100 推到 200。
    await handlers.onActivities([activity("200", "first live")]);

    expect(fetches).toBe(2);
    expect(bot.messages).toHaveLength(2);
    expect(bot.messages[0] === undefined ? "" : bot.messages[0].content)
      .toContain("status/150");
    expect(bot.messages[1] === undefined ? "" : bot.messages[1].content)
      .toContain("status/200");
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("200");

    stream.setStatus("Example", "active");
    if (runtime.synchronizeMonitors !== null) {
      expect(await runtime.synchronizeMonitors()).toBe(true);
    }
    expect(fetches).toBe(2);
    runtime.dispose();
  });

  it("首次 monitor 列表失败后仍保守补齐激活窗口", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    let fetches = 0;
    const source = createSource(async () => {
      fetches += 1;
      if (fetches === 1) {
        return success({ activities: [], newestId: null });
      }
      return success({
        activities: [activity("150", "gap after list failure")],
        newestId: "150",
      });
    });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "waiting" },
    ], true, 1);
    const runtime = createAccountStreamRuntime(
      ctx,
      source,
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    await runtime.start();
    const handlers = firstConnection(stream);
    await handlers.onConnected();

    stream.setStatus("Example", "active");
    await handlers.onActivities([activity("200", "first live")]);

    expect(fetches).toBe(2);
    expect(bot.messages).toHaveLength(2);
    expect(bot.messages[0] === undefined ? "" : bot.messages[0].content)
      .toContain("status/150");
    expect(bot.messages[1] === undefined ? "" : bot.messages[1].content)
      .toContain("status/200");
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("200");
    runtime.dispose();
  });

  it("投递失败关闭连接并至少等待 90 秒重连，dispose 正常关闭", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, { channelId: "broken" });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "active" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      createSource(async () => success({ activities: [], newestId: null })),
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    vi.useFakeTimers();
    await runtime.start();
    const handlers = firstConnection(stream);
    await handlers.onConnected();
    bot.failingChannels.add("broken");
    await handlers.onActivities([activity("101", "will fail")]);

    expect(stream.closed[0]).toEqual({
      code: 1011,
      reason: "live delivery failed",
    });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(stream.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.connections).toHaveLength(2);

    handlers.onError(sourceError(
      "twitterapiio",
      "transport",
      "stale connection error",
    ));
    expect(stream.closed).toHaveLength(1);

    runtime.dispose();
    expect(stream.closed[1]).toEqual({
      code: 1000,
      reason: "plugin disposed",
    });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(stream.connections).toHaveLength(2);
  });

  it("服务端以 1000 关闭连接时仍会在 90 秒后重连", async () => {
    const { ctx } = await createEnvironment();
    await createWatcher(ctx, {});
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "active" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      createSource(async () => success({ activities: [], newestId: null })),
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    vi.useFakeTimers();
    await runtime.start();

    firstConnection(stream).onClosed(1000, "server rotation");
    await vi.advanceTimersByTimeAsync(89_999);
    expect(stream.connections).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.connections).toHaveLength(2);
    runtime.dispose();
  });

  it("dispose 后正在进行的补漏不会继续投递", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    let release = (): void => undefined;
    let fetches = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "active" },
    ]);
    const runtime = createAccountStreamRuntime(
      ctx,
      createSource(async () => {
        fetches += 1;
        await gate;
        return success({ activities: [activity("101", "late")], newestId: "101" });
      }),
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    await runtime.start();
    const recovery = firstConnection(stream).onConnected();
    await waitFor(() => fetches === 1);
    runtime.dispose();
    release();
    await recovery;

    expect(bot.messages).toEqual([]);
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("100");
  });

  it("异步关闭尚未回调时也不会让排队事件越过失败水位", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    const stream = createFakeStream([
      { idForUser: "keep", handle: "Example", status: "active" },
    ], false);
    const runtime = createAccountStreamRuntime(
      ctx,
      createSource(async () => success({ activities: [], newestId: null })),
      stream.service,
      new Logger("runtime-test"),
      5,
    );
    await runtime.start();
    const handlers = firstConnection(stream);
    await handlers.onConnected();

    bot.failuresRemaining = 1;
    const failed = handlers.onActivities([activity("101", "will fail")]);
    const queued = handlers.onActivities([activity("102", "must wait")]);
    await Promise.all([failed, queued]);

    expect(stream.closed).toEqual([{
      code: 1011,
      reason: "live delivery failed",
    }]);
    expect(bot.messages).toEqual([]);
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("100");
    runtime.dispose();
  });
});
