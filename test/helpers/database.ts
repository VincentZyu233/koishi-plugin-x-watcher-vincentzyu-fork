import SQLiteDriver from "@koishijs/plugin-database-sqlite";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import { Context } from "@koishijs/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { XActivity } from "../../src/domain/activity";
import {
  parseActivityId,
  parseBotId,
  parseChannelId,
  parseKoishiUserId,
  parsePlatform,
  parseXHandle,
  parseXUserId,
  type ActivityId,
  type XUserId,
} from "../../src/domain/identifiers";
import { initializeDatabase, makeXWatcherStoreService } from "../../src/infrastructure/database";
import type { RawRealtimeEvent, ResolvedXUser } from "../../src/ports/source";
import type {
  SaveSubscriptionInput,
  XWatcherStoreService,
} from "../../src/ports/storage";

/** SQLite 内存集成测试使用的固定当前时间。 */
export const TestNow = new Date("2026-07-15T00:00:00.000Z");

/** SQLite 内存数据库测试夹具。 */
export interface DatabaseHarness {
  readonly ctx: Context;
  readonly store: XWatcherStoreService;
  readonly close: () => Promise<void>;
}

/** 两个独立 Koishi 实例共享同一 SQLite 文件的测试夹具。 */
export interface SharedDatabaseHarness {
  readonly primary: DatabaseHarness;
  readonly secondary: DatabaseHarness;
  readonly close: () => Promise<void>;
}

/** 从领域解析结果中提取测试所需的合法品牌值。 */
export const expectRight = <A, E>(value: Either.Either<A, E>): A => {
  if (Either.isLeft(value)) throw new Error(String(value.left));
  return value.right;
};

/** 启动隔离的 Koishi Context 与 SQLite 内存数据库。 */
const openDatabaseHarness = async (path: string): Promise<DatabaseHarness> => {
  const ctx = new Context();
  ctx.plugin(SQLiteDriver, { path });
  await ctx.start();
  initializeDatabase(ctx);
  await ctx.database.prepared();
  return {
    ctx,
    store: makeXWatcherStoreService(ctx),
    /** 停止 Context 并关闭 SQLite 内存数据库。 */
    close: () => ctx.stop(),
  };
};

/** 启动隔离的 Koishi Context 与 SQLite 内存数据库。 */
export const makeDatabaseHarness = (): Promise<DatabaseHarness> =>
  openDatabaseHarness(":memory:");

/** 启动两个共享持久化文件的独立 Koishi Context。 */
export const makeSharedDatabaseHarness = async (): Promise<SharedDatabaseHarness> => {
  const directory = await mkdtemp(join(tmpdir(), "x-watcher-queue-"));
  const path = join(directory, "shared.db");
  const primary = await openDatabaseHarness(path);
  const secondary = await openDatabaseHarness(path);
  return {
    primary,
    secondary,
    /** 关闭两个实例并删除临时数据库。 */
    close: async () => {
      await secondary.close();
      await primary.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

/** 创建稳定的测试 X 用户资料。 */
export const makeResolvedUser = (
  userId = "1000",
  handle = "example",
): ResolvedXUser => ({
  id: expectRight(parseXUserId(userId)),
  handle: expectRight(parseXHandle(handle)),
  displayName: `User ${handle}`,
});

/** 创建带有常用默认值的订阅写入参数。 */
export const makeSubscriptionInput = (
  overrides: Partial<SaveSubscriptionInput> = {},
): SaveSubscriptionInput => ({
  platform: expectRight(parsePlatform("test")),
  channelId: expectRight(parseChannelId("channel-a")),
  guildId: null,
  isDirect: true,
  creatorId: expectRight(parseKoishiUserId("creator")),
  botId: expectRight(parseBotId("bot")),
  user: makeResolvedUser(),
  baselineId: expectRight(parseActivityId("100")),
  baselineKnown: true,
  kinds: null,
  filter: { _tag: "Preserve" },
  includeMedia: null,
  remoteMonitoring: false,
  remoteKeyFingerprint: null,
  now: TestNow,
  ...overrides,
});

/** 创建可路由的规范化动态。 */
export const makeActivity = (
  id: string,
  overrides: Partial<XActivity> = {},
): XActivity => ({
  id: expectRight(parseActivityId(id)),
  authorId: expectRight(parseXUserId("1000")),
  authorHandle: expectRight(parseXHandle("example")),
  authorName: "Example User",
  kind: "post",
  createdAtEpochMillis: TestNow.getTime() + Number(id),
  body: {
    text: `tweet-${id}`,
    expandedUrls: [`https://example.test/${id}`],
    media: [],
  },
  replyToId: Option.none(),
  reference: Option.none(),
  permalink: `https://x.com/example/status/${id}`,
  ...overrides,
});

/** 创建同一 Tweet ID 可跨事件形态复用的原始实时事件。 */
export const makeRawEvent = (
  activityId: ActivityId,
  accountId: XUserId,
  reduced: boolean,
): RawRealtimeEvent => ({
  provider: "twitterapiio",
  eventKey: `activity:${activityId}`,
  accountId: Option.some(accountId),
  activityId: Option.some(activityId),
  reduced,
  payloadJson: JSON.stringify({ id: activityId, reduced }),
  receivedAtEpochMillis: TestNow.getTime(),
});

/** 执行无环境依赖的持久化 Effect。 */
export const runStore = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);
