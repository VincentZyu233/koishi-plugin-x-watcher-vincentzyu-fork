import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { Context } from "koishi";
import { RemoteMonitorError, type SourceError } from "../../../domain/errors";
import { parseXHandle, parseXUserId } from "../../../domain/identifiers";
import type { RemoteMonitorEntry } from "../../../ports/source";
import { decodeTwitterApi } from "./decoder";
import { requestTwitterApiJson } from "./http-client";
import { MonitorEntrySchema, MonitorListResponseSchema } from "./schema";

/** 将数据源错误降格成远端监控错误。 */
export const toRemoteMonitorError = (
  operation: "add" | "remove" | "list",
) => (error: SourceError) =>
  new RemoteMonitorError({ operation, message: error.message });

/** 将单个宽松远端条目转换为受控监控条目。 */
const mapRemoteMonitorEntry = (
  entry: typeof MonitorEntrySchema.Type,
): Option.Option<RemoteMonitorEntry> => {
  const rawHandle = entry.x_user_screen_name === undefined
    ? entry.x_user_name
    : entry.x_user_screen_name;
  if (entry.id_for_user === undefined || rawHandle === undefined) return Option.none();
  const handle = parseXHandle(rawHandle);
  if (Either.isLeft(handle)) return Option.none();
  const parsedUserId = typeof entry.x_user_id === "string"
    ? parseXUserId(entry.x_user_id)
    : null;
  const userId = parsedUserId !== null && Either.isRight(parsedUserId)
    ? Option.some(parsedUserId.right)
    : Option.none();
  return Option.some({ remoteId: entry.id_for_user, userId, handle: handle.right });
};

/** 读取并规范化 Account Stream 远端监控列表。 */
export const listTwitterApiRemoteMonitors = (
  ctx: Context,
  apiKey: string,
): Effect.Effect<ReadonlyArray<RemoteMonitorEntry>, RemoteMonitorError> =>
  requestTwitterApiJson(ctx, apiKey, "GET", "/oapi/x_user_stream/get_user_to_monitor_tweet")
    .pipe(
      Effect.mapError(toRemoteMonitorError("list")),
      Effect.flatMap((input) =>
        decodeTwitterApi(MonitorListResponseSchema, input).pipe(
          Effect.mapError(
            (error) => new RemoteMonitorError({ operation: "list", message: error.message }),
          ),
        ),
      ),
      Effect.flatMap((response) => {
        if (response.status === "error") {
          return Effect.fail(
            new RemoteMonitorError({
              operation: "list",
              message: response.msg || "列表请求失败",
            }),
          );
        }
        return Effect.succeed(response.data.flatMap((entry) => {
          const mapped = mapRemoteMonitorEntry(entry);
          return Option.isSome(mapped) ? [mapped.value] : [];
        }));
      }),
    );
