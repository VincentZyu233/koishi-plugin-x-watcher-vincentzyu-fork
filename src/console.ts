import type { Context } from "koishi";
import { resolve } from "node:path";
import { z } from "zod";
import {} from "@koishijs/plugin-console";
import type { XDataSourceService } from "./services";
import { compileFilter, normalizeHandle } from "./domain";
import {
  createWatcher, updateExistingWatcher, userFromWatcher, remoteSyncSuffix,
  withManagementLock, deactivateWatcher, deleteWatcher, managementRevision,
} from "./subscriptions";

const rulesSchema = z.object({
  filter: z.string().max(2000).nullable(), media: z.boolean(),
  quote: z.boolean(), retweet: z.boolean(),
});
const targetSchema = z.object({
  platform: z.string().trim().min(1).max(100),
  botId: z.string().trim().min(1).max(256),
  channelId: z.string().trim().min(1).max(256),
});
const createSchema = targetSchema.extend({
  username: z.string().trim().min(1).max(100), rules: rulesSchema,
});
const mutationSchema = z.object({
  id: z.number().int().positive(), revision: z.string().min(1).max(10000),
  action: z.enum(["update", "deactivate", "reactivate", "delete"]),
  botId: z.string().trim().min(1).max(256), rules: rulesSchema,
});
export type CreateSubscription = z.infer<typeof createSchema>;
export type SubscriptionMutation = z.infer<typeof mutationSchema>;
export type ConsolePhase = "initializing" | "ready" | "failed" | "disposed";
export interface ConsoleOperationResult {
  readonly ok: boolean;
  readonly message: string;
  readonly pendingSync: boolean;
}

async function consoleOperation(action: () => Promise<ConsoleOperationResult>): Promise<ConsoleOperationResult> {
  try { return await action(); }
  catch (error) {
    return {
      ok: false, pendingSync: false,
      message: error instanceof z.ZodError ? "请求参数无效，请检查表单后重试"
        : error instanceof Error ? error.message : "操作失败，请稍后重试",
    };
  }
}

export function createConsoleService(
  ctx: Context,
  source: XDataSourceService,
  mode: string,
  synchronize: (() => Promise<boolean>) | null,
  phase: () => ConsolePhase,
) {
  function assertReady() {
    if (phase() !== "ready") throw new Error("插件尚未就绪、初始化失败或已卸载，暂时无法管理订阅");
  }
  function assertBot(platform: string, botId: string) {
    if (!ctx.bots.some((bot) => bot.platform === platform && bot.selfId === botId)) {
      throw new Error("所选机器人不存在或不属于此平台，请刷新页面");
    }
  }
  function validateRules(rules: z.infer<typeof rulesSchema>) {
    const filter = rules.filter === null || rules.filter.trim() === "" ? null : rules.filter.trim();
    const compiled = compileFilter(filter);
    if (!compiled.ok) throw new Error("正则表达式格式错误：" + compiled.error);
    return filter;
  }
  async function finish() {
    const suffix = await remoteSyncSuffix(synchronize);
    return { ok: true, message: suffix.trim() || "已保存", pendingSync: suffix.length > 0 };
  }
  async function state() {
    const status = phase();
    const rows = status === "ready" ? await ctx.database.get("x_watcher", {}) : [];
    // 头像是账号资料，不属于频道规则。按稳定 ID 共享已有缓存，
    // 优先采用较新订阅中非空的地址，不让旧记录的空值覆盖有效头像。
    const avatars = new Map<string, string>();
    for (const row of [...rows].sort((left, right) => left.id - right.id)) {
      const url = row.twitter_avatar_url;
      if (row.twitter_id.length > 0 && typeof url === "string" && url.trim().length > 0) {
        avatars.set(row.twitter_id, url.trim());
      }
    }
    return {
      phase: status, provider: source.provider, mode,
      bots: ctx.bots.map((bot) => ({
        platform: bot.platform ?? "", id: bot.selfId ?? "",
        name: (bot.user === undefined ? bot.selfId : bot.user.name || bot.selfId) ?? "",
        online: bot.status === 1,
      })).filter((bot) => bot.id.length > 0 && bot.platform.length > 0),
      rows: rows.map((row) => ({
        ...row, revision: managementRevision(row),
        twitter_avatar_url: avatars.get(row.twitter_id) ?? null,
        create_at: row.create_at.toISOString(), update_at: row.update_at.toISOString(),
        enabled_at: row.enabled_at instanceof Date ? row.enabled_at.toISOString() : null,
      })),
    };
  }
  async function create(input: CreateSubscription) {
    const data = createSchema.parse(input);
    const parsed = normalizeHandle(data.username);
    if (!parsed.ok) throw new Error(parsed.error);
    const filter = validateRules(data.rules);
    return withManagementLock(ctx, async () => {
      assertReady();
      assertBot(data.platform, data.botId);
      const resolved = await source.resolveUser(parsed.value);
      if (!resolved.ok) throw new Error(resolved.error.message);
      const existing = await ctx.database.get("x_watcher", {
        platform: data.platform, channelId: data.channelId, twitter_id: resolved.value.id,
      });
      if (existing.length > 0) throw new Error("该频道已有此账号的订阅，请编辑或恢复现有记录");
      const baseline = await source.fetchBaseline(resolved.value);
      if (!baseline.ok) throw new Error("建立订阅水位失败：" + baseline.error.message);
      assertReady();
      await createWatcher(ctx, { ...data, userId: "console:x-watcher" },
        resolved.value, baseline.value, filter, data.rules);
      return finish();
    });
  }
  async function mutate(input: SubscriptionMutation) {
    const data = mutationSchema.parse(input);
    const filter = data.action === "update" ? validateRules(data.rules) : null;
    return withManagementLock(ctx, async () => {
      assertReady();
      const [row] = await ctx.database.get("x_watcher", { id: data.id });
      assertReady();
      if (row === undefined || managementRevision(row) !== data.revision) {
        throw new Error("订阅已变更或删除，请刷新后重新操作");
      }
      if (data.action === "delete") await deleteWatcher(ctx, row);
      else if (data.action === "deactivate") await deactivateWatcher(ctx, row);
      else if (data.action === "update") {
        // 保留未加载机器人旧值，允许离线环境编辑规则。
        if (data.botId !== row.botId) assertBot(row.platform, data.botId);
        await ctx.database.set("x_watcher", { id: row.id }, {
          botId: data.botId, filter_regexp: filter, media: data.rules.media,
          include_quote: data.rules.quote, include_retweet: data.rules.retweet,
          update_at: new Date(),
        });
      } else {
        if (row.active) throw new Error("订阅已经启用，请刷新页面");
        assertBot(row.platform, row.botId);
        const user = userFromWatcher(row);
        const baseline = await source.fetchBaseline(user);
        if (!baseline.ok) throw new Error("建立订阅水位失败：" + baseline.error.message);
        assertReady();
        await updateExistingWatcher(ctx, {
          platform: row.platform, channelId: row.channelId, botId: row.botId,
          userId: "console:x-watcher",
        }, row, user, row.filter_regexp, {
          media: row.media, quote: row.include_quote === true, retweet: row.include_retweet === true,
        }, true, baseline.value);
      }
      return finish();
    });
  }
  return { state, create, mutate };
}

export type SubscriptionConsole = ReturnType<typeof createConsoleService>;
export type ConsoleState = Awaited<ReturnType<SubscriptionConsole["state"]>>;
export type ConsoleRow = ConsoleState["rows"][number];

declare module "@koishijs/plugin-console" {
  interface Events {
    "x-watcher/state"(): Promise<ConsoleState>;
    "x-watcher/create"(input: CreateSubscription): Promise<ConsoleOperationResult>;
    "x-watcher/mutate"(input: SubscriptionMutation): Promise<ConsoleOperationResult>;
  }
}

export function registerConsole(ctx: Context, service: SubscriptionConsole) {
  ctx.console.addEntry({
    dev: resolve(__dirname, "../client/index.ts"), prod: resolve(__dirname, "../dist"),
  });
  ctx.console.addListener("x-watcher/state", () => service.state(), { authority: 3 });
  ctx.console.addListener("x-watcher/create", (input) => consoleOperation(() => service.create(input)), { authority: 3 });
  ctx.console.addListener("x-watcher/mutate", (input) => consoleOperation(() => service.mutate(input)), { authority: 3 });
  const names = ["x-watcher/state", "x-watcher/create", "x-watcher/mutate"];
  const listeners = ctx.console.listeners;
  const registered = new Map(names.map((name) => [name, listeners[name]]));
  ctx.on("dispose", () => {
    for (const name of names) {
      if (listeners[name] === registered.get(name)) {
        delete listeners[name];
      }
    }
  });
}
