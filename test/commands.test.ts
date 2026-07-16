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
import { success } from "../src/domain";
import type { XDataSourceService } from "../src/services";

interface CommandOptions {
  readonly media?: boolean;
  readonly quote?: boolean;
  readonly retweet?: boolean;
}

interface CommandEnvironment {
  readonly ctx: Context;
  readonly directory: string;
  readonly source: XDataSourceService;
  readonly calls: {
    resolved: number;
    baselines: number;
  };
}

const environments: CommandEnvironment[] = [];

async function createEnvironment(
  mode: "polling" | "websocket" = "polling",
  synchronizeMonitors: (() => Promise<boolean>) | null = null,
): Promise<CommandEnvironment> {
  const directory = mkdtempSync(join(tmpdir(), "x-watcher-command-"));
  const ctx = new Context();
  // @ts-expect-error 上游 Driver 泛型与 exactOptionalPropertyTypes 不兼容
  ctx.plugin(SQLite, { path: join(directory, "commands.db") });
  await ctx.start();
  extendWatcherTable(ctx);

  const calls = { resolved: 0, baselines: 0 };
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
  };
  const dependencies: CommandDependencies = mode === "polling"
    ? {
      source,
      interval: 5,
      mode: "polling",
      synchronizeMonitors: null,
    }
    : {
      source,
      interval: 5,
      mode: "websocket",
      synchronizeMonitors: synchronizeMonitors === null
        ? async () => true
        : synchronizeMonitors,
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
  const replies: string[] = [];
  const session = {
    platform: "test",
    channelId,
    userId: "operator",
    bot: { selfId: "bot" },
    send: async (message: string) => {
      replies.push(message);
      return [];
    },
  };
  const command = ctx.$commander.get(name);
  // @ts-expect-error 这里只注入命令实际读取的最小 Session 字段
  await command.execute({ session, args: [...args], options: { ...options } });
  return replies;
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
    expect(calls).toEqual({ resolved: 0, baselines: 0 });

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
});
