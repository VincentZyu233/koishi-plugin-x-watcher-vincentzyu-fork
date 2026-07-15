import * as Cause from "effect/Cause";
import * as Chunk from "effect/Chunk";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import type { Context } from "koishi";

/** ManagedRuntime 生命周期释放所需的最小能力。 */
export interface ManagedRuntimeDisposer {
  /** 释放运行时持有的全部资源。 */
  readonly dispose: () => Promise<void>;
}

/** 标识托管运行时清理失败发生的阶段。 */
export type RuntimeCleanupStage = "interrupt" | "dispose";

/** 描述一个已被收敛或重新抛出的清理失败。 */
export interface RuntimeCleanupFailure {
  readonly stage: RuntimeCleanupStage;
  readonly cause: unknown;
}

/** 接收托管运行时清理失败，且不得改变原始失败语义。 */
export type RuntimeCleanupReporter = (failure: RuntimeCleanupFailure) => void;

/** 表示异步清理动作成功。 */
interface PromiseSucceeded {
  readonly _tag: "Succeeded";
}

/** 表示异步清理动作失败并保留原始原因。 */
interface PromiseFailed {
  readonly _tag: "Failed";
  readonly cause: unknown;
}

/** 表示异步清理动作的显式结算结果。 */
type PromiseSettlement = PromiseSucceeded | PromiseFailed;

/** 将同步抛错或 Promise 拒绝统一结算为不可拒绝的结果值。 */
const settleAction = (
  action: () => Promise<void>,
): Promise<PromiseSettlement> =>
  Promise.resolve().then(action).then(
    () => ({ _tag: "Succeeded" as const }),
    (cause) => ({ _tag: "Failed" as const, cause }),
  );

/** 安全上报清理失败，避免日志适配器异常覆盖原始原因。 */
const safelyReport = (
  reporter: RuntimeCleanupReporter,
  failure: RuntimeCleanupFailure,
): void => {
  Effect.runSync(
    Effect.sync(() => reporter(failure)).pipe(
      Effect.catchAllCause(() => Effect.void),
    ),
  );
};

/** 将未知失败原因转换为运行时日志文本。 */
const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 创建写入 Koishi 日志的托管运行时清理失败报告器。 */
export const makeRuntimeCleanupReporter = (
  ctx: Context,
): RuntimeCleanupReporter => (failure) => {
  ctx.logger("x-watcher").error(
    "托管运行时%s失败：%s",
    failure.stage === "interrupt" ? "中断后台任务" : "释放 Layer",
    describeCause(failure.cause),
  );
};

/** 中断 Effect fiber，并将终结器 defect 转换为 Promise 拒绝。 */
const interruptWorker = <A, E>(
  worker: Fiber.RuntimeFiber<A, E>,
): Promise<void> =>
  Effect.runPromise(Fiber.interrupt(worker)).then((exit) => {
    if (Exit.isSuccess(exit)) return;
    const defect = Chunk.head(Cause.defects(exit.cause));
    if (Option.isSome(defect)) return Promise.reject(defect.value);
  });

/** 无论中断是否失败都释放运行时，并按发生顺序保留首个失败。 */
export const stopManagedResources = (
  interrupt: () => Promise<void>,
  runtime: ManagedRuntimeDisposer,
  reporter: RuntimeCleanupReporter,
): Promise<void> =>
  settleAction(interrupt).then((interruptResult) =>
    settleAction(() => runtime.dispose()).then((disposeResult) => {
      if (interruptResult._tag === "Failed") {
        safelyReport(reporter, {
          stage: "interrupt",
          cause: interruptResult.cause,
        });
      }
      if (disposeResult._tag === "Failed") {
        safelyReport(reporter, { stage: "dispose", cause: disposeResult.cause });
      }
      if (interruptResult._tag === "Failed") {
        return Promise.reject(interruptResult.cause);
      }
      if (disposeResult._tag === "Failed") return Promise.reject(disposeResult.cause);
    }),
  );

/** 中断后台 fiber 并释放 ManagedRuntime 中的全部 Layer 资源。 */
export const stopManagedRuntime = <A, E>(
  worker: Fiber.RuntimeFiber<A, E>,
  runtime: ManagedRuntimeDisposer,
  reporter: RuntimeCleanupReporter,
): Promise<void> =>
  stopManagedResources(() => interruptWorker(worker), runtime, reporter);

/** 启动失败时总是释放 Layer，并保留原始启动拒绝原因。 */
export const disposeRuntimeOnFailure = <A>(
  runtime: ManagedRuntimeDisposer,
  starting: Promise<A>,
  reporter: RuntimeCleanupReporter,
): Promise<A> =>
  starting.catch((startupCause) =>
    settleAction(() => runtime.dispose()).then((disposeResult) => {
      if (disposeResult._tag === "Failed") {
        safelyReport(reporter, { stage: "dispose", cause: disposeResult.cause });
      }
      return Promise.reject(startupCause);
    }),
  );
