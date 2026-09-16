import { createRequire } from "node:module";
import { type Context, Logger, h } from "@koishijs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands";
import { formatHelpMessage, helpCommands } from "../src/help";
import { createMessageOutput } from "../src/output";
import { formatActivityMessage, formatRecentActivitiesMessage } from "../src/formatter";

// 使用 Koishi 的原生入口验证 help 插件集成。
const nativeRequire = createRequire(import.meta.url);
const nativeCore: typeof import("@koishijs/core") = nativeRequire("@koishijs/core");
const help: typeof import("@koishijs/plugin-help") = nativeRequire("@koishijs/plugin-help");
// @ts-expect-error 上游 Bot 的 Context 约束与 Minato 泛型在 exactOptionalPropertyTypes 下不兼容
class HelpBot extends nativeCore.Bot<Context> {
  readonly messages: string[] = [];
  async sendMessage(_channel: string, message: import("@koishijs/core").Fragment) {
    this.messages.push(h.normalize(message).join(""));
    return [];
  }
  // 测试机器人没有实际连接，无需执行连接清理。
  async dispose() {}
}
const contexts: Context[] = [];
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.stop(); });

async function environment() {
  const ctx = new nativeCore.Context();
  contexts.push(ctx);
  ctx.plugin(help, { shortcut: false });
  const fetch = vi.fn(async (): Promise<never> => { throw new Error("帮助不得查询数据源"); });
  const defaults = { latestDefaultUsername: "LatestTest", recentDefaultUsername: "RecentTest", recentDefaultCount: 7 };
  registerCommands(ctx, {
    mode: "polling", synchronizeMonitors: null, interval: 5, ...defaults,
    source: { provider: "rettiwt", resolveUser: fetch, fetchBaseline: fetch, fetchAfter: fetch },
  }, new Logger("help-test"));
  const bot = new HelpBot(ctx, {}, "test");
  bot.user = { id: "bot", name: "Test" };
  await ctx.start();
  expect(ctx.koishi).toBeDefined();
  return {
    ctx, fetch, defaults,
    execute: async (content: string) => {
      // Cordis 从服务集合提供带上下文关联的 Bot 代理。
      const session = ctx.bots[0]!.session({
        user: { id: "user" }, channel: { id: "channel", type: 0 }, message: { id: "trigger", content },
      });
      bot.messages.length = 0;
      session.locales = ["zh-CN"];
      await session.execute(content);
      return h.parse(bot.messages.join("\n")).map(item => item.type === "text" ? item.attrs.content : item.toString()).join("");
    },
  };
}

describe("真实 Koishi help 输出", () => {
  it("全部完整指令名及别名的 --help 含描述、说明、示例且不查询数据源", async () => {
    const env = await environment();
    for (const command of helpCommands(env.defaults)) {
      const names = [command.name, command.syntax.split(" ")[0]!, ...command.aliases];
      for (const name of new Set(names)) {
        const message = await env.execute(`${name} --help`);
        expect(message, name).toContain(command.emoji);
        expect(message, name).toContain(command.description);
        for (const note of command.notes) expect(message, name).toContain(note);
        for (const option of command.options) expect(message, name).toContain(option.description);
        for (const example of command.examples) expect(message, name).toContain(example);
      }
    }
    expect(env.fetch).not.toHaveBeenCalled();
  });
  it("原生帮助和 xhe 使用实例默认值，可选类型和每类数量均完整", async () => {
    const env = await environment();
    const latest = await env.execute("xla --help");
    expect(latest).toContain("@LatestTest");
    expect(latest).toContain("post＝原创推文、reply＝回复");
    const recent = await env.execute("xre --help");
    expect(recent).toContain("@RecentTest");
    expect(recent).toContain("当前默认 7");
    expect(recent).toContain("3 条推文＋3 条回复");
    const overview = await env.execute("xhe");
    expect(overview).toContain("@LatestTest");
    expect(overview).toContain("@RecentTest");
    expect(overview).toContain("📡 xwatch <twitter_username> [regexp]");
    expect(env.fetch).not.toHaveBeenCalled();
  });
});

describe("文字 Emoji 与卡片帮助隔离", () => {
  it("卡片收到完整无装饰内容，文字保留指令标识", async () => {
    const renderHelp = vi.fn(async () => Buffer.from("image"));
    const output = createMessageOutput("card-text", {
      mimeType: "image/png", renderHelp,
      renderActivity: async () => Buffer.from(""), renderWatcherList: async () => Buffer.from(""),
      renderRecentActivities: async () => [],
    }, new Logger("test"));
    const message = await output.help({ recentDefaultCount: 9 });
    expect(message).toContain("❓ X Watcher");
    expect(message).toContain("当前默认 9");
    expect(renderHelp).toHaveBeenCalledWith(helpCommands({ recentDefaultCount: 9 }));
    for (const command of helpCommands()) {
      expect([command.syntax, command.description, ...command.notes, ...command.examples].join("")).not.toMatch(/\p{Extended_Pictographic}/u);
    }
    expect(formatHelpMessage()).toContain("ℹ️ 通用说明");
  });
  it("xre 标识位于序号前，动态顺序和正文不变", () => {
    const common = { authorId: "1", username: "test", fullname: "Test", createdAt: new Date("2026-09-16T00:00:00Z"), url: "https://x.com/test/1", media: [] };
    const post = { ...common, id: "2", kind: "post" as const, text: "hello & <world>" };
    const reply = { ...common, id: "1", kind: "reply" as const, text: "@test reply" };
    const message = formatRecentActivitiesMessage({ id: "1", username: "test", fullname: "Test" }, [post, reply]);
    expect(message).toContain("🕒 Test");
    expect(message).toContain("📝 1. 发布了新推文");
    expect(message).toContain("💬 2. 发布了新回复");
    expect(h.parse(message).map(item => item.attrs.content).join("")).toContain(post.text);
    expect(formatActivityMessage(post)).toMatch(/^📝 Test/);
    expect(formatActivityMessage({ ...reply, kind: "quote" })).toMatch(/^💭 Test/);
    expect(formatActivityMessage({ ...reply, kind: "retweet" })).toMatch(/^🔁 Test/);
  });
});
