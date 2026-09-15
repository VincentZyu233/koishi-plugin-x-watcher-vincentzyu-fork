import { z } from "zod";
import {
  canonicalHandle,
  compareSnowflake,
  failure,
  newestActivityId,
  normalizeActivityOrder,
  snowflakeDate,
  sourceError,
  success,
  type ActivityBatch,
  type ActivityCursor,
  type ActivityKind,
  type Result,
  type SourceError,
  type XActivity,
  type XMedia,
  type XUser,
} from "../domain";
import type { XDataSourceService } from "../services";

const API_BASE_URL = "https://api.twitterapi.io";
const USER_INFO_PATH = "/twitter/user/info";
const LAST_TWEETS_PATH = "/twitter/user/last_tweets";
const ADVANCED_SEARCH_PATH = "/twitter/tweet/advanced_search";
const MAX_REQUEST_ATTEMPTS = 3;
const DEFAULT_RATE_LIMIT_DELAY = 1_000;

const snowflakeSchema = z.string().regex(/^\d+$/);
const handleSchema = z.string().regex(/^[A-Za-z0-9_]{1,15}$/);

const userSchema = z.object({
  id: snowflakeSchema,
  userName: handleSchema,
  name: z.string(),
  profilePicture: z.string().url().optional(),
  profileImage: z.string().url().optional(),
  profile_image_url: z.string().url().optional(),
});

function userAvatar(user: z.output<typeof userSchema>): string | undefined {
  return user.profilePicture ?? user.profileImage ?? user.profile_image_url;
}

const userResponseSchema = z.object({
  data: userSchema,
  status: z.literal("success").optional(),
});

const videoVariantSchema = z.object({
  url: z.string().min(1),
  bitrate: z.number().nonnegative().optional(),
  content_type: z.string().optional(),
});

const mediaSchema = z.object({
  type: z.enum(["photo", "image", "video", "animated_gif", "gif"]),
  url: z.string().min(1).optional(),
  media_url: z.string().min(1).optional(),
  media_url_https: z.string().min(1).optional(),
  preview_image_url: z.string().min(1).optional(),
  variants: z.array(videoVariantSchema).optional(),
  video_info: z.object({
    variants: z.array(videoVariantSchema),
  }).optional(),
});

const mediaContainerSchema = z.object({
  media: z.array(mediaSchema).optional(),
});

const tweetReferenceSchema = z
  .union([
    z.string().min(1),
    z.object({
      id: snowflakeSchema,
      media: z.array(mediaSchema).optional(),
      entities: mediaContainerSchema.optional(),
      extendedEntities: mediaContainerSchema.optional(),
      extended_entities: mediaContainerSchema.optional(),
    }),
    z.literal(true),
  ])
  .nullable()
  .optional();

const createdAtSchema = z
  .string()
  .transform((value) => new Date(value))
  .refine((value) => !Number.isNaN(value.getTime()));

const tweetSchema = z.object({
  id: snowflakeSchema,
  url: z.string().min(1),
  text: z.string(),
  createdAt: createdAtSchema,
  type: z.string().optional(),
  tweetType: z.string().optional(),
  isReply: z.boolean().optional(),
  inReplyToId: z.string().nullable().optional(),
  quoted_tweet: tweetReferenceSchema,
  retweeted_tweet: tweetReferenceSchema,
  author: userSchema,
  media: z.array(mediaSchema).optional(),
  entities: mediaContainerSchema.optional(),
  extendedEntities: mediaContainerSchema.optional(),
  extended_entities: mediaContainerSchema.optional(),
});

const pageSchema = z.object({
  tweets: z.array(tweetSchema),
  has_next_page: z.boolean(),
  next_cursor: z.string(),
  status: z.literal("success").optional(),
});

interface DecodedActivityPage {
  readonly activities: ReadonlyArray<XActivity>;
  readonly hasNextPage: boolean;
  readonly nextCursor: string;
}

interface TextResponse {
  readonly status: number;
  readonly text: string;
  readonly headers: Headers;
}

interface TwitterApiHttpConfig {
  readonly method: "GET";
  readonly headers: Readonly<Record<string, string>>;
  readonly params: Readonly<Record<string, string | boolean>>;
  readonly responseType: "text";
  readonly validateStatus: (status: number) => boolean;
}

interface TwitterApiHttpResponse {
  readonly status: number;
  readonly data: string;
  readonly headers: Headers;
}

/** 仅描述本 provider 使用到的 Koishi 上下文能力，便于纯离线测试。 */
export interface TwitterApiContext {
  readonly http: (
    url: string,
    config: TwitterApiHttpConfig,
  ) => Promise<TwitterApiHttpResponse>;
}

/**
 * 将供应商用户响应收敛为领域用户。
 * 只接受官方 data 包装，避免静默兼容未记录的响应变体。
 */
export function decodeTwitterApiUser(
  text: string,
): Result<XUser, SourceError> {
  const decoded = parseUserText(text);
  if (decoded === null || !decoded.success) {
    return failure(sourceError(
      "twitterapiio",
      "decode",
      "TwitterAPI.io 用户响应格式无效",
    ));
  }

  const avatarUrl = userAvatar(decoded.data.data);
  return success({
    id: decoded.data.data.id,
    username: decoded.data.data.userName,
    fullname: decoded.data.data.name,
    ...(avatarUrl === undefined ? {} : { avatarUrl }),
  });
}

/**
 * 将一页供应商推文转换为统一动态，并在此处隔离供应商字段。
 * 该纯函数导出是为了让离线 fixture 能覆盖协议变化。
 */
export function decodeTwitterApiActivityPage(
  text: string,
): Result<DecodedActivityPage, SourceError> {
  const decoded = parsePageText(text);
  if (decoded === null || !decoded.success) {
    return failure(sourceError(
      "twitterapiio",
      "decode",
      "TwitterAPI.io 推文响应格式无效",
    ));
  }

  const activities = decoded.data.tweets.map((tweet) => {
    const avatarUrl = userAvatar(tweet.author);
    return {
      id: tweet.id,
      authorId: tweet.author.id,
      username: tweet.author.userName,
      fullname: tweet.author.name,
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
      kind: resolveActivityKind(tweet),
      text: tweet.text,
      createdAt: tweet.createdAt,
      url: tweet.url,
      media: normalizeMedia(tweet),
    };
  });

  return success({
    activities,
    hasNextPage: decoded.data.has_next_page,
    nextCursor: decoded.data.next_cursor,
  });
}

function parseUserText(text: string) {
  try {
    return userResponseSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

function parsePageText(text: string) {
  try {
    return pageSchema.safeParse(JSON.parse(text));
  } catch {
    return null;
  }
}

function hasTweetReference(
  reference: string | { readonly id: string } | true | null | undefined,
): boolean {
  return reference !== null && reference !== undefined;
}

/** 按外层动态语义决定类型，转推和引用优先于回复标志。 */
function resolveActivityKind(
  tweet: z.output<typeof tweetSchema>,
): ActivityKind {
  const suppliedType = tweet.tweetType === undefined
    ? tweet.type
    : tweet.tweetType;
  if (
    suppliedType === "retweet"
    || suppliedType === "repost"
    || hasTweetReference(tweet.retweeted_tweet)
  ) {
    return "retweet";
  }
  if (
    suppliedType === "quote"
    || hasTweetReference(tweet.quoted_tweet)
  ) {
    return "quote";
  }
  if (
    suppliedType === "reply"
    || suppliedType === "thread"
    || tweet.isReply === true
    || (tweet.inReplyToId !== undefined && tweet.inReplyToId !== null)
  ) {
    return "reply";
  }
  return "post";
}

function appendMedia(
  output: Array<XMedia>,
  seen: Set<string>,
  media: z.output<typeof mediaSchema>,
): void {
  const kind = media.type === "photo" || media.type === "image"
    ? "image"
    : media.type === "video"
      ? "video"
      : "gif";
  const preview = media.media_url_https === undefined
    ? media.media_url === undefined
      ? media.preview_image_url === undefined
        ? media.url
        : media.preview_image_url
      : media.media_url
    : media.media_url_https;
  const variant = selectVideoVariant(media);
  const url = kind === "image"
    ? preview === undefined
      ? variant
      : preview
    : variant === null
      ? preview
      : variant;

  if (url === undefined || url === null || seen.has(url)) return;
  seen.add(url);
  output.push({
    kind,
    url,
    ...(preview === undefined || preview === null || preview.length === 0
      ? {}
      : { previewUrl: preview }),
  });
}

function selectVideoVariant(
  media: z.output<typeof mediaSchema>,
): string | null {
  const variants = media.variants === undefined
    ? media.video_info === undefined
      ? []
      : media.video_info.variants
    : media.variants;

  let selectedUrl: string | null = null;
  let selectedBitrate = -1;
  for (const variant of variants) {
    if (
      variant.content_type !== undefined
      && variant.content_type !== "video/mp4"
    ) {
      continue;
    }
    const bitrate = variant.bitrate === undefined ? 0 : variant.bitrate;
    if (selectedUrl === null || bitrate > selectedBitrate) {
      selectedUrl = variant.url;
      selectedBitrate = bitrate;
    }
  }
  return selectedUrl;
}

/** 合并历史与当前字段名，保证同一媒体只输出一次。 */
function normalizeMedia(
  tweet: z.output<typeof tweetSchema>,
): ReadonlyArray<XMedia> {
  const output: Array<XMedia> = [];
  const seen = new Set<string>();
  const groups: Array<ReadonlyArray<z.output<typeof mediaSchema>>> = [];

  if (tweet.media !== undefined) groups.push(tweet.media);
  if (tweet.entities !== undefined && tweet.entities.media !== undefined) {
    groups.push(tweet.entities.media);
  }
  if (
    tweet.extendedEntities !== undefined
    && tweet.extendedEntities.media !== undefined
  ) {
    groups.push(tweet.extendedEntities.media);
  }
  if (
    tweet.extended_entities !== undefined
    && tweet.extended_entities.media !== undefined
  ) {
    groups.push(tweet.extended_entities.media);
  }

  // 转推外层通常不重复媒体字段，仅在外层为空时读取被转推推文的附件。
  const retweeted = tweet.retweeted_tweet;
  if (
    groups.length === 0 &&
    retweeted !== undefined &&
    retweeted !== null &&
    retweeted !== true &&
    typeof retweeted !== "string"
  ) {
    if (retweeted.media !== undefined) groups.push(retweeted.media);
    if (
      retweeted.entities !== undefined &&
      retweeted.entities.media !== undefined
    ) {
      groups.push(retweeted.entities.media);
    }
    if (
      retweeted.extendedEntities !== undefined &&
      retweeted.extendedEntities.media !== undefined
    ) {
      groups.push(retweeted.extendedEntities.media);
    }
    if (
      retweeted.extended_entities !== undefined &&
      retweeted.extended_entities.media !== undefined
    ) {
      groups.push(retweeted.extended_entities.media);
    }
  }

  for (const group of groups) {
    for (const media of group) appendMedia(output, seen, media);
  }
  return output;
}

function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (raw === null) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const deadline = Date.parse(raw);
  if (Number.isNaN(deadline)) return null;
  return Math.max(0, deadline - Date.now());
}

function errorForStatus(status: number, headers: Headers): SourceError {
  if (status === 401 || status === 403) {
    return sourceError(
      "twitterapiio",
      "authentication",
      "TwitterAPI.io 鉴权失败",
    );
  }
  if (status === 404) {
    return sourceError(
      "twitterapiio",
      "not-found",
      "TwitterAPI.io 未找到请求的资源",
    );
  }
  if (status === 429) {
    const retryAfter = parseRetryAfter(headers);
    return sourceError(
      "twitterapiio",
      "rate-limit",
      "TwitterAPI.io 请求频率受限",
      retryAfter === null ? DEFAULT_RATE_LIMIT_DELAY : retryAfter,
    );
  }
  const retryAfter = status >= 500 ? parseRetryAfter(headers) : null;
  return sourceError(
    "twitterapiio",
    "unavailable",
    status >= 500
      ? "TwitterAPI.io 服务暂时不可用"
      : "TwitterAPI.io 拒绝了请求",
    retryAfter,
  );
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * 所有请求强制读取文本，再交给对应 Zod schema 解码。
 * 网络错误、限流和服务端故障最多额外尝试两次，客户端错误立即返回。
 */
async function requestText(
  ctx: TwitterApiContext,
  apiKey: string,
  path: string,
  params: Readonly<Record<string, string | boolean>>,
): Promise<Result<TextResponse, SourceError>> {
  let attempt = 0;
  while (attempt < MAX_REQUEST_ATTEMPTS) {
    try {
      const response = await ctx.http(`${API_BASE_URL}${path}`, {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        params,
        responseType: "text",
        validateStatus: () => true,
      });

      if (response.status >= 200 && response.status < 300) {
        return success({
          status: response.status,
          text: response.data,
          headers: response.headers,
        });
      }

      const statusFailure = errorForStatus(response.status, response.headers);
      attempt += 1;
      if (
        !shouldRetryStatus(response.status)
        || attempt >= MAX_REQUEST_ATTEMPTS
      ) {
        return failure(statusFailure);
      }
      const retryDelay = statusFailure.retryAfterMilliseconds === null
        ? 0
        : statusFailure.retryAfterMilliseconds;
      await wait(retryDelay);
    } catch {
      attempt += 1;
      if (attempt >= MAX_REQUEST_ATTEMPTS) {
        return failure(sourceError(
          "twitterapiio",
          "transport",
          "无法连接 TwitterAPI.io",
        ));
      }
    }
  }

  return failure(sourceError(
    "twitterapiio",
    "transport",
    "无法连接 TwitterAPI.io",
  ));
}

function secondsSinceEpoch(date: Date): number {
  return Math.floor(date.getTime() / 1_000);
}

function cursorStartDate(cursor: ActivityCursor): Date {
  if (cursor.lastId === null) return cursor.enabledAt;
  const date = snowflakeDate(cursor.lastId);
  return date === null ? cursor.enabledAt : date;
}

function isAfterCursor(
  activity: XActivity,
  cursor: ActivityCursor,
  until: Date,
): boolean {
  if (activity.createdAt.getTime() > until.getTime()) return false;
  if (cursor.lastId !== null) {
    return compareSnowflake(activity.id, cursor.lastId) > 0;
  }
  return activity.createdAt.getTime() >= cursor.enabledAt.getTime();
}

/** Latest 分页一旦出现水位本身或更旧动态，后续页面无需继续付费读取。 */
function hasReachedCursor(
  activities: ReadonlyArray<XActivity>,
  cursor: ActivityCursor,
): boolean {
  const lastId = cursor.lastId;
  if (lastId !== null) {
    return activities.some(
      (activity) => compareSnowflake(activity.id, lastId) <= 0,
    );
  }
  return activities.some(
    (activity) => activity.createdAt.getTime() < cursor.enabledAt.getTime(),
  );
}

/** 创建基于 TwitterAPI.io REST API 的统一数据源。 */
export function createTwitterApiDataSource(
  ctx: TwitterApiContext,
  apiKey: string,
): XDataSourceService {
  const resolveUser = async (
    handle: string,
  ): Promise<Result<XUser, SourceError>> => {
    const response = await requestText(
      ctx,
      apiKey,
      USER_INFO_PATH,
      { userName: handle },
    );
    if (!response.ok) return response;
    return decodeTwitterApiUser(response.value.text);
  };

  const fetchBaseline = async (
    user: XUser,
  ): Promise<Result<string | null, SourceError>> => {
    const response = await requestText(
      ctx,
      apiKey,
      LAST_TWEETS_PATH,
      { userId: user.id, includeReplies: true },
    );
    if (!response.ok) return response;

    const page = decodeTwitterApiActivityPage(response.value.text);
    if (!page.ok) return page;
    return success(newestActivityId(page.value.activities));
  };

  /**
   * 高级搜索按游标完整翻页。若远端重复游标，则整轮失败而不返回部分结果，
   * 防止上层推进水位后永久跳过尚未取回的页面。
   */
  const fetchAfter = async (
    user: XUser,
    cursor: ActivityCursor,
    until: Date,
  ): Promise<Result<ActivityBatch, SourceError>> => {
    const query = [
      `from:${user.username}`,
      "include:nativeretweets",
      `since_time:${secondsSinceEpoch(cursorStartDate(cursor))}`,
      `until_time:${secondsSinceEpoch(until)}`,
    ].join(" ");
    const seenCursors = new Set<string>();
    const collected: Array<XActivity> = [];
    const seenActivityIds = new Set<string>();
    let nextCursor = "";
    let hasNextPage = true;

    while (hasNextPage) {
      const params = nextCursor.length === 0
        ? { query, queryType: "Latest" }
        : { query, queryType: "Latest", cursor: nextCursor };
      const response = await requestText(
        ctx,
        apiKey,
        ADVANCED_SEARCH_PATH,
        params,
      );
      if (!response.ok) return response;

      const page = decodeTwitterApiActivityPage(response.value.text);
      if (!page.ok) return page;
      let discovered = 0;
      for (const activity of page.value.activities) {
        if (seenActivityIds.has(activity.id)) continue;
        seenActivityIds.add(activity.id);
        collected.push(activity);
        discovered += 1;
      }
      hasNextPage = page.value.hasNextPage;

      if (
        !hasNextPage ||
        hasReachedCursor(page.value.activities, cursor)
      ) {
        break;
      }
      // 空中间页仍可能携带有效 next_cursor，必须继续翻页，否则上层推进水位后会漏掉后续页。
      // 非空分页若完全没有带来新 ID，才说明供应商数据没有前进。
      if (page.value.activities.length > 0 && discovered === 0) {
        return failure(sourceError(
          "twitterapiio",
          "decode",
          "TwitterAPI.io 分页未产生新的动态",
        ));
      }
      const receivedCursor = page.value.nextCursor;
      if (
        receivedCursor.length === 0
        || seenCursors.has(receivedCursor)
      ) {
        return failure(sourceError(
          "twitterapiio",
          "decode",
          "TwitterAPI.io 返回了无效的分页游标",
        ));
      }
      seenCursors.add(receivedCursor);
      nextCursor = receivedCursor;
    }

    const activities = normalizeActivityOrder(
      collected.filter((activity) => isAfterCursor(activity, cursor, until)),
    );
    return success({
      activities,
      newestId: newestActivityId(activities),
    });
  };

  const fetchLatest = async (
    user: XUser,
    kind: "post" | "reply",
  ): Promise<Result<XActivity | null, SourceError>> => {
    const response = await requestText(
      ctx,
      apiKey,
      LAST_TWEETS_PATH,
      { userId: user.id, includeReplies: true },
    );
    if (!response.ok) return response;
    const page = decodeTwitterApiActivityPage(response.value.text);
    if (!page.ok) return page;
    const matches = page.value.activities
      .filter((activity) => activity.kind === kind)
      .sort((left, right) => compareSnowflake(right.id, left.id));
    return success(matches[0] ?? null);
  };

  const fetchRecent = async (
    user: XUser,
    count: number,
  ): Promise<Result<ReadonlyArray<XActivity>, SourceError>> => {
    const collected: XActivity[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let nextCursor = "";
    let hasNextPage = true;

    while (hasNextPage) {
      const postCount = collected.filter((activity) => activity.kind === "post").length;
      const replyCount = collected.filter((activity) => activity.kind === "reply").length;
      if (postCount >= count && replyCount >= count) break;
      const params = nextCursor.length === 0
        ? { userId: user.id, includeReplies: true }
        : { userId: user.id, includeReplies: true, cursor: nextCursor };
      const response = await requestText(ctx, apiKey, LAST_TWEETS_PATH, params);
      if (!response.ok) return response;
      const page = decodeTwitterApiActivityPage(response.value.text);
      if (!page.ok) return page;
      for (const activity of page.value.activities) {
        if (
          (activity.kind !== "post" && activity.kind !== "reply")
          || (activity.authorId !== user.id
            && canonicalHandle(activity.username) !== canonicalHandle(user.username))
          || seenIds.has(activity.id)
        ) {
          continue;
        }
        seenIds.add(activity.id);
        collected.push(activity);
      }
      hasNextPage = page.value.hasNextPage;
      if (!hasNextPage) break;
      const receivedCursor = page.value.nextCursor;
      if (receivedCursor.length === 0 || seenCursors.has(receivedCursor)) {
        return failure(sourceError(
          "twitterapiio",
          "decode",
          "TwitterAPI.io 返回了无效的分页游标",
        ));
      }
      seenCursors.add(receivedCursor);
      nextCursor = receivedCursor;
    }

    const posts = collected
      .filter((activity) => activity.kind === "post")
      .sort((left, right) => compareSnowflake(right.id, left.id))
      .slice(0, count);
    const replies = collected
      .filter((activity) => activity.kind === "reply")
      .sort((left, right) => compareSnowflake(right.id, left.id))
      .slice(0, count);
    return success([...posts, ...replies].sort(
      (left, right) => compareSnowflake(right.id, left.id),
    ));
  };

  return {
    provider: "twitterapiio",
    resolveUser,
    fetchBaseline,
    fetchAfter,
    fetchLatest,
    fetchRecent,
  };
}
