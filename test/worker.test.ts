import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "@koishijs/plugin-database-sqlite";
import { Bot, Context, h, Logger } from "@koishijs/core";
import { afterEach, describe, expect, it } from "vitest";
import { extendWatcherTable, type WatcherRecord } from "../src/database";
import { failure, sourceError, success, type XActivity } from "../src/domain";
import type { XDataSourceService } from "../src/services";
import { legacyMessageOutput } from "../src/output";
import type { DeliveryOptions } from "../src/worker";
import {
  createDeliveryTracker,
  createPollingRunner,
  recoverActiveWatchers,
  resetNetworkCooldown,
  routeLiveActivities,
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

  it("补漏混合四类动态时只发送统一额度内的最新动态并推进水位", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, { include_quote: true, include_retweet: true });
    const activities = Array.from({ length: 100 }, (_, index) => activity(
      String(index + 101),
      index % 4 === 0
        ? "post"
        : index % 4 === 1
          ? "reply"
          : index % 4 === 2
            ? "quote"
            : "retweet",
      `activity-${index + 101}`,
    ));
    const completed = await recoverActiveWatchers(
      ctx,
      createSource(activities),
      new Logger("worker-test"),
      createDeliveryTracker(),
      () => true,
      {
        output: legacyMessageOutput,
        activityTypes: ["post", "reply"],
        maxActivityCount: 5,
      },
    );

    expect(completed).toBe(true);
    expect(bot.messages).toHaveLength(5);
    expect(bot.messages.map((message) => message.content)).toEqual([
      expect.stringContaining("activity-196"),
      expect.stringContaining("activity-197"),
      expect.stringContaining("activity-198"),
      expect.stringContaining("activity-199"),
      expect.stringContaining("activity-200"),
    ]);
    expect(bot.messages.map((message) => message.content).join("\n"))
      .not.toContain("activity-195");
    for (const id of ["196", "197", "198", "199", "200"]) {
      expect(bot.messages.map((message) => message.content).join("\n"))
        .toContain(`activity-${id}`);
    }
    const rows = await ctx.database.get("x_watcher", {});
    expect(rows[0] === undefined ? null : rows[0].last_tweet_id).toBe("200");

    await recoverActiveWatchers(
      ctx,
      createSource(activities),
      new Logger("worker-test"),
      createDeliveryTracker(),
      () => true,
      {
        output: legacyMessageOutput,
        activityTypes: ["post", "reply"],
        maxActivityCount: 5,
      },
    );
    expect(bot.messages).toHaveLength(5);
  });

  it("每条订阅独立获得统一额度，过滤和关闭类型不占额度", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {
      channelId: "filtered",
      filter_regexp: "match",
    });
    await createWatcher(ctx, {
      channelId: "all",
      include_quote: true,
      include_retweet: true,
    });
    const activities = [
      activity("101", "post", "match old"),
      activity("102", "quote", "match disabled quote"),
      activity("103", "reply", "ignore"),
      activity("104", "post", "match middle"),
      activity("105", "reply", "match newer"),
      activity("106", "retweet", "match disabled retweet"),
      activity("107", "post", "match newest"),
      activity("108", "quote", "match newest quote"),
    ];
    let fetches = 0;
    const completed = await recoverActiveWatchers(
      ctx,
      createSource(activities, () => {
        fetches += 1;
        return Promise.resolve();
      }),
      new Logger("worker-test"),
      createDeliveryTracker(),
      () => true,
      {
        output: legacyMessageOutput,
        activityTypes: ["post", "reply"],
        maxActivityCount: 3,
      },
    );

    expect(completed).toBe(true);
    expect(fetches).toBe(1);
    expect(bot.messages.filter((message) => message.channelId === "filtered")).toHaveLength(3);
    expect(bot.messages.filter((message) => message.channelId === "all")).toHaveLength(3);
    const filtered = bot.messages.filter((message) => message.channelId === "filtered")
      .map((message) => message.content).join("\n");
    expect(filtered).toContain("match middle");
    expect(filtered).toContain("match newer");
    expect(filtered).toContain("match newest");
    expect(filtered).not.toContain("match old");
    expect(filtered).not.toContain("disabled quote");
    expect(filtered).not.toContain("disabled retweet");
  });

  it("额度内发送失败时保留失败项供下一轮重试", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, {
      channelId: "broken",
      last_tweet_id: "200",
      include_quote: true,
    });
    const activities = [
      activity("201", "post", "skipped old"),
      activity("202", "reply", "retry first"),
      activity("203", "quote", "retry second"),
    ];
    bot.failingChannels.add("broken");
    const delivery: DeliveryOptions = {
      output: legacyMessageOutput,
      activityTypes: ["post", "reply"],
      maxActivityCount: 2,
    };

    expect(await recoverActiveWatchers(
      ctx, createSource(activities), new Logger("worker-test"),
      createDeliveryTracker(), () => true, delivery,
    )).toBe(false);
    expect((await ctx.database.get("x_watcher", {}))[0]?.last_tweet_id).toBe("201");

    bot.failingChannels.delete("broken");
    expect(await recoverActiveWatchers(
      ctx, createSource(activities), new Logger("worker-test"),
      createDeliveryTracker(), () => true, delivery,
    )).toBe(true);
    expect(bot.messages.map((message) => message.content).join("\n"))
      .toContain("retry first");
    expect((await ctx.database.get("x_watcher", {}))[0]?.last_tweet_id).toBe("203");
  });

  it("零和负数的统一额度不限制轮询恢复", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, { include_quote: true, include_retweet: true });
    const activities = Array.from({ length: 8 }, (_, index) => activity(
      String(index + 101),
      index % 2 === 0 ? "post" : "quote",
      `activity-${index}`,
    ));
    const run = (maxActivityCount: number) => recoverActiveWatchers(
      ctx, createSource(activities), new Logger("worker-test"),
      createDeliveryTracker(), () => true,
      { output: legacyMessageOutput, activityTypes: ["post", "reply"], maxActivityCount },
    );

    expect(await run(0)).toBe(true);
    expect(bot.messages).toHaveLength(8);
    await ctx.database.set("x_watcher", {}, { last_tweet_id: "100" });
    expect(await run(-1)).toBe(true);
    expect(bot.messages).toHaveLength(16);
  });

  it("实时 Stream 事件不受轮询恢复额度限制", async () => {
    const { ctx, bot } = await createEnvironment();
    await createWatcher(ctx, { include_quote: true, include_retweet: true });
    expect(await routeLiveActivities(
      ctx,
      new Logger("worker-test"),
      createDeliveryTracker(),
      [
        activity("101", "post", "live post"),
        activity("102", "reply", "live reply"),
        activity("103", "quote", "live quote"),
      ],
      () => true,
      {
        output: legacyMessageOutput,
        activityTypes: ["post", "reply"],
        maxActivityCount: 1,
      },
    )).toBe(true);
    expect(bot.messages).toHaveLength(3);
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

  it("网络传输连续失败达到 3 次时中止本轮检查并进入冷却", async () => {
    resetNetworkCooldown();
    const { ctx } = await createEnvironment();
    await createWatcher(ctx, { twitter_id: "1", twitter_username: "User1" });
    await createWatcher(ctx, { twitter_id: "2", twitter_username: "User2" });
    await createWatcher(ctx, { twitter_id: "3", twitter_username: "User3" });
    await createWatcher(ctx, { twitter_id: "4", twitter_username: "User4" });
    const fetchedUsers: string[] = [];
    const source: XDataSourceService = {
      provider: "rettiwt",
      resolveUser: async () => failure(sourceError("rettiwt", "transport", "net error")),
      fetchBaseline: async () => failure(sourceError("rettiwt", "transport", "net error")),
      fetchAfter: async (user) => {
        fetchedUsers.push(user.id);
        return failure(sourceError("rettiwt", "transport", "net error"));
      },
    };

    const runner = createPollingRunner(
      ctx,
      source,
      new Logger("worker-test"),
      createDeliveryTracker(),
    );

    await runner();
    expect(fetchedUsers).toHaveLength(3);

    await runner();
    expect(fetchedUsers).toHaveLength(3);

    resetNetworkCooldown();
  });
});
