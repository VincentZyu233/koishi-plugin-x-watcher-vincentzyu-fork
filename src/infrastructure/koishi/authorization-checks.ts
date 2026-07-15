import type { Bot, Context as KoishiContext } from "koishi";
import type { AuthorizationRequest } from "../../ports/platform";

/** Telegram 管理员列表接口的最小结构。 */
interface TelegramInternal {
  /** 查询 Telegram 聊天管理员。 */
  readonly getChatAdministrators: (input: {
    readonly chat_id: string;
  }) => Promise<ReadonlyArray<{ readonly user?: { readonly id?: number } }>>;
}

/** Discord 管理员判定所需接口的最小结构。 */
interface DiscordInternal {
  /** 查询 Discord 服务器与身份组。 */
  readonly getGuild: (guildId: string) => Promise<{
    readonly owner_id: string;
    readonly roles: ReadonlyArray<{
      readonly id: string;
      readonly permissions: string;
    }>;
  }>;
  /** 查询 Discord 服务器成员。 */
  readonly getGuildMember: (
    guildId: string,
    userId: string,
  ) => Promise<{ readonly roles: ReadonlyArray<string> }>;
}

/** QQ 频道管理员判定所需接口的最小结构。 */
interface QqGuildInternal {
  /** 查询 QQ 频道成员身份组。 */
  readonly getGuildMember: (
    guildId: string,
    userId: string,
  ) => Promise<{ readonly roles: ReadonlyArray<string> }>;
}

const DISCORD_ADMINISTRATOR = 1n << 3n;
const QQ_ADMIN_ROLES: ReadonlySet<string> = new Set(["2", "4", "5"]);

/** 把 Koishi 未收窄的 internal 值限制为可检查对象。 */
const asInternalObject = (
  value: object | null | undefined,
): object | null => (typeof value === "object" && value !== null ? value : null);

/** 判断对象是否实现 Telegram 管理员列表接口。 */
const isTelegramInternal = (value: object): value is TelegramInternal =>
  "getChatAdministrators" in value &&
  typeof value.getChatAdministrators === "function";

/** 判断对象是否实现 Discord 管理员查询接口。 */
const isDiscordInternal = (value: object): value is DiscordInternal =>
  "getGuild" in value &&
  typeof value.getGuild === "function" &&
  "getGuildMember" in value &&
  typeof value.getGuildMember === "function";

/** 判断对象是否实现 QQ 频道成员查询接口。 */
const isQqGuildInternal = (value: object): value is QqGuildInternal =>
  "getGuildMember" in value && typeof value.getGuildMember === "function";

/** 从 Koishi 上下文查找订阅创建时使用的机器人。 */
const findBot = (
  ctx: KoishiContext,
  request: AuthorizationRequest,
): Bot | undefined =>
  ctx.bots.find(
    (bot) => bot.platform === request.platform && bot.selfId === request.botId,
  );

/** 通过 Telegram 管理员列表判断调用者权限。 */
const isTelegramAdministrator = async (
  bot: Bot,
  request: AuthorizationRequest,
): Promise<boolean> => {
  if (request.guildId === null) return false;
  const internal = asInternalObject(bot.internal);
  if (internal === null || !isTelegramInternal(internal)) return false;
  const administrators = await internal.getChatAdministrators({
    chat_id: request.guildId,
  });
  return administrators.some(
    (member) =>
      member.user !== undefined &&
      member.user.id !== undefined &&
      String(member.user.id) === request.actorId,
  );
};

/** 通过 Discord 所有者与 ADMINISTRATOR 位判断调用者权限。 */
const isDiscordAdministrator = async (
  bot: Bot,
  request: AuthorizationRequest,
): Promise<boolean> => {
  if (request.guildId === null) return false;
  const internal = asInternalObject(bot.internal);
  if (internal === null || !isDiscordInternal(internal)) return false;
  const guild = await internal.getGuild(request.guildId);
  if (guild.owner_id === request.actorId) return true;
  const member = await internal.getGuildMember(
    request.guildId,
    request.actorId,
  );
  const roleIds = new Set<string>([request.guildId, ...member.roles]);
  return guild.roles.some(
    (role) =>
      roleIds.has(role.id) &&
      (BigInt(role.permissions) & DISCORD_ADMINISTRATOR) !== 0n,
  );
};

/** 通过 QQ 默认管理身份组判断调用者权限。 */
const isQqGuildAdministrator = async (
  bot: Bot,
  request: AuthorizationRequest,
): Promise<boolean> => {
  if (request.guildId === null) return false;
  const internal = asInternalObject(bot.internal);
  if (internal === null || !isQqGuildInternal(internal)) return false;
  const member = await internal.getGuildMember(
    request.guildId,
    request.actorId,
  );
  return member.roles.some((role) => QQ_ADMIN_ROLES.has(role));
};

/** 按平台执行可靠的管理员查询，未知平台一律拒绝。 */
export const lookupAdministrator = async (
  ctx: KoishiContext,
  request: AuthorizationRequest,
): Promise<boolean> => {
  const bot = findBot(ctx, request);
  if (bot === undefined) return false;
  if (request.platform === "telegram") {
    return isTelegramAdministrator(bot, request);
  }
  if (request.platform === "discord") {
    return isDiscordAdministrator(bot, request);
  }
  if (request.platform === "qqguild") {
    return isQqGuildAdministrator(bot, request);
  }
  return false;
};
