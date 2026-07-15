import * as Effect from "effect/Effect";
import type { Context } from "koishi";
import { RemoteMonitorError, type SourceError } from "../../../domain/errors";
import type { XHandle } from "../../../domain/identifiers";
import type { RemoteMonitorService } from "../../../ports/source";
import { decodeTwitterApi } from "./decoder";
import { requestTwitterApiJson } from "./http-client";
import {
  listTwitterApiRemoteMonitors,
  toRemoteMonitorError,
} from "./remote-monitor-list";
import { MonitorOperationResponseSchema } from "./schema";

/** 只把供应商明确声明的 success 操作响应视为成功。 */
const requireOperationSuccess = (operation: "add" | "remove") => (
  response: typeof MonitorOperationResponseSchema.Type,
) => response.status === "success"
  ? Effect.succeed(response)
  : Effect.fail(new RemoteMonitorError({
      operation,
      message: response.msg,
      disposition: "retry",
    }));

/** 将 add 提交边界错误区分为可安全重试与结果不确定。 */
const toAddSubmissionError = (error: SourceError) =>
  new RemoteMonitorError({
    operation: "add",
    message: error.message,
    disposition: error._tag === "AuthenticationError" || error._tag === "RateLimitError"
      ? "retry"
      : "manual",
  });

/** 创建必须人工协调且禁止自动接管的 add 错误。 */
const manualAddError = (
  message: string,
  remoteIds: ReadonlyArray<string>,
) => new RemoteMonitorError({
  operation: "add",
  message,
  disposition: "manual",
  candidateRemoteIds: remoteIds,
});

/** 添加远端监控并且只接管本次请求新产生的删除 ID。 */
const addRemoteMonitor = (ctx: Context, apiKey: string) => (
  handle: XHandle,
) =>
  Effect.gen(function* () {
    const before = yield* listTwitterApiRemoteMonitors(ctx, apiKey);
    const preexisting = before.filter((entry) => entry.handle === handle);
    if (preexisting.length > 0) {
      return yield* Effect.fail(
        manualAddError(
          "远端已存在同名监控但无法确认归属；请使用专用 API key 或手工清理",
          preexisting.map((entry) => entry.remoteId),
        ),
      );
    }
    const submission = yield* Effect.either(
      requestTwitterApiJson(
        ctx,
        apiKey,
        "POST",
        "/oapi/x_user_stream/add_user_to_monitor_tweet",
        { data: { x_user_name: handle } },
      ).pipe(
        Effect.mapError(toAddSubmissionError),
        Effect.flatMap((input) =>
          decodeTwitterApi(MonitorOperationResponseSchema, input).pipe(
            Effect.mapError(
              (error) => manualAddError(error.message, []),
            ),
            Effect.flatMap(requireOperationSuccess("add")),
          ),
        ),
      ),
    );
    if (submission._tag === "Left" && submission.left.disposition !== "manual") {
      return yield* Effect.fail(submission.left);
    }
    const afterResult = yield* Effect.either(listTwitterApiRemoteMonitors(ctx, apiKey));
    if (afterResult._tag === "Left") {
      return yield* Effect.fail(
        submission._tag === "Left"
          ? submission.left
          : manualAddError("add 已明确成功，但远端列表核验失败，禁止自动重试", []),
      );
    }
    const candidates = afterResult.right.filter((entry) => entry.handle === handle);
    const candidate = candidates[0];
    if (submission._tag === "Right" && candidates.length === 1 && candidate !== undefined) {
      return candidate;
    }
    if (submission._tag === "Left") {
      return yield* Effect.fail(manualAddError(
        `add 提交结果不确定，禁止接管随后出现的同名条目：${submission.left.message}`,
        candidates.map((entry) => entry.remoteId),
      ));
    }
    return yield* Effect.fail(
      manualAddError(
        candidates.length === 0
          ? `add 已明确成功但远端列表尚未出现新增账号：${submission.right.msg}`
          : "add 后出现多个同名条目，无法证明具体归属",
        candidates.map((entry) => entry.remoteId),
      ),
    );
  });

/** 删除远端监控；错误响应时通过列表确认是否已经不存在。 */
const removeRemoteMonitor = (ctx: Context, apiKey: string) => (
  remoteId: string,
) =>
  Effect.gen(function* () {
    const removal = yield* Effect.either(
      requestTwitterApiJson(
        ctx,
        apiKey,
        "POST",
        "/oapi/x_user_stream/remove_user_to_monitor_tweet",
        { data: { id_for_user: remoteId } },
      ).pipe(
        Effect.mapError(toRemoteMonitorError("remove")),
        Effect.flatMap((input) =>
          decodeTwitterApi(MonitorOperationResponseSchema, input).pipe(
            Effect.mapError(
              (error) => new RemoteMonitorError({ operation: "remove", message: error.message }),
            ),
            Effect.flatMap(requireOperationSuccess("remove")),
          ),
        ),
      ),
    );
    const entries = yield* listTwitterApiRemoteMonitors(ctx, apiKey);
    if (!entries.some((entry) => entry.remoteId === remoteId)) return;
    if (removal._tag === "Left") return yield* Effect.fail(removal.left);
    return yield* Effect.fail(
      new RemoteMonitorError({
        operation: "remove",
        message: `删除响应成功但远端列表仍存在该监控：${removal.right.msg}`,
      }),
    );
  });

/** 创建 TwitterAPI.io Account Stream 远端控制服务。 */
export const makeTwitterApiRemoteMonitor = (
  ctx: Context,
  apiKey: string,
): RemoteMonitorService => ({
  /** 添加由当前插件明确创建的远端监控。 */
  add: addRemoteMonitor(ctx, apiKey),
  /** 删除插件已持久化持有的远端监控。 */
  remove: removeRemoteMonitor(ctx, apiKey),
  /** 列出 API key 当前可见的全部远端监控。 */
  list: () => listTwitterApiRemoteMonitors(ctx, apiKey),
});
