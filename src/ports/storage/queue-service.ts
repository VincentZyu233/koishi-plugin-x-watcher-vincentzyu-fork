import type * as Effect from "effect/Effect";
import type { XActivity } from "../../domain/activity";
import type { PersistenceError } from "../../domain/errors";
import type { RawRealtimeEvent } from "../source";
import type {
  ClaimedControl,
  ClaimedDelivery,
  StoredRawEvent,
} from "./models";

/** 原始事件、投递与远端控制队列所需的持久化能力。 */
export interface XWatcherQueueStoreService {
  /** 幂等持久化实时原始事件后才允许入口确认。 */
  readonly persistRawEvent: (
    event: RawRealtimeEvent,
  ) => Effect.Effect<void, PersistenceError>;

  /** 领取一个等待补全或路由的原始事件。 */
  readonly claimRawEvent: (
    now: Date,
  ) => Effect.Effect<StoredRawEvent | null, PersistenceError>;

  /** 原子路由补全后的实时事件并完成原始任务。 */
  readonly completeRawEvent: (
    rawEventId: number,
    claimToken: string,
    activity: XActivity,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 延后补全失败的原始事件。 */
  readonly retryRawEvent: (
    rawEventId: number,
    claimToken: string,
    availableAt: Date,
    message: string,
  ) => Effect.Effect<void, PersistenceError>;

  /** 按每订阅头阻塞顺序领取一个投递任务。 */
  readonly claimDelivery: (
    now: Date,
    leaseUntil: Date,
  ) => Effect.Effect<ClaimedDelivery | null, PersistenceError>;

  /** 确认投递任务完成。 */
  readonly completeDelivery: (
    deliveryId: number,
    claimToken: string,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 更新投递降级阶段或分片进度。 */
  readonly updateDeliveryProgress: (
    deliveryId: number,
    claimToken: string,
    stage: "mixed" | "split" | "link",
    partIndex: number,
    availableAt: Date,
    message: string | null,
  ) => Effect.Effect<void, PersistenceError>;

  /** 领取一个远端监控控制任务。 */
  readonly claimControl: (
    now: Date,
    leaseUntil: Date,
  ) => Effect.Effect<ClaimedControl | null, PersistenceError>;

  /** 确认远端监控控制任务完成。 */
  readonly completeControl: (
    controlId: number,
    claimToken: string,
    remoteId: string | null,
    reconcileAt: Date | null,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 延后远端监控控制任务并记录可见错误。 */
  readonly retryControl: (
    controlId: number,
    claimToken: string,
    availableAt: Date,
    message: string,
  ) => Effect.Effect<void, PersistenceError>;

  /** 终结无法证明归属的 add 并要求人工协调。 */
  readonly coordinateControlAdd: (
    controlId: number,
    claimToken: string,
    candidateRemoteIds: ReadonlyArray<string>,
    message: string,
    now: Date,
  ) => Effect.Effect<void, PersistenceError>;

  /** 清理超过七天的终态审计记录。 */
  readonly cleanupTerminalRecords: (
    before: Date,
  ) => Effect.Effect<void, PersistenceError>;
}
