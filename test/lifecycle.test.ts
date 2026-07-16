import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SQLite from "@koishijs/plugin-database-sqlite";
import { Context } from "@koishijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apply } from "../src";
import { Config } from "../src/config";

interface LifecycleEnvironment {
  readonly ctx: Context;
  readonly directory: string;
}

const environments: LifecycleEnvironment[] = [];

async function createEnvironment(): Promise<LifecycleEnvironment> {
  const directory = mkdtempSync(join(tmpdir(), "x-watcher-lifecycle-"));
  const ctx = new Context();
  // @ts-expect-error 上游 Driver 泛型与 exactOptionalPropertyTypes 不兼容
  ctx.plugin(SQLite, { path: join(directory, "lifecycle.db") });
  await ctx.start();
  const environment = { ctx, directory };
  environments.push(environment);
  return environment;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  let attempts = 0;
  while (!predicate() && attempts < 100) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    attempts += 1;
  }
  if (!predicate()) throw new Error("等待 ready 生命周期超时");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) {
    await environment.ctx.stop();
    rmSync(environment.directory, { recursive: true, force: true });
  }
});

describe("插件生命周期", () => {
  it("只填写 Rettiwt API Key 池也能完成启动并注册命令", async () => {
    const { ctx } = await createEnvironment();
    // @ts-expect-error 验证 Koishi Schema 会补齐默认的 provider、mode 和 interval
    const config = Config({ apiKeys: ["offline-constructor-test-key"] });

    apply(ctx, config);
    await waitFor(() => ctx.$commander._commandList.some(
      (command) => command.name === "x-watcher.watch",
    ));

    const commandNames = ctx.$commander._commandList.map(
      (command) => command.name,
    );
    expect(commandNames).toContain("x-watcher.watch");
    expect(commandNames).toContain("x-watcher.unwatch");
    expect(commandNames).toContain("x-watcher.list");
  });

  it("数据库迁移失败时不注册命令或启动 worker", async () => {
    const { ctx } = await createEnvironment();
    const get = vi.spyOn(ctx.database, "get");
    get.mockRejectedValueOnce(new Error("migration failed"));
    const setInterval = vi.spyOn(ctx, "setInterval");

    apply(ctx, {
      provider: "twitterapiio",
      mode: "polling",
      apiKey: "offline-test-key",
      interval: 5,
    });
    await waitFor(() => get.mock.calls.length > 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const commandNames = ctx.$commander._commandList.map(
      (command) => command.name,
    );
    expect(commandNames).not.toContain("x-watcher.watch");
    expect(commandNames).not.toContain("x-watcher.unwatch");
    expect(commandNames).not.toContain("x-watcher.list");
    expect(setInterval).not.toHaveBeenCalled();
  });
});
