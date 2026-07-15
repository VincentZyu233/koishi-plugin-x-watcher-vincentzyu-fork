import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { RuntimeCleanupFailure } from "../../src/runtime/managed";
import {
  disposeRuntimeOnFailure,
  stopManagedResources,
  stopManagedRuntime,
} from "../../src/runtime/managed";

/** 创建收集清理失败的测试报告器。 */
const makeReporter = (failures: Array<RuntimeCleanupFailure>) =>
  (failure: RuntimeCleanupFailure): void => {
    failures.push(failure);
  };

describe("ManagedRuntime 生命周期", () => {
  it("中断同步抛错后仍释放运行时并保留中断原因", async () => {
    const interruptFailure = new Error("interrupt failed");
    let disposeCalls = 0;
    const failures: Array<RuntimeCleanupFailure> = [];
    const stopping = stopManagedResources(
      () => {
        throw interruptFailure;
      },
      { dispose: () => {
        disposeCalls += 1;
        return Promise.resolve();
      } },
      makeReporter(failures),
    );
    await expect(stopping).rejects.toBe(interruptFailure);
    expect(disposeCalls).toBe(1);
    expect(failures).toEqual([{ stage: "interrupt", cause: interruptFailure }]);
  });

  it("fiber 终结器 defect 后仍释放运行时", async () => {
    const finalizerFailure = new Error("finalizer failed");
    let disposeCalls = 0;
    const failures: Array<RuntimeCleanupFailure> = [];
    const worker = Effect.runFork(
      Effect.never.pipe(Effect.ensuring(Effect.die(finalizerFailure))),
    );
    const stopping = stopManagedRuntime(
      worker,
      { dispose: () => {
        disposeCalls += 1;
        return Promise.resolve();
      } },
      makeReporter(failures),
    );
    await expect(stopping).rejects.toBe(finalizerFailure);
    expect(disposeCalls).toBe(1);
    expect(failures).toEqual([{ stage: "interrupt", cause: finalizerFailure }]);
  });

  it("启动和释放同时失败时返回原始启动原因并记录释放失败", async () => {
    const startupFailure = new Error("startup failed");
    const disposeFailure = new Error("dispose failed");
    const failures: Array<RuntimeCleanupFailure> = [];
    const starting = disposeRuntimeOnFailure(
      { dispose: () => Promise.reject(disposeFailure) },
      Promise.reject(startupFailure),
      makeReporter(failures),
    );
    await expect(starting).rejects.toBe(startupFailure);
    expect(failures).toEqual([{ stage: "dispose", cause: disposeFailure }]);
  });

  it("正常中断但释放失败时返回并记录释放原因", async () => {
    const disposeFailure = new Error("dispose failed");
    const failures: Array<RuntimeCleanupFailure> = [];
    const stopping = stopManagedResources(
      () => Promise.resolve(),
      { dispose: () => Promise.reject(disposeFailure) },
      makeReporter(failures),
    );
    await expect(stopping).rejects.toBe(disposeFailure);
    expect(failures).toEqual([{ stage: "dispose", cause: disposeFailure }]);
  });
});
