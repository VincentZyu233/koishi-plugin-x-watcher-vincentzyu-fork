import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "@koishijs/plugin-database-sqlite";
import { Context, Logger } from "@koishijs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerCommands,
  type CommandDependencies,
} from "../src/commands";
import { extendWatcherTable } from "../src/database";
import { failure, sourceError, success } from "../src/domain";
import type { XDataSourceService } from "../src/services";

interface CommandOptions {
  readonly media?: boolean;
  readonly quote?: boolean;
  readonly retweet?: boolean;
  readonly type?: string;
  readonly count?: number;
}

interface CommandEnvironment {
  readonly ctx: Context;
  readonly directory: string;
  readonly source: XDataSourceService;
  readonly calls: {
    resolved: number;
    baselines: number;
    recent: number;
  };
}

const environments: CommandEnvironment[] = [];

async function createEnvironment(
  mode: "polling" | "websocket" = "polling",
  synchronizeMonitors: (() => Promise<boolean>) | null = null,
  latestDefaultUsername = "amsrntk3",
  enableQuote = false,
  recentDefaultUsername = "OpenAI",
  recentDefaultCount = 10,
  enableWaitingHint = false,
): Promise<CommandEnvironment> {
  const directory = mkdtempSync(join(tmpdir(), "x-watcher-command-"));
  const ctx = new Context();
  // @ts-expect-error 上游 Driver 泛型与 exactOptionalPropertyTypes 不兼容
  ctx.plugin(SQLite, { path: join(directory, "commands.db") });
  await ctx.start();
  extendWatcherTable(ctx);

  const calls = { resolved: 0, baselines: 0, recent: 0 };
  const source: XDataSourceService = {
    provider: "twitterapiio",
    resolveUser: async (handle) => {
      calls.resolved += 1;
      return success({
        id: "42",
        username: handle,
        fullname: "Example User",
      });
    },
    fetchBaseline: async () => {
      calls.baselines += 1;
      return success("500");
    },
    fetchAfter: async () => success({ activities: [], newestId: null }),
    fetchLatest: async (user, kind) => success({
      id: "600",
      authorId: user.id,
      username: user.username,
      fullname: user.fullname,
      kind,
      text: kind === "reply" ? "latest reply" : "latest post",
      createdAt: new Date("2026-09-15T07:07:26.000Z"),
      url: `https://x.com/${user.username}/status/600`,
      media: [],
    }),
    fetchRecent: async (user, count) => {
      calls.recent += 1;
      return success(Array.from({ length: count * 2 }, (_value, index) => ({
        id: String(900 - index),
        authorId: user.id,
        username: user.username,
        fullname: user.fullname,
        kind: index % 2 === 0 ? "post" : "reply",
        text: `recent-${index}`,
        createdAt: new Date("2026-09-15T07:07:26.000Z"),
        url: `https://x.com/${user.username}/status/${900 - index}`,
        media: [],
      })));
    },
  };
  const dependencies: CommandDependencies = mode === "polling"
    ? {
      source,
      interval: 5,
      mode: "polling",
      synchronizeMonitors: null,
      latestDefaultUsername,
      enableQuote,
      recentDefaultUsername,
      recentDefaultCount,
      enableWaitingHint,
    }
    : {
      source,
      interval: 5,
      mode: "websocket",
      synchronizeMonitors: synchronizeMonitors === null
        ? async () => true
        : synchronizeMonitors,
      latestDefaultUsername,
      enableQuote,
      recentDefaultUsername,
      recentDefaultCount,
      enableWaitingHint,
    };
  registerCommands(
    ctx,
    dependencies,
    new Logger("command-test"),
  );
  const environment = { ctx, directory, source, calls };
  environments.push(environment);
  return environment;
}

async function executeCommand(
  ctx: Context,
  name: string,
  channelId: string,
  args: ReadonlyArray<string | undefined>,
  options: CommandOptions = {},
): Promise<string[]> {
  return (await executeCommandWithTrace(ctx, name, channelId, args, options)).replies;
}

interface CommandTrace {
  readonly replies: string[];
  readonly deleted: string[];
  readonly events: string[];
}

async function executeCommandWithTrace(
  ctx: Context,
  name: string,
  channelId: string,
  args: ReadonlyArray<string | undefined>,
  options: CommandOptions = {},
): Promise<CommandTrace> {
  const replies: string[] = [];
  const deleted: string[] = [];
  const events: string[] = [];
  const session = {
    platform: "test",
    channelId,
    userId: "operator",
    messageId: "trigger-message",
    bot: {
      selfId: "bot",
      deleteMessage: async (_channelId: string, messageId: string) => {
        deleted.push(messageId);
        events.push(`delete:${messageId}`);
      },
    },
    send: async (message: string) => {
      replies.push(message);
      const messageId = `sent-${replies.length}`;
      events.push(`send:${messageId}`);
      return [messageId];
    },
  };
  const command = ctx.$commander.get(name);
  // @ts-expect-error 这里只注入命令实际读取的最小 Session 字段
  await command.execute({ session, args: [...args], options: { ...options } });
  return { replies, deleted, events };
}

afterEach(async () => {
  for (const environment of environments.splice(0)) {
    await environment.ctx.stop();
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

describe("公开命令契约", () => {
  it("再次 watch 完整覆盖正则和三个布尔开关且不依赖远端", async () => {
    const { ctx, calls } = await createEnvironment();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await ctx.database.create("x_watcher", {
      platform: "test",
      channelId: "channel-a",
      userId: "old-operator",
      botId: "bot",
      twitter_fullname: "Example User",
      twitter_username: "Example",
      twitter_id: "42",
      last_tweet_id: "400",
      filter_regexp: "old",
      media: true,
      include_quote: true,
      include_retweet: true,
      active: true,
      enabled_at: now,
      create_at: now,
      update_at: now,
    });

    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["@Example", undefined],
    );
    let rows = await ctx.database.get("x_watcher", {});
    expect(rows[0]).toMatchObject({
      filter_regexp: null,
      media: false,
      include_quote: false,
      include_retweet: false,
      last_tweet_id: "400",
    });
    expect(calls).toEqual({ resolved: 0, baselines: 0, recent: 0 });

    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", "release"],
      { media: true, quote: true, retweet: true },
    );
    rows = await ctx.database.get("x_watcher", {});
    expect(rows[0]).toMatchObject({
      filter_regexp: "release",
      media: true,
      include_quote: true,
      include_retweet: true,
    });
  });

  it("非法正则在命令阶段拒绝且不会覆盖已有规则", async () => {
    const { ctx } = await createEnvironment();
    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", "release"],
    );
    const replies = await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", "["],
    );

    expect(replies[0]).toContain("正则表达式格式错误");
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].filter_regexp).toBe("release");
  });

  it("重新启用建立新基线并保持频道隔离", async () => {
    const { ctx, calls } = await createEnvironment();
    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", undefined],
    );
    await executeCommand(
      ctx,
      "x-watcher.unwatch",
      "channel-a",
      ["Example"],
    );
    await ctx.database.set(
      "x_watcher",
      { channelId: "channel-a" },
      { last_tweet_id: "450" },
    );

    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", undefined],
      { quote: true },
    );
    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-b",
      ["Example", undefined],
    );

    const rows = await ctx.database.get("x_watcher", {});
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.channelId).sort()).toEqual([
      "channel-a",
      "channel-b",
    ]);
    expect(rows.every((row) => row.last_tweet_id === "500")).toBe(true);
    expect(calls.baselines).toBe(3);
  });

  it("xlist 展示引用和转推开关", async () => {
    const { ctx } = await createEnvironment();
    await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", "release|model\nnext"],
      { quote: true, retweet: false },
    );
    const replies = await executeCommand(
      ctx,
      "x-watcher.list",
      "channel-a",
      [],
    );
    expect(replies[0]).toContain("| 引用 | 转推 |");
    expect(replies[0]).toContain("| 开启 | 关闭 |");
    expect(replies[0]).toContain("release\\|model next");
  });

  it("WebSocket 远端同步失败时明确提示本地订阅已保存", async () => {
    const { ctx } = await createEnvironment(
      "websocket",
      async () => false,
    );
    const replies = await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      ["Example", undefined],
    );

    expect(replies[0]).toContain("已订阅 Example User");
    expect(replies[0]).toContain("已保存，远端 Stream 同步待重试");
  });

  it("xlatest 默认查推文并通过 type 选项查询回复", async () => {
    const { ctx } = await createEnvironment();
    const defaultReplies = await executeCommand(
      ctx,
      "x-watcher.latest",
      "channel-a",
      ["thsottiaux"],
    );
    expect(defaultReplies[0]).toContain("发布了新推文");
    expect(defaultReplies[0]).toContain("latest post");

    const replyReplies = await executeCommand(
      ctx,
      "x-watcher.latest",
      "channel-a",
      ["thsottiaux"],
      { type: "reply" },
    );
    expect(replyReplies[0]).toContain("发布了新回复");
    expect(replyReplies[0]).toContain("latest reply");
    expect(await ctx.database.get("x_watcher", {})).toHaveLength(0);
  });

  it("xlatest 省略用户名时默认查询 amsrntk3", async () => {
    const { ctx } = await createEnvironment();
    const replies = await executeCommand(
      ctx,
      "x-watcher.latest",
      "channel-a",
      [],
    );
    expect(replies[0]).toContain("@amsrntk3");
    expect(replies[0]).toContain("latest post");
  });

  it("xlatest 省略用户名时使用配置的默认账号", async () => {
    const { ctx } = await createEnvironment("polling", null, "thsottiaux");
    const replies = await executeCommand(
      ctx,
      "x-watcher.latest",
      "channel-a",
      [],
    );
    expect(replies[0]).toContain("@thsottiaux");
  });

  it("xlatest 拒绝未知动态类型", async () => {
    const { ctx, calls } = await createEnvironment();
    const replies = await executeCommand(
      ctx,
      "x-watcher.latest",
      "channel-a",
      ["thsottiaux"],
      { type: "quote" },
    );
    expect(replies[0]).toBe("动态类型只支持 post 或 reply");
    expect(calls.resolved).toBe(0);
  });

  it("公开别名全部使用 x 前缀", async () => {
    const { ctx } = await createEnvironment();
    expect(ctx.$commander.get("xwatch")).toBeDefined();
    expect(ctx.$commander.get("xwa")).toBeDefined();
    expect(ctx.$commander.get("xun")).toBeDefined();
    expect(ctx.$commander.get("xunwatch")).toBeDefined();
    expect(ctx.$commander.get("xlist")).toBeDefined();
    expect(ctx.$commander.get("xls")).toBeDefined();
    expect(ctx.$commander.get("xlatest")).toBeDefined();
    expect(ctx.$commander.get("xla")).toBeDefined();
    expect(ctx.$commander.get("xrecent")).toBeDefined();
    expect(ctx.$commander.get("xre")).toBeDefined();
    expect(ctx.$commander.get("watch")).toBeUndefined();
    expect(ctx.$commander.get("unwatch")).toBeUndefined();
    await ctx.database.get("x_watcher", {});
  });

  it("xrecent 默认查询 OpenAI 且推文和回复各取 10 条", async () => {
    const { ctx, calls } = await createEnvironment();
    const replies = await executeCommand(ctx, "x-watcher.recent", "channel-a", []);
    expect(replies[0]).toContain("@OpenAI");
    expect(replies[0]).toContain("10 条推文，10 条回复");
    expect(calls.recent).toBe(1);
  });

  it("xrecent 允许配置默认值和 -c 覆盖", async () => {
    const { ctx } = await createEnvironment(
      "polling",
      null,
      "amsrntk3",
      false,
      "example",
      3,
    );
    const configured = await executeCommand(ctx, "x-watcher.recent", "channel-a", []);
    expect(configured[0]).toContain("@example");
    expect(configured[0]).toContain("3 条推文，3 条回复");
    const overridden = await executeCommand(
      ctx,
      "x-watcher.recent",
      "channel-a",
      ["other"],
      { count: 2 },
    );
    expect(overridden[0]).toContain("@other");
    expect(overridden[0]).toContain("2 条推文，2 条回复");
  });

  it("xrecent 拒绝非法数量且不访问数据源", async () => {
    const { ctx, calls } = await createEnvironment();
    for (const count of [0, -1, 1.5, 51]) {
      const replies = await executeCommand(
        ctx,
        "x-watcher.recent",
        "channel-a",
        ["OpenAI"],
        { count },
      );
      expect(replies[0]).toContain("1～50 的整数");
    }
    expect(calls.resolved).toBe(0);
    expect(calls.recent).toBe(0);
  });

  it("xlatest 和 xrecent 在最终回复后撤回带引用的等待提示", async () => {
    const { ctx } = await createEnvironment(
      "polling",
      null,
      "amsrntk3",
      true,
      "OpenAI",
      10,
      true,
    );
    const latest = await executeCommandWithTrace(
      ctx,
      "x-watcher.latest",
      "channel-a",
      ["OpenAI"],
    );
    expect(latest.replies[0]).toContain("正在获取最新动态");
    expect(latest.replies[0]).toContain('<quote id="trigger-message"/>');
    expect(latest.replies[1]).toContain("latest post");
    expect(latest.events).toEqual(["send:sent-1", "send:sent-2", "delete:sent-1"]);

    const recent = await executeCommandWithTrace(
      ctx,
      "x-watcher.recent",
      "channel-a",
      ["OpenAI"],
      { count: 1 },
    );
    expect(recent.replies[0]).toContain("正在获取最近动态");
    expect(recent.replies[1]).toContain("1 条推文，1 条回复");
    expect(recent.deleted).toEqual(["sent-1"]);
  });

  it("xrecent 查询失败仍回复并撤回等待提示，参数错误则不显示提示", async () => {
    const { ctx, source } = await createEnvironment(
      "polling",
      null,
      "amsrntk3",
      false,
      "OpenAI",
      10,
      true,
    );
    Object.defineProperty(source, "fetchRecent", {
      value: async () => failure(sourceError("twitterapiio", "transport", "offline")),
    });
    const failed = await executeCommandWithTrace(
      ctx,
      "x-watcher.recent",
      "channel-a",
      ["OpenAI"],
      { count: 1 },
    );
    expect(failed.replies[1]).toContain("获取最近动态失败：offline");
    expect(failed.events).toEqual(["send:sent-1", "send:sent-2", "delete:sent-1"]);

    const invalid = await executeCommandWithTrace(
      ctx,
      "x-watcher.recent",
      "channel-a",
      ["OpenAI"],
      { count: 0 },
    );
    expect(invalid.replies).toHaveLength(1);
    expect(invalid.replies[0]).toContain("1～50 的整数");
    expect(invalid.deleted).toEqual([]);
  });

  it("enableQuote 为所有指令回复添加引用段", async () => {
    const { ctx } = await createEnvironment(
      "polling",
      null,
      "amsrntk3",
      true,
    );
    const watchReplies = await executeCommand(
      ctx,
      "x-watcher.watch",
      "channel-a",
      [],
    );
    const listReplies = await executeCommand(
      ctx,
      "x-watcher.list",
      "channel-a",
      [],
    );
    const latestReplies = await executeCommand(
      ctx,
      "x-watcher.latest",
      "channel-a",
      [],
    );
    const recentReplies = await executeCommand(
      ctx,
      "x-watcher.recent",
      "channel-a",
      [],
      { count: 1 },
    );
    for (const message of [
      ...watchReplies,
      ...listReplies,
      ...latestReplies,
      ...recentReplies,
    ]) {
      expect(message.startsWith('<quote id="trigger-message"/>')).toBe(true);
    }
  });
});
