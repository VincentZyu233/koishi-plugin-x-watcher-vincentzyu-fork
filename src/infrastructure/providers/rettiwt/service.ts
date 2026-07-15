import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import {
  deduplicateActivities,
  sortActivitiesOldestFirst,
} from "../../../domain/activity";
import {
  DecodeError,
  type SourceError,
  UserUnavailableError,
} from "../../../domain/errors";
import {
  compareActivityId,
  parseXHandle,
  parseXUserId,
} from "../../../domain/identifiers";
import type { XDataSourceService } from "../../../ports/source";
import { makeRettiwtClientPool, withHealthyClient } from "./client-pool";
import {
  extractRettiwtActivityId,
  scanRettiwtTimeline,
} from "./scanner";

/** 创建 Rettiwt 数据源服务及其隔离的密钥池。 */
export const makeRettiwtService = (
  apiKeys: ReadonlyArray<string>,
): Effect.Effect<XDataSourceService, SourceError> =>
  Effect.gen(function* () {
    const pool = yield* makeRettiwtClientPool(apiKeys);
    return {
      /** 通过 Rettiwt 解析用户资料。 */
      resolveUser: (handle) =>
        Effect.gen(function* () {
          const user = yield* withHealthyClient(pool, (client) =>
            client.user.details(handle),
          );
          if (user === undefined) {
            return yield* Effect.fail(
              new UserUnavailableError({
                handle,
                message: "Rettiwt 未返回该用户资料",
              }),
            );
          }
          const id = parseXUserId(user.id);
          const parsedHandle = parseXHandle(user.userName);
          if (Either.isLeft(id) || Either.isLeft(parsedHandle)) {
            return yield* Effect.fail(
              new DecodeError({ provider: "rettiwt", message: "用户资料字段无效" }),
            );
          }
          return { id: id.right, handle: parsedHandle.right, displayName: user.fullName };
        }),
      /** 读取普通时间线与回复时间线中的最新 ID。 */
      fetchLatestId: (userId) =>
        Effect.gen(function* () {
          const [timeline, replies] = yield* Effect.all([
            withHealthyClient(pool, (client) => client.user.timeline(userId, 1)),
            withHealthyClient(pool, (client) => client.user.replies(userId, 1)),
          ], { concurrency: "unbounded" });
          const ids = [...timeline.list, ...replies.list]
            .flatMap((tweet) => {
              const id = extractRettiwtActivityId(tweet);
              return Option.isSome(id) ? [id.value] : [];
            })
            .sort(compareActivityId);
          return Option.fromNullable(ids[ids.length - 1]);
        }),
      /** 分页合并普通时间线和回复时间线。 */
      fetchAfter: (userId, cursor) =>
        Effect.gen(function* () {
          const [timeline, replies] = yield* Effect.all([
            scanRettiwtTimeline(pool, userId, cursor, "timeline"),
            scanRettiwtTimeline(pool, userId, cursor, "replies"),
          ], { concurrency: "unbounded" });
          const activities = sortActivitiesOldestFirst(
            deduplicateActivities([
              ...timeline.activities,
              ...replies.activities,
            ]),
          );
          const observedIds = [
            ...timeline.observedIds,
            ...replies.observedIds,
          ]
            .filter((id) =>
              Option.isNone(cursor) ? true : compareActivityId(id, cursor.value) > 0,
            )
            .sort(compareActivityId);
          const newestObserved = observedIds[observedIds.length - 1];
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
        }),
      /** Rettiwt 没有原生实时事件，拒绝补全调用。 */
      hydrate: () =>
        Effect.fail(
          new DecodeError({
            provider: "rettiwt",
            message: "Rettiwt 轮询模式不支持实时事件补全",
          }),
        ),
    };
  });
