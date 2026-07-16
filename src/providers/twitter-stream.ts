import type { Context } from "koishi";
import { z } from "zod";

import {
  failure,
  normalizeActivityOrder,
  normalizeHandle,
  sourceError,
  success,
} from "../domain";
import type {
  ActivityKind,
  Result,
  SourceError,
  XActivity,
  XMedia,
} from "../domain";
import type {
  AccountStreamService,
  MonitorEntry,
  MonitorStatus,
  StreamConnection,
  StreamHandlers,
} from "../services";

const API_BASE_URL = "https://api.twitterapi.io";
const STREAM_URL = "wss://ws.twitterapi.io/twitter/tweet/websocket";
const LIST_MONITORS_PATH =
  "/oapi/x_user_stream/get_user_to_monitor_tweet";
const ADD_MONITOR_PATH =
  "/oapi/x_user_stream/add_user_to_monitor_tweet";
const REMOVE_MONITOR_PATH =
  "/oapi/x_user_stream/remove_user_to_monitor_tweet";
const MAX_MONITOR_REQUEST_ATTEMPTS = 3;
const DEFAULT_RATE_LIMIT_DELAY_MILLISECONDS = 1_000;

type Headers = Readonly<Record<string, string>>;
type RequestBody = Readonly<Record<string, string>>;

/** REST transport 返回原始文本，让 provider 在边界统一执行 Zod 解码。 */
export interface TwitterStreamHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly retryAfter: string | null;
}

/** WebSocket adapter 仅向 provider 暴露 UTF-8 文本帧。 */
export interface TwitterStreamSocketHandlers {
  readonly onText: (text: string) => void;
  readonly onError: () => void;
  readonly onClosed: (code: number, reason: string) => void;
}

/** 测试替身和 Koishi WebSocket 共同需要的最小关闭能力。 */
export interface TwitterStreamTransportSocket {
  readonly close: (code: number, reason: string) => void;
}

/** 可替换 transport 使 provider 的所有测试保持离线。 */
export interface TwitterStreamTransport {
  readonly getText: (
    url: string,
    headers: Headers,
  ) => Promise<TwitterStreamHttpResponse>;
  readonly postText: (
    url: string,
    headers: Headers,
    body: RequestBody,
  ) => Promise<TwitterStreamHttpResponse>;
  readonly openSocket: (
    url: string,
    headers: Headers,
    handlers: TwitterStreamSocketHandlers,
  ) => TwitterStreamTransportSocket;
}

/** 纯解码结果让连接层只负责回调分派，不承担业务分类。 */
export type TwitterStreamFrame =
  | { readonly type: "connected" }
  | { readonly type: "ping" }
  | { readonly type: "ignored"; readonly warning: string | null }
  | {
      readonly type: "activities";
      readonly activities: ReadonlyArray<XActivity>;
    };

const SnowflakeSchema = z.string().regex(/^\d+$/);
const HttpMutationResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), msg: z.string() }),
  z.object({ status: z.literal("error"), msg: z.string() }),
]);

const MonitorStatusSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const RawMonitorSchema = z.object({
  id_for_user: z.string().min(1),
  x_user_screen_name: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  monitor_tweet_config_status: MonitorStatusSchema,
});

const MonitorListResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    msg: z.string(),
    data: z.array(RawMonitorSchema),
  }),
  z.object({ status: z.literal("error"), msg: z.string() }),
]);

const EventTypeSchema = z.object({ event_type: z.string() });
const ConnectedEventSchema = z.object({
  event_type: z.literal("connected"),
  timestamp: z.number().finite(),
});
const PingEventSchema = z.object({
  event_type: z.literal("ping"),
  timestamp: z.number().finite(),
});

const FastTweetSchema = z.object({
  id: SnowflakeSchema,
  screen_name: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  display_name: z.string().nullable().optional(),
  user_id: z.string().optional(),
  text: z.string(),
  type: z.string(),
  created_ms: z.number().int().nonnegative(),
  media: z.array(z.string().url()).nullable().optional(),
});

const FastTweetEventSchema = z.object({
  event_type: z.literal("fast_tweet"),
  timestamp: z.number().finite(),
  tweet: FastTweetSchema,
});

const StandardAuthorSchema = z.union([
  z.object({
    id: z.string().min(1),
    name: z.string(),
    userName: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  }),
  z.object({
    id: z.string().min(1),
    name: z.string(),
    username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  }),
]);

const VideoVariantSchema = z.object({
  url: z.string().url(),
  content_type: z.string(),
  bitrate: z.number().int().nonnegative().optional(),
});

const StandardMediaSchema = z.object({
  type: z.enum(["photo", "image", "animated_gif", "gif", "video"]),
  url: z.string().url().optional(),
  media_url: z.string().url().optional(),
  media_url_https: z.string().url().optional(),
  preview_image_url: z.string().url().optional(),
  variants: z.array(VideoVariantSchema).optional(),
  video_info: z
    .object({ variants: z.array(VideoVariantSchema) })
    .optional(),
});

const StandardMediaEntitiesSchema = z.object({
  media: z.array(StandardMediaSchema).optional(),
});

const ReferencedTweetSchema = z.union([
  z.object({
    id: SnowflakeSchema,
    media: z.array(StandardMediaSchema).optional(),
    entities: StandardMediaEntitiesSchema.optional(),
    extendedEntities: StandardMediaEntitiesSchema.optional(),
    extended_entities: StandardMediaEntitiesSchema.optional(),
  }),
  SnowflakeSchema,
  z.literal(true),
]);

const StandardTweetSchema = z.object({
  id: SnowflakeSchema,
  text: z.string(),
  author: StandardAuthorSchema,
  createdAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  url: z.string().url().optional(),
  type: z.string().optional(),
  tweetType: z.string().optional(),
  isReply: z.boolean().optional(),
  inReplyToId: z.string().nullable().optional(),
  quoted_tweet: ReferencedTweetSchema.nullable().optional(),
  retweeted_tweet: ReferencedTweetSchema.nullable().optional(),
  media: z.array(StandardMediaSchema).optional(),
  entities: StandardMediaEntitiesSchema.optional(),
  extendedEntities: StandardMediaEntitiesSchema.optional(),
  extended_entities: StandardMediaEntitiesSchema.optional(),
});

const StandardTweetEnvelopeSchema = z.object({
  event_type: z.literal("tweet"),
  rule_id: z.string().optional(),
});

const StandardTweetEventSchema = z.object({
  event_type: z.literal("tweet"),
  tweets: z.array(StandardTweetSchema),
  timestamp: z.number().finite(),
});

type FastTweet = z.infer<typeof FastTweetSchema>;
type StandardTweet = z.infer<typeof StandardTweetSchema>;
type StandardMedia = z.infer<typeof StandardMediaSchema>;

/** 远端 0～3 是一个有序配置状态机，统一映射为稳定领域枚举。 */
function mapMonitorStatus(status: 0 | 1 | 2 | 3): MonitorStatus {
  switch (status) {
    case 0:
      return "waiting";
    case 1:
      return "configuring";
    case 2:
      return "active";
    case 3:
      return "failed";
  }
}

/** fast lane 的 thread 与 reply 对订阅者而言都属于回复。 */
function mapFastActivityKind(value: string): ActivityKind | null {
  switch (value) {
    case "post":
      return "post";
    case "reply":
    case "thread":
      return "reply";
    case "quote":
      return "quote";
    case "repost":
      return "retweet";
    default:
      return null;
  }
}

function mediaKindFromUrl(url: string): XMedia["kind"] {
  const normalized = url.toLowerCase().split("?", 1)[0];
  if (normalized !== undefined && normalized.endsWith(".gif")) return "gif";
  // Twitter 动图常以 tweet_video/*.mp4 传输，可与普通视频路径稳定区分。
  if (
    normalized !== undefined &&
    normalized.includes("video.twimg.com/tweet_video/") &&
    normalized.endsWith(".mp4")
  ) {
    return "gif";
  }
  if (normalized !== undefined && normalized.endsWith(".mp4")) return "video";
  return "image";
}

function fastMedia(tweet: FastTweet): ReadonlyArray<XMedia> {
  if (tweet.media === undefined || tweet.media === null) return [];
  return tweet.media.map((url) => ({ kind: mediaKindFromUrl(url), url }));
}

function standardAuthorHandle(
  author: z.infer<typeof StandardAuthorSchema>,
): string {
  if ("userName" in author) return author.userName;
  return author.username;
}

function bestVideoUrl(media: StandardMedia): string {
  const variants = media.variants === undefined
    ? media.video_info === undefined
      ? []
      : media.video_info.variants
    : media.variants;
  const mp4 = variants
    .filter((variant) => variant.content_type === "video/mp4")
    .sort((left, right) => {
      const leftBitrate = left.bitrate === undefined ? 0 : left.bitrate;
      const rightBitrate = right.bitrate === undefined ? 0 : right.bitrate;
      return rightBitrate - leftBitrate;
    })[0];
  const preview = standardMediaPreview(media);
  if (mp4 !== undefined) return mp4.url;
  return preview === null ? "" : preview;
}

function standardMediaPreview(media: StandardMedia): string | null {
  if (media.media_url_https !== undefined) return media.media_url_https;
  if (media.media_url !== undefined) return media.media_url;
  if (media.preview_image_url !== undefined) return media.preview_image_url;
  return media.url === undefined ? null : media.url;
}

function standardMedia(tweet: StandardTweet): ReadonlyArray<XMedia> {
  const groups: Array<ReadonlyArray<StandardMedia>> = [];
  if (tweet.media !== undefined) groups.push(tweet.media);
  if (tweet.entities !== undefined && tweet.entities.media !== undefined) {
    groups.push(tweet.entities.media);
  }
  if (
    tweet.extendedEntities !== undefined &&
    tweet.extendedEntities.media !== undefined
  ) {
    groups.push(tweet.extendedEntities.media);
  }
  if (
    tweet.extended_entities !== undefined &&
    tweet.extended_entities.media !== undefined
  ) {
    groups.push(tweet.extended_entities.media);
  }

  // 转推外层没有附件时，从内层推文提取图片、GIF 或视频。
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

  const result: Array<XMedia> = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const media of group) {
      const preview = standardMediaPreview(media);
      const videoUrl = bestVideoUrl(media);
      const url = media.type === "video" || media.type === "animated_gif"
        ? videoUrl
        : preview;
      if (url === null || url.length === 0 || seen.has(url)) continue;
      seen.add(url);
      if (media.type === "photo" || media.type === "image") {
        result.push({ kind: "image", url });
      } else if (media.type === "animated_gif" || media.type === "gif") {
        result.push({ kind: "gif", url });
      } else {
        result.push({ kind: "video", url });
      }
    }
  }
  return result;
}

function fastActivity(tweet: FastTweet, kind: ActivityKind): XActivity {
  const fullname =
    tweet.display_name === undefined || tweet.display_name === null
      ? tweet.screen_name
      : tweet.display_name;
  const authorId = tweet.user_id === undefined ? tweet.screen_name : tweet.user_id;
  return {
    id: tweet.id,
    authorId,
    username: tweet.screen_name,
    fullname,
    kind,
    text: tweet.text,
    createdAt: new Date(tweet.created_ms),
    url: `https://x.com/${tweet.screen_name}/status/${tweet.id}`,
    media: fastMedia(tweet),
  };
}

function standardActivityKind(tweet: StandardTweet): ActivityKind {
  const suppliedType = tweet.tweetType === undefined
    ? tweet.type
    : tweet.tweetType;
  if (
    suppliedType === "retweet" ||
    suppliedType === "repost" ||
    tweet.retweeted_tweet !== undefined &&
    tweet.retweeted_tweet !== null
  ) {
    return "retweet";
  }
  if (
    suppliedType === "quote" ||
    tweet.quoted_tweet !== undefined && tweet.quoted_tweet !== null
  ) {
    return "quote";
  }
  if (
    suppliedType === "reply" ||
    suppliedType === "thread" ||
    tweet.isReply === true ||
    tweet.inReplyToId !== undefined && tweet.inReplyToId !== null
  ) {
    return "reply";
  }
  return "post";
}

function standardActivity(tweet: StandardTweet): XActivity {
  const username = standardAuthorHandle(tweet.author);
  const fallbackUrl = `https://x.com/${username}/status/${tweet.id}`;
  return {
    id: tweet.id,
    authorId: tweet.author.id,
    username,
    fullname: tweet.author.name,
    kind: standardActivityKind(tweet),
    text: tweet.text,
    createdAt: new Date(tweet.createdAt),
    url: tweet.url === undefined ? fallbackUrl : tweet.url,
    media: standardMedia(tweet),
  };
}

function decodeFailure(message: string): SourceError {
  return sourceError("twitterapiio", "decode", message);
}

/**
 * 流事件先按 event_type 分流，再解码各自的最小稳定结构。
 * 带 rule_id 的 tweet 属于另一套过滤规则产品，不能混入账号订阅。
 */
export function decodeTwitterStreamFrame(
  text: string,
): Result<TwitterStreamFrame, SourceError> {
  try {
    const raw = JSON.parse(text);
    const eventType = EventTypeSchema.safeParse(raw);
    if (!eventType.success) {
      return failure(decodeFailure("TwitterAPI.io 流事件缺少 event_type"));
    }

    switch (eventType.data.event_type) {
      case "connected": {
        const decoded = ConnectedEventSchema.safeParse(raw);
        return decoded.success
          ? success({ type: "connected" })
          : failure(decodeFailure("TwitterAPI.io connected 事件格式无效"));
      }
      case "ping": {
        const decoded = PingEventSchema.safeParse(raw);
        return decoded.success
          ? success({ type: "ping" })
          : failure(decodeFailure("TwitterAPI.io ping 事件格式无效"));
      }
      case "fast_tweet": {
        const decoded = FastTweetEventSchema.safeParse(raw);
        if (!decoded.success) {
          return failure(decodeFailure("TwitterAPI.io fast_tweet 格式无效"));
        }
        const kind = mapFastActivityKind(decoded.data.tweet.type);
        if (kind === null) {
          return success({
            type: "ignored",
            warning: "TwitterAPI.io fast_tweet 类型不受支持，已忽略",
          });
        }
        return success({
          type: "activities",
          activities: [fastActivity(decoded.data.tweet, kind)],
        });
      }
      case "tweet": {
        const envelope = StandardTweetEnvelopeSchema.safeParse(raw);
        if (!envelope.success) {
          return failure(decodeFailure("TwitterAPI.io tweet 信封格式无效"));
        }
        if (envelope.data.rule_id !== undefined) {
          return success({ type: "ignored", warning: null });
        }
        const decoded = StandardTweetEventSchema.safeParse(raw);
        if (!decoded.success) {
          return failure(decodeFailure("TwitterAPI.io tweet 事件格式无效"));
        }
        const activities = normalizeActivityOrder(
          decoded.data.tweets.map(standardActivity),
        );
        return activities.length === 0
          ? success({ type: "ignored", warning: null })
          : success({ type: "activities", activities });
      }
      default:
        return success({ type: "ignored", warning: null });
    }
  } catch (error) {
    return failure(decodeFailure("TwitterAPI.io 流事件不是有效 JSON"));
  }
}

function parseBody<Output>(
  schema: z.ZodType<Output>,
  body: string,
): Result<Output, SourceError> {
  try {
    const decoded = schema.safeParse(JSON.parse(body));
    return decoded.success
      ? success(decoded.data)
      : failure(decodeFailure("TwitterAPI.io REST 响应格式无效"));
  } catch (error) {
    return failure(decodeFailure("TwitterAPI.io REST 响应不是有效 JSON"));
  }
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (value === null || value.trim().length === 0) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - Date.now());
}

/** HTTP 状态在正文解码前统一转换，避免错误页被误判为 API JSON。 */
function validateHttpResponse(
  response: TwitterStreamHttpResponse,
): Result<string, SourceError> {
  if (response.status >= 200 && response.status < 300) {
    return success(response.body);
  }
  if (response.status === 401 || response.status === 403) {
    return failure(
      sourceError("twitterapiio", "authentication", "TwitterAPI.io 认证失败"),
    );
  }
  if (response.status === 429) {
    return failure(
      sourceError(
        "twitterapiio",
        "rate-limit",
        "TwitterAPI.io 请求达到速率限制",
        retryAfterMilliseconds(response.retryAfter),
      ),
    );
  }
  const kind = response.status >= 500 ? "unavailable" : "transport";
  return failure(
    sourceError(
      "twitterapiio",
      kind,
      `TwitterAPI.io 返回 HTTP ${response.status}`,
      response.status >= 500
        ? retryAfterMilliseconds(response.retryAfter)
        : null,
    ),
  );
}

function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** monitor REST 的网络错误、429 和 5xx 最多额外尝试两次。 */
async function safelyRequest(
  operation: () => Promise<TwitterStreamHttpResponse>,
): Promise<Result<string, SourceError>> {
  let attempt = 0;
  while (attempt < MAX_MONITOR_REQUEST_ATTEMPTS) {
    try {
      const response = await operation();
      const validated = validateHttpResponse(response);
      if (validated.ok) return validated;

      attempt += 1;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= MAX_MONITOR_REQUEST_ATTEMPTS) {
        return validated;
      }
      const retryAfter = validated.error.retryAfterMilliseconds;
      const delay = retryAfter === null
        ? response.status === 429
          ? DEFAULT_RATE_LIMIT_DELAY_MILLISECONDS
          : 0
        : retryAfter;
      await wait(delay);
    } catch (error) {
      attempt += 1;
      if (attempt >= MAX_MONITOR_REQUEST_ATTEMPTS) {
        return failure(sourceError(
          "twitterapiio",
          "transport",
          "TwitterAPI.io 网络请求失败",
        ));
      }
    }
  }
  return failure(sourceError(
    "twitterapiio",
    "transport",
    "TwitterAPI.io 网络请求失败",
  ));
}

function invokeHandler(
  operation: () => Promise<void>,
  onError: (error: SourceError) => void,
): void {
  try {
    const pending = operation();
    void pending.catch(() => {
      onError(
        sourceError("twitterapiio", "transport", "流事件处理回调执行失败"),
      );
    });
  } catch (error) {
    onError(sourceError("twitterapiio", "transport", "流事件处理回调执行失败"));
  }
}

function dispatchFrame(text: string, handlers: StreamHandlers): void {
  const decoded = decodeTwitterStreamFrame(text);
  if (!decoded.ok) {
    handlers.onError(decoded.error);
    return;
  }
  if (decoded.value.type === "connected") {
    invokeHandler(handlers.onConnected, handlers.onError);
    return;
  }
  if (decoded.value.type === "activities") {
    const activities = decoded.value.activities;
    invokeHandler(
      () => handlers.onActivities(activities),
      handlers.onError,
    );
    return;
  }
  if (
    decoded.value.type === "ignored" &&
    decoded.value.warning !== null
  ) {
    handlers.onError(decodeFailure(decoded.value.warning));
  }
}

/**
 * 由可替换 transport 创建 Account Stream service。
 * 此层只负责一次 REST 操作或一次连接，不实现重连和远端列表对账调度。
 */
export function createTwitterAccountStreamServiceWithTransport(
  transport: TwitterStreamTransport,
  apiKey: string,
): AccountStreamService {
  const restHeaders: Headers = {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };

  const listMonitors = async (): Promise<
    Result<ReadonlyArray<MonitorEntry>, SourceError>
  > => {
    const response = await safelyRequest(() =>
      transport.getText(`${API_BASE_URL}${LIST_MONITORS_PATH}`, restHeaders),
    );
    if (!response.ok) return response;
    const decoded = parseBody(MonitorListResponseSchema, response.value);
    if (!decoded.ok) return decoded;
    if (decoded.value.status === "error") {
      return failure(
        sourceError("twitterapiio", "unavailable", "远端监控列表读取失败"),
      );
    }
    return success(
      decoded.value.data.map((entry) => ({
        idForUser: entry.id_for_user,
        handle: entry.x_user_screen_name.toLowerCase(),
        status: mapMonitorStatus(entry.monitor_tweet_config_status),
      })),
    );
  };

  const mutateMonitor = async (
    path: string,
    body: RequestBody,
  ): Promise<Result<void, SourceError>> => {
    const response = await safelyRequest(() =>
      transport.postText(`${API_BASE_URL}${path}`, restHeaders, body),
    );
    if (!response.ok) return response;
    const decoded = parseBody(HttpMutationResponseSchema, response.value);
    if (!decoded.ok) return decoded;
    return decoded.value.status === "success"
      ? success(undefined)
      : failure(
          sourceError("twitterapiio", "unavailable", "远端监控列表修改失败"),
        );
  };

  const addMonitor = async (
    handle: string,
  ): Promise<Result<void, SourceError>> => {
    const normalized = normalizeHandle(handle);
    if (!normalized.ok) {
      return failure(decodeFailure("待监控的 X 用户名格式无效"));
    }
    return mutateMonitor(ADD_MONITOR_PATH, {
      x_user_name: normalized.value,
    });
  };

  const removeMonitor = async (
    idForUser: string,
  ): Promise<Result<void, SourceError>> => {
    if (idForUser.trim().length === 0) {
      return failure(decodeFailure("远端监控记录 ID 不能为空"));
    }
    return mutateMonitor(REMOVE_MONITOR_PATH, { id_for_user: idForUser });
  };

  const connect = (
    handlers: StreamHandlers,
  ): Result<StreamConnection, SourceError> => {
    try {
      const socket = transport.openSocket(
        STREAM_URL,
        { "x-api-key": apiKey },
        {
          onText: (text) => dispatchFrame(text, handlers),
          onError: () => {
            handlers.onError(
              sourceError("twitterapiio", "transport", "Account Stream 连接错误"),
            );
          },
          onClosed: handlers.onClosed,
        },
      );
      return success({
        close: (code, reason) => socket.close(code, reason),
      });
    } catch (error) {
      return failure(
        sourceError("twitterapiio", "transport", "Account Stream 连接创建失败"),
      );
    }
  };

  return { listMonitors, addMonitor, removeMonitor, connect };
}

/** 把 Koishi http/http.ws 适配为可离线替换的最小 transport。 */
function createKoishiTransport(ctx: Context): TwitterStreamTransport {
  return {
    getText: async (url, headers) => {
      const response = await ctx.http(url, {
        method: "GET",
        headers: { ...headers },
        responseType: "text",
        validateStatus: () => true,
      });
      return {
        status: response.status,
        body: response.data,
        retryAfter: response.headers.get("retry-after"),
      };
    },
    postText: async (url, headers, body) => {
      const response = await ctx.http(url, {
        method: "POST",
        headers: { ...headers },
        data: body,
        responseType: "text",
        validateStatus: () => true,
      });
      return {
        status: response.status,
        body: response.data,
        retryAfter: response.headers.get("retry-after"),
      };
    },
    openSocket: (url, headers, handlers) => {
      const socket = ctx.http.ws(url, { headers: { ...headers } });

      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        handlers.onText(event.data);
      });
      socket.addEventListener("error", () => {
        handlers.onError();
      });
      socket.addEventListener("close", (event) => {
        handlers.onClosed(event.code, event.reason);
      });

      return {
        close: (code, reason) => socket.close(code, reason),
      };
    },
  };
}

/** Runtime 使用的生产工厂：所有 HTTP 与 WebSocket 均通过 Koishi http 服务。 */
export function createTwitterAccountStreamService(
  ctx: Context,
  apiKey: string,
): AccountStreamService {
  return createTwitterAccountStreamServiceWithTransport(
    createKoishiTransport(ctx),
    apiKey,
  );
}
