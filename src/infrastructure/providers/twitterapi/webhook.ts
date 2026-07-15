import type {} from "@koishijs/plugin-server";
import { createHash, timingSafeEqual } from "node:crypto";
import * as Effect from "effect/Effect";
import type { Context } from "koishi";
import type { RawEventSink } from "../../../ports/source";
import { decodeRealtimeObject } from "./realtime";

/** TwitterAPI.io Webhook 固定路由。 */
export const TWITTER_API_WEBHOOK_PATH = "/x-watcher/twitterapiio/webhook";

/** 使用恒定时间比较回调令牌。 */
const tokenMatches = (expected: string, actual: string): boolean => {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
};

/** 注册持久化完成后才返回 204 的实验性 Account Stream Webhook。 */
export const registerTwitterApiWebhook = (
  ctx: Context,
  callbackToken: string,
  sink: RawEventSink,
): void => {
  ctx.server.post(TWITTER_API_WEBHOOK_PATH, async (koa) => {
    const tokenValue = koa.query.token;
    const actualToken = typeof tokenValue === "string" ? tokenValue : "";
    if (!tokenMatches(callbackToken, actualToken)) {
      koa.status = 401;
      return;
    }
    const request = koa.request as typeof koa.request & { readonly body: unknown };
    const body = request.body;
    const outcome = await Effect.runPromise(
      decodeRealtimeObject(body).pipe(
        Effect.flatMap((events) => Effect.forEach(events, sink, { discard: true })),
        Effect.either,
      ),
    );
    if (outcome._tag === "Right") {
      koa.status = 204;
      return;
    }
    ctx.logger("x-watcher").warn("Webhook 事件处理失败：%s", outcome.left.message);
    koa.status = outcome.left._tag === "DecodeError" ? 400 : 500;
  });
};
