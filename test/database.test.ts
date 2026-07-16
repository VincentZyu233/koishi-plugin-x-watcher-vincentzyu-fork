import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "@koishijs/plugin-database-sqlite";
import { Context } from "@koishijs/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  extendWatcherTable,
  migrateWatcherTable,
} from "../src/database";

const temporaryDirectories: string[] = [];

function createTemporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "x-watcher-"));
  temporaryDirectories.push(directory);
  return join(directory, "migration.db");
}

function extendLegacyWatcherTable(ctx: Context): void {
  ctx.database.extend(
    "x_watcher",
    {
      id: "integer",
      platform: "string",
      channelId: "string",
      userId: "string",
      botId: "string",
      twitter_fullname: "string",
      twitter_username: "string",
      twitter_id: "string",
      last_tweet_id: "string",
      filter_regexp: "string",
      media: "boolean",
      active: "boolean",
      create_at: "timestamp",
      update_at: "timestamp",
    },
    { primary: "id", autoInc: true },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("x_watcher 数据迁移", () => {
  it("幂等回填新字段并保留旧订阅、规则和 Snowflake 水位", async () => {
    const path = createTemporaryDatabasePath();
    const updatedAt = new Date("2026-01-02T03:04:05.000Z");
    const createdAt = new Date("2025-12-01T00:00:00.000Z");

    const legacy = new Context();
    // 上游 Driver 的泛型在 exactOptionalPropertyTypes 下与 Koishi Context 不兼容。
    // @ts-expect-error 运行时插件契约由同版本 Koishi 官方 SQLite 实现保证
    legacy.plugin(SQLite, { path });
    await legacy.start();
    extendLegacyWatcherTable(legacy);
    await legacy.database.create("x_watcher", {
      platform: "test",
      channelId: "channel-a",
      userId: "operator",
      botId: "bot",
      twitter_fullname: "Example User",
      twitter_username: "Example",
      twitter_id: "42",
      last_tweet_id: "1999999999999999999",
      filter_regexp: "release",
      media: true,
      active: true,
      create_at: createdAt,
      update_at: updatedAt,
    });
    await legacy.stop();

    const current = new Context();
    // @ts-expect-error 同上，避免用类型断言掩盖测试数据类型
    current.plugin(SQLite, { path });
    await current.start();
    extendWatcherTable(current);

    const firstMigration = await migrateWatcherTable(current);
    const secondMigration = await migrateWatcherTable(current);
    expect(firstMigration).toEqual({ ok: true, value: undefined });
    expect(secondMigration).toEqual({ ok: true, value: undefined });

    const rows = await current.database.get("x_watcher", {});
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row !== undefined) {
      expect(row.twitter_id).toBe("42");
      expect(row.twitter_username).toBe("Example");
      expect(row.last_tweet_id).toBe("1999999999999999999");
      expect(row.filter_regexp).toBe("release");
      expect(row.media).toBe(true);
      expect(row.active).toBe(true);
      expect(row.include_quote).toBe(false);
      expect(row.include_retweet).toBe(false);
      expect(row.enabled_at).toEqual(updatedAt);
    }
    await current.stop();
  });
});
