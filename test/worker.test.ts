import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "@koishijs/plugin-database-sqlite";
import { Bot, Context, h, Logger } from "@koishijs/core";
import { afterEach, describe, expect, it } from "vitest";
import { extendWatcherTable, type WatcherRecord } from "../src/database";
import { success, type XActivity } from "../src/domain";
import type { XDataSourceService } from "../src/services";
import { legacyMessageOutput } from "../src/output";
import {
  createDeliveryTracker,
  createPollingRunner,
  recoverActiveWatchers,
} from "../src/worker";

interface SentMessage {
  readonly channelId: string;
  readonly content: string;
}

// @ts-expect-error 上游 Bot 泛型在 exactOptionalPropertyTypes 下约束过窄
class RecordingBot extends Bot<Context, object> {
  readonly messages: SentMessage[] = [];
  readonly failingChannels = new Set<string>();
  sendGate: Promise<void> | null = null;

  constructor(ctx: Context) {
    super(ctx, {}, "test");
    this.platform = "test";
    this.selfId = "bot";
  }

  async sendMessage(
    channelId: string,
    content: h.Fragment,
  ): Promise<string[]> {
    if (this.failingChannels.has(channelId)) throw new Error("send failed");
    this.messages.push({ channelId, content: String(content) });
    if (this.sendGate !== null) await this.sendGate;
    return [`message-${this.messages.length}`];
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }
}

interface TestEnvironment {
  readonly ctx: Context;
  readonly bot: RecordingBot;
  readonly directory: string;
}

const environments: TestEnvironment[] = [];

async function createEnvironment(): Promise<TestEnvironment> {
  const directory = mkdtempSync(join(tmpdir(), "x-watcher-worker-"));
  const ctx = new Context();
  // @ts-expect-error 上游 Driver 泛型与 exactOptionalPropertyTypes 不兼容
  ctx.plugin(SQLite, { path: join(directory, "worker.db") });
  await ctx.start();
  extendWatcherTable(ctx);
  const bot = new RecordingBot(ctx);
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

function activity(
  id: string,
  kind: XActivity["kind"],
  text: string,
): XActivity {
  return {
    id,
    authorId: "42",
    username: "Example",
    fullname: "Example User",
    kind,
    text,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
    url: `https://x.com/Example/status/${id}`,
    media: [],
  };
}

function snowflakeFor(date: Date): string {
  const timestamp = BigInt(date.getTime()) - 1_288_834_974_657n;
  return (timestamp << 22n).toString();
}

function createSource(
  activities: ReadonlyArray<XActivity>,
  onFetch: () => Promise<void> = () => Promise.resolve(),
): XDataSourceService {
  return {
    provider: "twitterapiio",
    resolveUser: async () => success({
      id: "42",
      username: "Example",
      fullname: "Example User",
    }),
    fetchBaseline: async () => success("100"),
    fetchAfter: async () => {
      await onFetch();
      return success({ activities, newestId: null });
    },
  };
}

afterEach(async () => {
  for (const environment of environments.splice(0)) {
    await environment.ctx.stop();
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

describe("动态 worker", () => {
  it("同一 X 用户只抓取一次并按频道规则独立路由和推进", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {
      channelId: "filtered",
      filter_regexp: "match",
    });
    await createWatcher(ctx, {
      channelId: "all",
      include_quote: true,
    });
    const activities = [
      activity("101", "post", "skip"),
      activity("102", "quote", "quoted"),
      activity("103", "post", "match this"),
      activity("104", "retweet", "reposted"),
    ];
    let fetches = 0;
    const source = createSource(activities, () => {
      fetches += 1;
      return Promise.resolve();
    });

    const completed = await recoverActiveWatchers(
      ctx,
      source,
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    expect(completed).toBe(true);
    expect(fetches).toBe(1);
    expect(bot.messages.map((message) => message.channelId)).toEqual([
      "filtered",
      "all",
      "all",
      "all",
    ]);
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows.map((row) => row.last_tweet_id)).toEqual(["104", "104"]);
  });

  it("发送失败时停止当前订阅且不越过失败水位", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, { channelId: "broken", last_tweet_id: "200" });
    bot.failingChannels.add("broken");

    const completed = await recoverActiveWatchers(
      ctx,
      createSource([
        activity("201", "post", "first"),
        activity("202", "post", "second"),
      ]),
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    expect(completed).toBe(false);
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("200");
  });

  it("补漏只发送每类最新额度且仍推进到最新水位", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, { include_quote: true, include_retweet: true });
    const completed = await recoverActiveWatchers(
      ctx,
      createSource([
        activity("101", "post", "old post"),
        activity("102", "reply", "old reply"),
        activity("103", "post", "newer post"),
        activity("104", "reply", "new reply"),
        activity("105", "post", "newest post"),
      ]),
      new Logger("worker-test"),
      createDeliveryTracker(),
      () => true,
      {
        output: legacyMessageOutput,
        activityTypes: ["post", "reply"],
        maxPostCount: 2,
        maxReplyCount: 1,
      },
    );

    expect(completed).toBe(true);
    expect(bot.messages.map((message) => message.content)).toHaveLength(3);
    expect(bot.messages.map((message) => message.content).join("\n")).not.toContain("old post");
    expect(bot.messages.map((message) => message.content).join("\n")).not.toContain("old reply");
    expect(bot.messages.map((message) => message.content).join("\n")).toContain("newest post");
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("105");
  });

  it("混合空水位时使用所有订阅中最早的真实边界", async () => {
    const { ctx } = await createEnvironment();
    const olderBoundary = new Date("2026-01-01T00:00:00.000Z");
    await createWatcher(ctx, {
      channelId: "empty",
      last_tweet_id: null,
      enabled_at: new Date("2026-01-10T00:00:00.000Z"),
    });
    await createWatcher(ctx, {
      channelId: "snowflake",
      last_tweet_id: snowflakeFor(olderBoundary),
      enabled_at: new Date("2026-02-01T00:00:00.000Z"),
    });
    let observedEnabledAt: Date | null = null;
    const source: XDataSourceService = {
      provider: "twitterapiio",
      resolveUser: async () => success({
        id: "42",
        username: "Example",
        fullname: "Example User",
      }),
      fetchBaseline: async () => success(null),
      fetchAfter: async (user, cursor) => {
        observedEnabledAt = cursor.enabledAt;
        return success({ activities: [], newestId: null });
      },
    };

    await recoverActiveWatchers(
      ctx,
      source,
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    expect(observedEnabledAt).toEqual(olderBoundary);
  });

  it("空 Snowflake 水位可按启用时间消费首条动态", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {
      last_tweet_id: null,
      enabled_at: new Date("2026-01-01T00:00:00.000Z"),
    });

    const completed = await recoverActiveWatchers(
      ctx,
      createSource([activity("101", "post", "first activity")]),
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    expect(completed).toBe(true);
    expect(bot.messages).toHaveLength(1);
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("101");
  });

  it("发送期间重新启用不会被旧 worker 回退到较低水位", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {});
    let release = (): void => undefined;
    bot.sendGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const recovery = recoverActiveWatchers(
      ctx,
      createSource([activity("101", "post", "old generation")]),
      new Logger("worker-test"),
      createDeliveryTracker(),
    );
    while (bot.messages.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }

    const reactivatedAt = new Date("2026-01-03T00:00:00.000Z");
    await ctx.database.set(
      "x_watcher",
      {},
      {
        last_tweet_id: "200",
        enabled_at: reactivatedAt,
        update_at: reactivatedAt,
      },
    );
    release();
    expect(await recovery).toBe(true);

    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("200");
  });

  it("非重入 runner 会跳过仍在执行中的下一轮", async () => {
    const { ctx } = await createEnvironment();
    await createWatcher(ctx, {});
    let release = (): void => undefined;
    let fetches = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const source = createSource([], async () => {
      fetches += 1;
      await gate;
    });
    const runner = createPollingRunner(
      ctx,
      source,
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    const first = runner();
    while (fetches === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    await runner();
    expect(fetches).toBe(1);
    release();
    await first;
  });

  it("运行时释放后停止旧轮次且不再请求后续账号", async () => {
    const { ctx } = await createEnvironment();
    await createWatcher(ctx, {});
    await createWatcher(ctx, {
      channelId: "second",
      twitter_id: "84",
      twitter_username: "Second",
      twitter_fullname: "Second User",
    });
    let active = true;
    const fetchedUsers: string[] = [];
    const source: XDataSourceService = {
      provider: "twitterapiio",
      resolveUser: async () => success({
        id: "42",
        username: "Example",
        fullname: "Example User",
      }),
      fetchBaseline: async () => success("100"),
      fetchAfter: async (user) => {
        fetchedUsers.push(user.id);
        active = false;
        return success({ activities: [], newestId: null });
      },
    };
    const runner = createPollingRunner(
      ctx,
      source,
      new Logger("worker-test"),
      createDeliveryTracker(),
      () => active,
    );

    await runner();

    expect(fetchedUsers).toHaveLength(1);
  });

  it("请求前刷新订阅，清库后的旧快照不会继续访问其他账号", async () => {
    const { ctx } = await createEnvironment();
    await createWatcher(ctx, {});
    await createWatcher(ctx, {
      channelId: "second",
      twitter_id: "84",
      twitter_username: "Second",
      twitter_fullname: "Second User",
    });
    const fetchedUsers: string[] = [];
    const source: XDataSourceService = {
      provider: "twitterapiio",
      resolveUser: async () => success({
        id: "42",
        username: "Example",
        fullname: "Example User",
      }),
      fetchBaseline: async () => success("100"),
      fetchAfter: async (user) => {
        fetchedUsers.push(user.id);
        await ctx.database.remove("x_watcher", {});
        return success({ activities: [], newestId: null });
      },
    };

    await recoverActiveWatchers(
      ctx,
      source,
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    expect(fetchedUsers).toHaveLength(1);
  });
});
