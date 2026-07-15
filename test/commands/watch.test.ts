import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import { Bot, Context, Universal, type Session } from "@koishijs/core";
import {
  SubscriptionApplication,
  type SubscriptionApplicationError,
  type SubscriptionApplicationService,
  type WatchRequest,
} from "../../src/application/subscription";
import { registerCommands, type CommandRuntime } from "../../src/commands";
import { DefaultActivityKinds } from "../../src/domain/activity";
import {
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  DecodeError,
  PersistenceError,
  RateLimitError,
  TransportError,
  UserUnavailableError,
} from "../../src/domain/errors";
import {
  parseActivityId,
  parseXUserId,
} from "../../src/domain/identifiers";
import type { StoredSubscription } from "../../src/ports/storage";

/** 从测试输入的 Either 中提取成功值。 */
const expectRight = <A, E>(value: Either.Either<A, E>): A => {
  if (Either.isLeft(value)) throw new Error(String(value.left));
  return value.right;
};

/** 提供能够创建真实 Session 的最小测试机器人。 */
class TestBot extends Bot {
  /** 创建 test 平台机器人并设置稳定机器人 ID。 */
  constructor(ctx: Context) {
    // Koishi 的 Bot 泛型在 exactOptionalPropertyTypes 下错误收窄到基础 Cordis Context。
    super(ctx as never, {}, "test");
    this.user = { id: "bot" };
  }
}

/** watch 命令测试夹具对外暴露的能力。 */
interface WatchHarness {
  readonly parse: (source: string) => {
    readonly args?: ReadonlyArray<unknown>;
    readonly options?: Readonly<Record<string, unknown>>;
    readonly error?: string;
  };
  readonly execute: (
    username: string,
    regexp: string | undefined,
    options: Readonly<Record<string, boolean | string>>,
  ) => Promise<unknown>;
  readonly capturedRequest: () => WatchRequest;
  readonly dispose: () => Promise<void>;
}

/** 根据命令请求构造足够用于结果渲染的订阅。 */
const makeStoredSubscription = (request: WatchRequest): StoredSubscription => ({
  id: 1,
  accountId: 1,
  platform: request.target.platform,
  channelId: request.target.channelId,
  guildId: request.target.guildId,
  isDirect: request.target.isDirect,
  creatorId: request.target.actorId,
  botId: request.target.botId,
  kinds: request.kinds === null ? DefaultActivityKinds : request.kinds,
  filterPattern: request.filter._tag === "Set" ? request.filter.pattern : null,
  filterStatus: "valid",
  includeMedia: request.includeMedia === true,
  active: true,
  cursor: expectRight(parseActivityId("200")),
  account: {
    id: 1,
    xUserId: expectRight(parseXUserId("100")),
    handle: request.handle,
    displayName: "Example User",
    cursor: expectRight(parseActivityId("200")),
    status: "ready",
    lastError: null,
    recoveryDueAt: null,
  },
  remoteStatus: "not-required",
});

/** 创建走真实 Koishi Command action 的 watch 测试夹具。 */
const makeWatchHarness = (
  watchHandler?: SubscriptionApplicationService["watch"],
): WatchHarness => {
  const ctx = new Context();
  const bot = new TestBot(ctx);
  // Session 的运行时混入由 Koishi 提供，但其基础 Bot 声明只返回 Satori Session。
  const session = bot.session({
    user: { id: "actor" },
    channel: { id: "channel", type: Universal.Channel.Type.DIRECT },
  }) as Session;
  session.isDirect = true;
  let captured: WatchRequest | undefined;
  const application: SubscriptionApplicationService = {
    /** 捕获命令生成的局部补丁并返回可渲染结果。 */
    watch: (request) => {
      captured = request;
      if (watchHandler !== undefined) return watchHandler(request);
      return Effect.succeed({
        outcome: "created",
        subscription: makeStoredSubscription(request),
        baselinePending: false,
      });
    },
    /** 本夹具不执行 unwatch。 */
    unwatch: () => Effect.succeed({ _tag: "NotFound" }),
    /** 本夹具不执行 list。 */
    list: () => Effect.succeed([]),
  };
  const runtime: CommandRuntime = {
    /** 为命令 Effect 注入订阅应用测试服务。 */
    runPromise: (effect) => Effect.runPromise(
      Effect.provideService(effect, SubscriptionApplication, application),
    ),
  };
  registerCommands(ctx, runtime);
  const command = ctx.$commander.get("watch");
  if (command === undefined) throw new Error("watch 命令未注册");

  return {
    /** 使用 Koishi 真实命令解析器解析参数和布尔否定选项。 */
    parse: (source) => command.parse(source),
    /** 直接执行已注册 action，同时保留参数与选项的有无差异。 */
    execute: (username, regexp, options) => command.execute({
      session,
      args: regexp === undefined ? [username] : [username, regexp],
      options,
    }),
    /** 读取最近一次成功进入应用服务的请求。 */
    capturedRequest: () => {
      if (captured === undefined) throw new Error("watch 请求尚未进入应用服务");
      return captured;
    },
    /** 释放本夹具注册的命令。 */
    dispose: async () => {
      command.dispose();
    },
  };
};

describe("watch 命令补丁语义", () => {
  it("真实解析器保留带空格正则并识别其后的媒体选项", async () => {
    const harness = makeWatchHarness();
    try {
      const parsed = harness.parse('openai "release note" --media');
      expect(parsed.error).toBe("");
      expect(parsed.args).toEqual(["openai", "release note"]);
      expect(parsed.options).toEqual({ media: true });
    } finally {
      await harness.dispose();
    }
  });

  it("真实解析器将 --no-media 保留为显式 false", async () => {
    const harness = makeWatchHarness();
    try {
      const parsed = harness.parse("openai --no-media");
      expect(parsed.error).toBe("");
      expect(parsed.args).toEqual(["openai"]);
      expect(parsed.options).toEqual({ media: false });
    } finally {
      await harness.dispose();
    }
  });

  it("省略 types、regexp 与 media 时保留已有值", async () => {
    const harness = makeWatchHarness();
    try {
      await harness.execute("@OpenAI", undefined, {});
      const request = harness.capturedRequest();

      expect(request.handle).toBe("openai");
      expect(request.kinds).toBeNull();
      expect(request.filter).toEqual({ _tag: "Preserve" });
      expect(request.includeMedia).toBeNull();
    } finally {
      await harness.dispose();
    }
  });

  it("--clear-filter 生成清空补丁", async () => {
    const harness = makeWatchHarness();
    try {
      await harness.execute("openai", undefined, { clearFilter: true });
      expect(harness.capturedRequest().filter).toEqual({ _tag: "Clear" });
    } finally {
      await harness.dispose();
    }
  });

  it("显式 media=true 与 media=false 都不会被当作省略", async () => {
    const enabled = makeWatchHarness();
    const disabled = makeWatchHarness();
    try {
      await enabled.execute("openai", undefined, { media: true });
      await disabled.execute("openai", undefined, { media: false });

      expect(enabled.capturedRequest().includeMedia).toBe(true);
      expect(disabled.capturedRequest().includeMedia).toBe(false);
    } finally {
      await enabled.dispose();
      await disabled.dispose();
    }
  });

  it("显式 types 与 regexp 生成规范化补丁", async () => {
    const harness = makeWatchHarness();
    try {
      await harness.execute("openai", "  release\\s+note  ", {
        types: "Reply,post,reply",
      });
      const request = harness.capturedRequest();

      expect(request.kinds).toEqual(["reply", "post"]);
      expect(request.filter).toEqual({ _tag: "Set", pattern: "release\\s+note" });
    } finally {
      await harness.dispose();
    }
  });
});

describe("watch 命令用户错误", () => {
  it("拒绝同时设置与清空过滤规则", async () => {
    const harness = makeWatchHarness();
    try {
      const result = await harness.execute("openai", "release", { clearFilter: true });
      expect(result).toBe("不能同时提供正则表达式与 --clear-filter");
    } finally {
      await harness.dispose();
    }
  });

  it("将 RE2 不支持语法翻译为可读错误", async () => {
    const harness = makeWatchHarness();
    try {
      const result = await harness.execute("openai", "(?<=prefix)suffix", {});
      expect(String(result)).toContain("正则表达式不受 RE2 支持：");
    } finally {
      await harness.dispose();
    }
  });

  it("拒绝非法用户名", async () => {
    const harness = makeWatchHarness();
    try {
      const result = await harness.execute("invalid-handle", undefined, {});
      expect(result).toBe("请提供有效的 X/Twitter 用户名");
    } finally {
      await harness.dispose();
    }
  });

  const cases: ReadonlyArray<readonly [SubscriptionApplicationError, string]> = [
    [
      new AuthorizationError({ message: "只有创建者可操作" }),
      "只有创建者可操作",
    ],
    [
      new ConfigurationError({ message: "插件配置无效" }),
      "插件配置无效",
    ],
    [
      new UserUnavailableError({ handle: "openai", message: "目标用户不可访问" }),
      "目标用户不可访问",
    ],
    [
      new AuthenticationError({ provider: "twitterapi", message: "bad key" }),
      "twitterapi 认证失败，请联系插件管理员检查密钥",
    ],
    [
      new RateLimitError({
        provider: "twitterapi",
        retryAfterMillis: 60_000,
        message: "slow down",
      }),
      "twitterapi 正在限流，请稍后重试",
    ],
    [
      new TransportError({ provider: "twitterapi", message: "connection reset" }),
      "twitterapi 暂时不可用：connection reset",
    ],
    [
      new DecodeError({ provider: "twitterapi", message: "unexpected payload" }),
      "twitterapi 返回了无法识别的数据，请稍后重试",
    ],
    [
      new PersistenceError({ operation: "save", message: "database locked" }),
      "订阅数据库操作失败：database locked",
    ],
  ];

  it.each(cases)("将 %s 翻译为中文用户提示", async (error, expected) => {
    const harness = makeWatchHarness(() => Effect.fail(error));
    try {
      const result = await harness.execute("openai", undefined, {});
      expect(result).toBe(expected);
    } finally {
      await harness.dispose();
    }
  });
});
