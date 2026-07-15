import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Context } from "koishi";
import { sortActivitiesOldestFirst, type XActivity } from "../../../domain/activity";
import { TransportError, type SourceError } from "../../../domain/errors";
import {
  compareActivityId,
  isActivityAfter,
  type ActivityId,
  type XUserId,
} from "../../../domain/identifiers";
import type { RecoveryBatch } from "../../../ports/source";
import { decodeTwitterApi } from "./decoder";
import { requestTwitterApiJson } from "./http-client";
import { LastTweetsResponseSchema } from "./schema";
import { decodeTwitterTweetBatch } from "./tweet-batch";

/** 解开最近推文响应的可选 data 包装。 */
const unwrapTimelineResponse = (response: typeof LastTweetsResponseSchema.Type) =>
  "data" in response ? response.data : response;

/** 读取一页 TwitterAPI.io 最近动态。 */
const fetchTimelinePage = (
  ctx: Context,
  apiKey: string,
  userId: XUserId,
  cursor: string,
) =>
  requestTwitterApiJson(ctx, apiKey, "GET", "/twitter/user/last_tweets", {
    params: { userId, includeReplies: true, cursor },
  }).pipe(
    Effect.flatMap((input) => decodeTwitterApi(LastTweetsResponseSchema, input)),
    Effect.flatMap((decoded) => {
      const body = unwrapTimelineResponse(decoded);
      if (body.status === "error") {
        return Effect.fail(
          new TransportError({
            provider: "twitterapiio",
            message: body.message === undefined ? "最近动态请求失败" : body.message,
          }),
        );
      }
      return Effect.succeed(body);
    }),
  );

/** 从已观察 ID 中选择最大 Snowflake 水位。 */
const selectNewestId = (
  ids: ReadonlyArray<ActivityId>,
): Option.Option<ActivityId> => {
  const sorted = [...ids].sort(compareActivityId);
  return Option.fromNullable(sorted[sorted.length - 1]);
};

/** 创建 TwitterAPI.io 首页最新 Tweet ID 查询能力。 */
export const makeTwitterApiFetchLatestId = (ctx: Context, apiKey: string) => (
  userId: XUserId,
): Effect.Effect<Option.Option<ActivityId>, SourceError> =>
  fetchTimelinePage(ctx, apiKey, userId, "").pipe(
    Effect.flatMap((page) =>
      decodeTwitterTweetBatch(page.tweets, "最新水位首页").pipe(
        Effect.map((batch) => selectNewestId(batch.observedIds)),
      ),
    ),
  );

/** 创建 TwitterAPI.io 跨页恢复扫描能力。 */
export const makeTwitterApiFetchAfter = (ctx: Context, apiKey: string) => (
  userId: XUserId,
  watermark: Option.Option<ActivityId>,
): Effect.Effect<RecoveryBatch, SourceError> =>
  Effect.gen(function* () {
    const collected = new Map<string, XActivity>();
    let newestObserved: ActivityId | null = null;
    let cursor = "";
    let finished = false;
    const visitedCursors = new Set<string>();
    while (!finished && collected.size < 21) {
      if (visitedCursors.has(cursor)) {
        yield* Effect.logWarning("TwitterAPI.io 恢复分页游标重复，已停止本轮扫描");
        break;
      }
      visitedCursors.add(cursor);
      const page = yield* fetchTimelinePage(ctx, apiKey, userId, cursor);
      const decoded = yield* decodeTwitterTweetBatch(page.tweets, "恢复页");
      const activities = decoded.decoded.map((item) => item.activity);
      const fresh = activities.filter((activity) =>
        Option.isNone(watermark) ? true : isActivityAfter(activity.id, watermark.value),
      );
      const freshObservedIds = decoded.observedIds.filter((id) =>
        Option.isNone(watermark) ? true : isActivityAfter(id, watermark.value),
      );
      for (const observedId of freshObservedIds) {
        if (
          newestObserved === null ||
          compareActivityId(observedId, newestObserved) > 0
        ) {
          newestObserved = observedId;
        }
      }
      for (const activity of fresh) {
        if (!collected.has(activity.id) && collected.size < 21) {
          collected.set(activity.id, activity);
        }
      }
      const crossed = Option.isSome(watermark)
        ? decoded.observedIds.some(
            (id) => compareActivityId(id, watermark.value) <= 0,
          )
        : false;
      const next = page.next_cursor === undefined ? "" : page.next_cursor;
      const repeated = next.length > 0 && visitedCursors.has(next);
      if (repeated) {
        yield* Effect.logWarning("TwitterAPI.io 恢复分页返回重复游标，已停止本轮扫描");
      }
      finished =
        crossed || page.has_next_page !== true || next.length === 0 || repeated;
      cursor = next;
    }
    const activities = sortActivitiesOldestFirst([...collected.values()]);
    const boundary = activities.length > 20
      ? activities[activities.length - 21]
      : undefined;
    return {
      activities: activities.slice(-20),
      newestId: Option.fromNullable(newestObserved),
      overflow: activities.length > 20,
      overflowBoundary: boundary === undefined
        ? null
        : {
            id: boundary.id,
            createdAtEpochMillis: boundary.createdAtEpochMillis,
          },
    };
  });
