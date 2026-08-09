import {
  MediaType,
  Rettiwt,
  TwitterError,
  type Tweet,
  type User,
} from "rettiwt-api";
import {
  AxiosHeaders,
  isAxiosError,
  type AxiosHeaderValue,
  type AxiosResponseHeaders,
  type RawAxiosResponseHeaders,
} from "axios";

import {
  canonicalHandle,
  compareSnowflake,
  failure,
  isSnowflakeId,
  maxSnowflake,
  newestActivityId,
  normalizeActivityOrder,
  sourceError,
  success,
  type ActivityBatch,
  type ActivityCursor,
  type Result,
  type SourceError,
  type SourceErrorKind,
  type XActivity,
  type XMedia,
  type XUser,
} from "../domain";
import type { XDataSourceService } from "../services";

const PAGE_SIZE = 20;
const RATE_LIMIT_COOLDOWN_MILLISECONDS = 60_000;
const RATE_LIMIT_RESET_PADDING_MILLISECONDS = 1_000;

/** Rettiwt SDK 与领域模型之间的最小用户结构，也是离线测试的注入边界。 */
export interface RettiwtUserData {
  readonly id: string;
  readonly username: string;
  readonly fullname: string;
}

/** Rettiwt SDK 与领域模型之间的最小媒体结构。 */
export interface RettiwtMediaData {
  readonly kind: "image" | "gif" | "video";
  readonly url: string;
}

/** Rettiwt SDK 与领域模型之间的最小动态结构。 */
export interface RettiwtTweetData {
  readonly id: string;
  readonly authorId: string;
  readonly username: string;
  readonly fullname: string;
  readonly text: string;
  readonly createdAt: string;
  readonly url: string;
  readonly media: ReadonlyArray<RettiwtMediaData>;
  readonly replyTo: string | null;
  readonly hasQuote: boolean;
  readonly hasRetweet: boolean;
}

/** Rettiwt 两类时间线共同使用的分页结果。 */
export interface RettiwtPage {
  readonly tweets: ReadonlyArray<RettiwtTweetData>;
  readonly nextCursor: string | null;
}

/** provider 只依赖 Rettiwt 的三个读取动作，便于隔离不稳定 SDK。 */
export interface RettiwtClient {
  readonly resolveUser: (
    handle: string,
  ) => Promise<RettiwtUserData | null>;
  readonly fetchTimeline: (
    userId: string,
    cursor: string | null,
  ) => Promise<RettiwtPage>;
  readonly fetchReplies: (
    userId: string,
    cursor: string | null,
  ) => Promise<RettiwtPage>;
}

/** 创建 SDK 客户端时必须关闭其内部重试和日志。 */
export interface RettiwtClientConfiguration {
  readonly maxRetries: 0;
  readonly logging: false;
  readonly proxy?: string;
}

type RateLimitBucket = "user-details" | "timeline" | "replies";

interface RateLimitObservation {
  readonly remaining: number | null;
  readonly resetAt: number | null;
}

type RateLimitObserver = (
  bucket: RateLimitBucket,
  observation: RateLimitObservation,
) => void;

export type RettiwtClientFactory = (
  apiKey: string,
  configuration: RettiwtClientConfiguration,
  observeRateLimit: RateLimitObserver,
) => RettiwtClient;

/** 日志边界只暴露脱敏后的告警文本。 */
export interface RettiwtProviderLogger {
  readonly warn: (message: string) => void;
}

/** Rettiwt provider 的函数式依赖注入参数。 */
export interface RettiwtProviderOptions {
  readonly apiKeys: ReadonlyArray<string>;
  readonly proxy?: string;
  readonly logger?: RettiwtProviderLogger;
  readonly now?: () => number;
  readonly createClient?: RettiwtClientFactory;
}

interface TokenEntry {
  readonly index: number;
  readonly client: RettiwtClient;
  readonly rateLimits: Map<RateLimitBucket, RateLimitObservation>;
  readonly fallbackCooldowns: Map<RateLimitBucket, number>;
  disabled: boolean;
}

interface ClassifiedError {
  readonly kind: SourceErrorKind;
  readonly message: string;
}

type TimelineName = "timeline" | "replies";

type RateLimitHeaders = RawAxiosResponseHeaders | AxiosResponseHeaders;

type RunWithToken = <Value>(
  bucket: RateLimitBucket,
  operation: (client: RettiwtClient) => Promise<Value>,
) => Promise<Result<Value, SourceError>>;

const silentLogger: RettiwtProviderLogger = {
  warn: () => undefined,
};

/** 将 Rettiwt SDK 的媒体枚举转换为供应商无关结构。 */
function mapSdkMedia(tweet: Tweet): ReadonlyArray<RettiwtMediaData> {
  let media = tweet.media;
  if (
    (media === undefined || media.length === 0)
    && tweet.retweetedTweet !== undefined
  ) {
    media = tweet.retweetedTweet.media;
  }
  if (media === undefined) return [];

  return media
    .filter((media) => media.url.length > 0)
    .map((media) => {
      if (media.type === MediaType.PHOTO) {
        return { kind: "image", url: media.url };
      }
      if (media.type === MediaType.GIF) {
        return { kind: "gif", url: media.url };
      }
      return { kind: "video", url: media.url };
    });
}

/** SDK 对象在此处被立即压缩，避免供应商类型进入其他模块。 */
function mapSdkTweet(tweet: Tweet): RettiwtTweetData {
  return {
    id: tweet.id,
    authorId: tweet.tweetBy.id,
    username: tweet.tweetBy.userName,
    fullname: tweet.tweetBy.fullName,
    text: tweet.fullText,
    createdAt: tweet.createdAt,
    url: tweet.url,
    media: mapSdkMedia(tweet),
    replyTo: tweet.replyTo === undefined ? null : tweet.replyTo,
    hasQuote: tweet.quoted !== undefined,
    hasRetweet: tweet.retweetedTweet !== undefined,
  };
}

function mapSdkUser(user: User): RettiwtUserData {
  return {
    id: user.id,
    username: user.userName,
    fullname: user.fullName,
  };
}

function mapSdkPage(
  tweets: ReadonlyArray<Tweet>,
  nextCursor: string,
): RettiwtPage {
  return {
    tweets: tweets.map(mapSdkTweet),
    nextCursor: nextCursor.length === 0 ? null : nextCursor,
  };
}

/** 将 Axios 响应头收紧为非负整数，异常或复合值一律忽略。 */
function parseRateLimitHeader(
  value: AxiosHeaderValue | undefined,
): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function readRateLimitHeader(
  headers: RateLimitHeaders,
  name: string,
): AxiosHeaderValue | undefined {
  if (headers instanceof AxiosHeaders) {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  return headers[name];
}

/** Rettiwt 的限流桶按 GraphQL 端点独立计算。 */
function rateLimitBucketFromUrl(url: string | undefined): RateLimitBucket | null {
  if (url === undefined) return null;
  if (url.includes("/UserTweetsAndReplies")) return "replies";
  if (url.includes("/UserTweets")) return "timeline";
  if (
    url.includes("/UserByScreenName") ||
    url.includes("/UserByRestId") ||
    url.includes("/UsersByRestIds")
  ) {
    return "user-details";
  }
  return null;
}

/** 成功和失败响应都通过同一入口记录 remaining 与服务端 reset 时间。 */
function observeRateLimitHeaders(
  url: string | undefined,
  headers: RateLimitHeaders,
  observeRateLimit: RateLimitObserver,
): void {
  const bucket = rateLimitBucketFromUrl(url);
  if (bucket === null) return;
  const remaining = parseRateLimitHeader(
    readRateLimitHeader(headers, "x-rate-limit-remaining"),
  );
  const resetSeconds = parseRateLimitHeader(
    readRateLimitHeader(headers, "x-rate-limit-reset"),
  );
  observeRateLimit(bucket, {
    remaining,
    resetAt: resetSeconds === null ? null : resetSeconds * 1_000,
  });
}

/** 默认适配器是唯一直接接触 Rettiwt 7.1.2 SDK 的位置。 */
function createSdkClient(
  apiKey: string,
  configuration: RettiwtClientConfiguration,
  observeRateLimit: RateLimitObserver,
): RettiwtClient {
  const sdk = new Rettiwt({
    apiKey,
    logging: configuration.logging,
    maxRetries: configuration.maxRetries,
    ...(configuration.proxy === undefined
      ? {}
      : { proxy: configuration.proxy }),
    responseMiddleware: (response) => {
      observeRateLimitHeaders(
        response.config.url,
        response.headers,
        observeRateLimit,
      );
    },
    errorHandler: {
      handle: (error) => {
        if (isAxiosError(error)) {
          if (error.response !== undefined) {
            const url = error.config === undefined
              ? undefined
              : error.config.url;
            observeRateLimitHeaders(
              url,
              error.response.headers,
              observeRateLimit,
            );
          }
          throw error;
        }
        if (error instanceof Error) throw error;
        throw new Error("Rettiwt 返回了无法识别的错误");
      },
    },
  });

  return {
    resolveUser: async (handle) => {
      const user = await sdk.user.details(handle);
      return user === undefined ? null : mapSdkUser(user);
    },
    fetchTimeline: async (userId, cursor) => {
      const page = cursor === null
        ? await sdk.user.timeline(userId, PAGE_SIZE)
        : await sdk.user.timeline(userId, PAGE_SIZE, cursor);
      return mapSdkPage(page.list, page.next);
    },
    fetchReplies: async (userId, cursor) => {
      const page = cursor === null
        ? await sdk.user.replies(userId, PAGE_SIZE)
        : await sdk.user.replies(userId, PAGE_SIZE, cursor);
      return mapSdkPage(page.list, page.next);
    },
  };
}

/** SDK 抛出的细节不向外透传，避免错误文本意外包含凭据。 */
function classifySdkError(error: Error): ClassifiedError {
  if (error instanceof TwitterError) {
    const hasAuthenticationCode = error.details.some((detail) =>
      [32, 89, 99, 135, 215, 220, 326].includes(detail.code)
    );
    const hasRateLimitCode = error.details.some((detail) => detail.code === 88);

    if (error.status === 429 || hasRateLimitCode) {
      return { kind: "rate-limit", message: "Rettiwt 请求受到速率限制" };
    }
    if (error.status === 401 || error.status === 403 || hasAuthenticationCode) {
      return { kind: "authentication", message: "Rettiwt 凭据认证失败" };
    }
    if (error.status === 404) {
      return { kind: "not-found", message: "X 用户或资源不存在" };
    }
    return { kind: "transport", message: "Rettiwt 请求失败" };
  }

  const message = error.message.toLowerCase();
  if (/\b429\b|rate.?limit|too many requests/.test(message)) {
    return { kind: "rate-limit", message: "Rettiwt 请求受到速率限制" };
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|authenticat|invalid (api|cookie)|csrf/.test(message)) {
    return { kind: "authentication", message: "Rettiwt 凭据认证失败" };
  }
  if (/\b404\b|not.?found/.test(message)) {
    return { kind: "not-found", message: "X 用户或资源不存在" };
  }
  return { kind: "transport", message: "Rettiwt 网络请求失败" };
}

function toSourceError(classified: ClassifiedError): SourceError {
  const retryAfter = classified.kind === "rate-limit"
    ? RATE_LIMIT_COOLDOWN_MILLISECONDS
    : null;
  return sourceError(
    "rettiwt",
    classified.kind,
    classified.message,
    retryAfter,
  );
}

/**
 * 启动时逐个构造客户端。单个凭据格式错误只隔离对应序号，
 * 原始 key 和构造异常均不会进入日志或返回错误。
 */
function createTokenEntries(
  options: RettiwtProviderOptions,
  logger: RettiwtProviderLogger,
  factory: RettiwtClientFactory,
): ReadonlyArray<TokenEntry> {
  const entries: TokenEntry[] = [];
  let index = 0;

  for (const apiKey of options.apiKeys) {
    if (apiKey.trim().length === 0) {
      logger.warn(`Rettiwt 凭据 #${index + 1} 为空，已隔离`);
      index += 1;
      continue;
    }

    try {
      const rateLimits = new Map<RateLimitBucket, RateLimitObservation>();
      entries.push({
        index,
        client: factory(
          apiKey,
          {
            maxRetries: 0,
            logging: false,
            ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
          },
          (bucket, observation) => {
            rateLimits.set(bucket, observation);
          },
        ),
        rateLimits,
        fallbackCooldowns: new Map(),
        disabled: false,
      });
    } catch (error) {
      logger.warn(`Rettiwt 凭据 #${index + 1} 初始化失败，已隔离`);
    }
    index += 1;
  }

  return entries;
}

/** 优先采用 X 响应头中的 reset；只有拿不到响应头时才使用本地回退冷却。 */
function entryCooldownUntil(
  entry: TokenEntry,
  bucket: RateLimitBucket,
): number {
  const fallback = entry.fallbackCooldowns.get(bucket);
  const observation = entry.rateLimits.get(bucket);
  if (
    observation === undefined ||
    observation.remaining === null ||
    observation.remaining > 0 ||
    observation.resetAt === null
  ) {
    return fallback === undefined ? 0 : fallback;
  }
  const observedReset = observation.resetAt
    + RATE_LIMIT_RESET_PADDING_MILLISECONDS;
  return fallback === undefined
    ? observedReset
    : Math.max(fallback, observedReset);
}

function rateLimitBucketLabel(bucket: RateLimitBucket): string {
  if (bucket === "timeline") return "推文时间线";
  if (bucket === "replies") return "回复时间线";
  return "用户解析";
}

/**
 * 每次调用都从配置中的第一枚可用凭据开始。认证失败永久隔离，
 * 每个 GraphQL 端点分别依据响应头 reset 冷却，缺少响应头时回退 60 秒。
 */
function createTokenRunner(
  entries: ReadonlyArray<TokenEntry>,
  logger: RettiwtProviderLogger,
  now: () => number,
): RunWithToken {
  return async <Value>(
    bucket: RateLimitBucket,
    operation: (client: RettiwtClient) => Promise<Value>,
  ) => {
    let lastError: SourceError | null = null;
    let nearestCooldown: number | null = null;

    for (const entry of entries) {
      if (entry.disabled) continue;

      const currentTime = now();
      const cooldownUntil = entryCooldownUntil(entry, bucket);
      if (cooldownUntil > currentTime) {
        const remaining = cooldownUntil - currentTime;
        nearestCooldown = nearestCooldown === null
          ? remaining
          : Math.min(nearestCooldown, remaining);
        continue;
      }

      try {
        return success(await operation(entry.client));
      } catch (error) {
        let classified: ClassifiedError;
        if (error instanceof Error) {
          classified = classifySdkError(error);
        } else {
          classified = {
            kind: "transport",
            message: "Rettiwt 网络请求失败",
          };
        }
        if (classified.kind === "not-found") {
          return failure(toSourceError(classified));
        }

        if (classified.kind === "authentication") {
          lastError = toSourceError(classified);
          entry.disabled = true;
          logger.warn(`Rettiwt 凭据 #${entry.index + 1} 认证失败，已隔离`);
          continue;
        }

        if (classified.kind === "rate-limit") {
          const limitedAt = now();
          const observation = entry.rateLimits.get(bucket);
          const observedCooldown = observation !== undefined
              && observation.remaining !== null
              && observation.remaining <= 0
              && observation.resetAt !== null
              && observation.resetAt > limitedAt
            ? observation.resetAt + RATE_LIMIT_RESET_PADDING_MILLISECONDS
            : null;
          const nextCooldown = observedCooldown === null
            ? limitedAt + RATE_LIMIT_COOLDOWN_MILLISECONDS
            : observedCooldown;
          entry.fallbackCooldowns.set(bucket, nextCooldown);
          const retryAfter = nextCooldown - limitedAt;
          lastError = sourceError(
            "rettiwt",
            "rate-limit",
            classified.message,
            retryAfter,
          );
          const seconds = Math.max(1, Math.ceil(retryAfter / 1_000));
          logger.warn(
            `Rettiwt 凭据 #${entry.index + 1} 的${rateLimitBucketLabel(bucket)}触发限流，冷却 ${seconds} 秒`,
          );
          continue;
        }

        lastError = toSourceError(classified);
        logger.warn(`Rettiwt 凭据 #${entry.index + 1} 请求失败，尝试下一凭据`);
      }
    }

    if (lastError !== null) return failure(lastError);
    if (nearestCooldown !== null) {
      return failure(sourceError(
        "rettiwt",
        "rate-limit",
        `所有 Rettiwt 凭据的${rateLimitBucketLabel(bucket)}均处于冷却期`,
        nearestCooldown,
      ));
    }
    return failure(sourceError(
      "rettiwt",
      "unavailable",
      "没有可用的 Rettiwt 凭据",
    ));
  };
}

function parseCreatedAt(value: string): Date | null {
  const createdAt = new Date(value);
  return Number.isNaN(createdAt.getTime()) ? null : createdAt;
}

function mapMedia(
  media: ReadonlyArray<RettiwtMediaData>,
): ReadonlyArray<XMedia> {
  return media
    .filter((item) => item.url.length > 0)
    .map((item) => ({ kind: item.kind, url: item.url }));
}

/** 四种动态按转推、引用、回复、原创的互斥顺序判定。 */
function mapActivity(tweet: RettiwtTweetData): XActivity | null {
  if (!isSnowflakeId(tweet.id)) return null;
  const createdAt = parseCreatedAt(tweet.createdAt);
  if (createdAt === null) return null;

  const kind = tweet.hasRetweet
    ? "retweet"
    : tweet.hasQuote
      ? "quote"
      : tweet.replyTo === null
        ? "post"
        : "reply";

  return {
    id: tweet.id,
    authorId: tweet.authorId,
    username: tweet.username,
    fullname: tweet.fullname,
    kind,
    text: tweet.text,
    createdAt,
    url: tweet.url,
    media: mapMedia(tweet.media),
  };
}

function isTargetTweet(tweet: RettiwtTweetData, user: XUser): boolean {
  if (tweet.authorId === user.id) return true;
  return tweet.authorId.length === 0
    && canonicalHandle(tweet.username) === canonicalHandle(user.username);
}

type TweetBoundaryPosition = "after" | "at-or-before";

/** 只对可比较的 Snowflake 或时间生成边界位置，无效供应商数据不参与停止判断。 */
function tweetBoundaryPosition(
  tweet: RettiwtTweetData,
  cursor: ActivityCursor,
): TweetBoundaryPosition | null {
  if (cursor.lastId !== null) {
    if (!isSnowflakeId(tweet.id)) return null;
    return compareSnowflake(tweet.id, cursor.lastId) > 0
      ? "after"
      : "at-or-before";
  }
  const createdAt = parseCreatedAt(tweet.createdAt);
  if (createdAt === null) return null;
  return createdAt.getTime() >= cursor.enabledAt.getTime()
    ? "after"
    : "at-or-before";
}

/**
 * Rettiwt 会把置顶旧帖放在首部，不能看到第一条旧帖就停止。
 * 正常时间线按新到旧排列：全页只有旧帖，或已看到新帖后又看到旧帖，才表示真正越过水位。
 */
function hasCrossedBoundary(
  tweets: ReadonlyArray<RettiwtTweetData>,
  cursor: ActivityCursor,
): boolean {
  let sawAfterBoundary = false;
  let sawAtOrBeforeBoundary = false;

  for (const tweet of tweets) {
    const position = tweetBoundaryPosition(tweet, cursor);
    if (position === null) continue;
    if (position === "after") {
      sawAfterBoundary = true;
      continue;
    }
    sawAtOrBeforeBoundary = true;
    if (sawAfterBoundary) return true;
  }
  return sawAtOrBeforeBoundary && !sawAfterBoundary;
}

function isAfterBoundary(
  activity: XActivity,
  cursor: ActivityCursor,
): boolean {
  if (cursor.lastId !== null) {
    return compareSnowflake(activity.id, cursor.lastId) > 0;
  }
  return activity.createdAt.getTime() >= cursor.enabledAt.getTime();
}

function readPage(
  runWithToken: RunWithToken,
  timeline: TimelineName,
  userId: string,
  cursor: string | null,
): Promise<Result<RettiwtPage, SourceError>> {
  return runWithToken(timeline, (client) => timeline === "timeline"
    ? client.fetchTimeline(userId, cursor)
    : client.fetchReplies(userId, cursor));
}

/**
 * 分页必须越过持久化边界才可停止。首屏可能夹带置顶旧帖，
 * 因此只有整页目标账号动态均在边界之前时才停止，避免被置顶帖提前截断。
 */
async function collectTimeline(
  runWithToken: RunWithToken,
  timeline: TimelineName,
  user: XUser,
  cursor: ActivityCursor,
  until: Date,
): Promise<Result<ReadonlyArray<XActivity>, SourceError>> {
  const activities: XActivity[] = [];
  const visitedCursors = new Set<string>();
  let nextCursor: string | null = null;

  while (true) {
    const pageResult = await readPage(
      runWithToken,
      timeline,
      user.id,
      nextCursor,
    );
    if (!pageResult.ok) return pageResult;

    const targetTweets = pageResult.value.tweets.filter((tweet) =>
      isTargetTweet(tweet, user)
    );
    for (const tweet of targetTweets) {
      const activity = mapActivity(tweet);
      if (activity === null) continue;
      if (!isAfterBoundary(activity, cursor)) continue;
      if (activity.createdAt.getTime() > until.getTime()) continue;
      activities.push(activity);
    }

    const crossedBoundary = hasCrossedBoundary(targetTweets, cursor);
    if (crossedBoundary || pageResult.value.nextCursor === null) {
      return success(activities);
    }

    const followingCursor = pageResult.value.nextCursor;
    // Rettiwt/X 会用“空页 + 原样返回请求游标”表示时间线已经到底。
    // 这类末页可以安全结束；非空页或游标环仍按失败处理，避免提交不完整批次。
    if (
      pageResult.value.tweets.length === 0 &&
      nextCursor !== null &&
      followingCursor === nextCursor
    ) {
      return success(activities);
    }
    if (visitedCursors.has(followingCursor)) {
      return failure(sourceError(
        "rettiwt",
        "decode",
        "Rettiwt 返回了重复的分页游标",
      ));
    }
    visitedCursors.add(followingCursor);
    nextCursor = followingCursor;
  }
}

/** 取首屏时间线与回复中的最大 Snowflake，建立不补历史的初始水位。 */
async function fetchNewestBaseline(
  runWithToken: RunWithToken,
  user: XUser,
): Promise<Result<string | null, SourceError>> {
  const timelineResult = await readPage(
    runWithToken,
    "timeline",
    user.id,
    null,
  );
  if (!timelineResult.ok) return timelineResult;

  const repliesResult = await readPage(
    runWithToken,
    "replies",
    user.id,
    null,
  );
  if (!repliesResult.ok) return repliesResult;

  let newest: string | null = null;
  const tweets = [
    ...timelineResult.value.tweets,
    ...repliesResult.value.tweets,
  ];
  for (const tweet of tweets) {
    if (!isTargetTweet(tweet, user) || !isSnowflakeId(tweet.id)) continue;
    newest = maxSnowflake(newest, tweet.id);
  }
  return success(newest);
}

/** 创建带顺序 token 池的 Rettiwt 轮询数据源。 */
export function createRettiwtDataSource(
  options: RettiwtProviderOptions,
): XDataSourceService {
  const logger = options.logger === undefined ? silentLogger : options.logger;
  const now = options.now === undefined ? Date.now : options.now;
  const factory = options.createClient === undefined
    ? createSdkClient
    : options.createClient;
  const entries = createTokenEntries(options, logger, factory);
  const runWithToken = createTokenRunner(entries, logger, now);

  return {
    provider: "rettiwt",
    resolveUser: async (handle) => {
      const result = await runWithToken(
        "user-details",
        (client) => client.resolveUser(handle),
      );
      if (!result.ok) return result;
      if (result.value === null) {
        return failure(sourceError(
          "rettiwt",
          "not-found",
          "X 用户不存在",
        ));
      }
      return success({
        id: result.value.id,
        username: result.value.username,
        fullname: result.value.fullname,
      });
    },
    fetchBaseline: (user) => fetchNewestBaseline(runWithToken, user),
    fetchAfter: async (user, cursor, until) => {
      const timelineResult = await collectTimeline(
        runWithToken,
        "timeline",
        user,
        cursor,
        until,
      );
      if (!timelineResult.ok) return timelineResult;

      const repliesResult = await collectTimeline(
        runWithToken,
        "replies",
        user,
        cursor,
        until,
      );
      if (!repliesResult.ok) return repliesResult;

      const activities = normalizeActivityOrder([
        ...timelineResult.value,
        ...repliesResult.value,
      ]);
      const batch: ActivityBatch = {
        activities,
        newestId: newestActivityId(activities),
      };
      return success(batch);
    },
  };
}
