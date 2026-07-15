import type {} from "@koishijs/plugin-http";
import * as Effect from "effect/Effect";
import type { Context } from "koishi";
import {
  AuthenticationError,
  RateLimitError,
  TransportError,
  type SourceError,
} from "../../../domain/errors";

/** TwitterAPI.io API 根地址。 */
const API_BASE = "https://api.twitterapi.io";

/** TwitterAPI.io HTTP 请求的可选参数。 */
export interface TwitterApiRequestOptions {
  readonly params?: Readonly<Record<string, string | boolean>>;
  readonly data?: Readonly<Record<string, string>>;
}

/** 将 Koishi HTTP 异常转换为传输错误。 */
const mapHttpException = (error: unknown): SourceError =>
  new TransportError({
    provider: "twitterapiio",
    message: error instanceof Error ? error.message : String(error),
  });

/** 将 TwitterAPI.io HTTP 响应转换为数据或显式数据源错误。 */
const readResponse = (response: {
  readonly status: number;
  readonly headers: Headers;
  readonly data: object;
}): Effect.Effect<object, SourceError> => {
  if (response.status === 401 || response.status === 403) {
    return Effect.fail(
      new AuthenticationError({
        provider: "twitterapiio",
        message: `TwitterAPI.io 认证失败（HTTP ${response.status}）`,
      }),
    );
  }
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const seconds = header === null ? 60 : Number(header);
    return Effect.fail(
      new RateLimitError({
        provider: "twitterapiio",
        retryAfterMillis: Number.isFinite(seconds) ? seconds * 1_000 : 60_000,
        message: "TwitterAPI.io 请求受到限流",
      }),
    );
  }
  if (response.status >= 400) {
    return Effect.fail(
      new TransportError({
        provider: "twitterapiio",
        message: `TwitterAPI.io 返回 HTTP ${response.status}`,
      }),
    );
  }
  return Effect.succeed(response.data);
};

/** 执行 TwitterAPI.io JSON 请求并统一处理传输与 HTTP 状态。 */
export const requestTwitterApiJson = (
  ctx: Context,
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  options: TwitterApiRequestOptions = {},
): Effect.Effect<object, SourceError> =>
  Effect.tryPromise({
    /** 通过 Koishi HTTP 服务执行供应商请求。 */
    try: () =>
      ctx.http<object>(method, `${API_BASE}${path}`, {
        headers: { "x-api-key": apiKey },
        timeout: 30_000,
        /** 保留全部状态码并在领域边界统一分类。 */
        validateStatus: () => true,
        ...(options.params === undefined ? {} : { params: options.params }),
        ...(options.data === undefined ? {} : { data: options.data }),
      }),
    /** 将网络异常转换为显式数据源错误。 */
    catch: mapHttpException,
  }).pipe(Effect.flatMap(readResponse));
