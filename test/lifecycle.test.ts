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
  it("插件 scope 卸载后重新加载不会残留命令选项", async () => {
    const { ctx } = await createEnvironment();
    const config = {
      provider: "twitterapiio" as const,
      mode: "polling" as const,
      apiKey: "offline-test-key",
      interval: 5,
      outputFormats: ["text" as const],
    };
    const firstPlugin = { apply };
    const firstScope = ctx.plugin(firstPlugin, config);
    await waitFor(() => ctx.$commander._commandList.some(
      (command) => command.name === "x-watcher.watch",
    ));

    firstScope.dispose();
    expect(ctx.$commander._commandList.some(
      (command) => command.name === "x-watcher.watch",
    )).toBe(false);

    const secondPlugin = { apply };
    ctx.plugin(secondPlugin, config);
    await waitFor(() => ctx.$commander._commandList.some(
      (command) => command.name === "x-watcher.watch",
    ));

    const commandNames = ctx.$commander._commandList.map(
      (command) => command.name,
    );
    expect(commandNames.filter(
      (command) => command === "x-watcher.watch",
    )).toHaveLength(1);
  });

  it("只填写 Rettiwt API Key 池也能完成启动并注册命令", async () => {
    const { ctx } = await createEnvironment();
    // // @ts-expect-error 验证 Koishi Schema 会补齐默认的 provider、mode 和 interval
    const config = Config({
      apiKeys: ["offline-constructor-test-key"],
      outputFormats: ["text"],
    });

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

  it("数据库迁移失败时保留同步命令但不启动 worker", async () => {
    const { ctx } = await createEnvironment();
    const get = vi.spyOn(ctx.database, "get");
    get.mockRejectedValueOnce(new Error("migration failed"));
    const setInterval = vi.spyOn(ctx, "setInterval");

    apply(ctx, {
      provider: "twitterapiio",
      mode: "polling",
      apiKey: "offline-test-key",
      interval: 5,
      outputFormats: ["text"],
    });
    await waitFor(() => get.mock.calls.length > 0);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const commandNames = ctx.$commander._commandList.map(
      (command) => command.name,
    );
    expect(commandNames).toContain("x-watcher.watch");
    expect(commandNames).toContain("x-watcher.unwatch");
    expect(commandNames).toContain("x-watcher.list");
    expect(setInterval).not.toHaveBeenCalled();
  });

  it("首次轮询尚未完成时卸载不会在异步恢复后注册幽灵命令", async () => {
    const { ctx } = await createEnvironment();
    let releasePolling: () => void = () => undefined;
    let pollingEntered = false;
    const pollingBlocked = new Promise<void>((resolve) => {
      releasePolling = resolve;
    });
    const get = vi.spyOn(ctx.database, "get");
    get.mockResolvedValueOnce([]);
    get.mockImplementationOnce(async () => {
      pollingEntered = true;
      await pollingBlocked;
      return [];
    });

    apply(ctx, {
      provider: "twitterapiio",
      mode: "polling",
      apiKey: "offline-test-key",
      interval: 5,
      outputFormats: ["text"],
    });
    await waitFor(() => pollingEntered);

    const stopping = ctx.stop();
    releasePolling();
    await stopping;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const commandNames = ctx.$commander._commandList.map(
      (command) => command.name,
    );
    expect(commandNames).not.toContain("x-watcher.watch");
    expect(commandNames).not.toContain("x-watcher.unwatch");
    expect(commandNames).not.toContain("x-watcher.list");
    expect(commandNames).not.toContain("x-watcher.latest");
  });
});
