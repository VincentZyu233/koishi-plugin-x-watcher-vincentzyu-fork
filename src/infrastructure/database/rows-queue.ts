import type { MessagePlan } from "../../domain/message";
import type { ActivityId, XUserId } from "../../domain/identifiers";

/** 队列任务的公共运行状态。 */
export type QueueStatus = "pending" | "processing" | "completed";

/** 原始实时事件表持久化行。 */
export interface RawEventRow {
  readonly id: number;
  readonly eventKey: string;
  readonly accountId: number | null;
  readonly accountXUserId: XUserId | null;
  readonly activityId: ActivityId | null;
  readonly provider: "twitterapiio";
  readonly reduced: boolean;
  readonly payloadJson: string;
  readonly receivedAt: Date;
  readonly status: QueueStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly leaseUntil: Date | null;
  readonly claimToken: string | null;
  readonly lastError: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

/** 投递任务的持久化状态。 */
export type DeliveryStatus = "pending" | "processing" | "sent" | "cancelled";

/** 消息投递表持久化行。 */
export interface DeliveryRow {
  readonly id: number;
  readonly subscriptionId: number;
  readonly activityRecordId: number | null;
  readonly dedupeKey: string;
  readonly plan: MessagePlan;
  readonly status: DeliveryStatus;
  readonly stage: "mixed" | "split" | "link";
  readonly partIndex: number;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly leaseUntil: Date | null;
  readonly claimToken: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

/** 远端控制任务的持久化状态。 */
export type ControlStatus = "pending" | "processing" | "completed" | "cancelled";

/** 远端监控控制 outbox 持久化行。 */
export interface ControlRow {
  readonly id: number;
  readonly accountId: number;
  readonly operation: "add" | "remove";
  readonly keyFingerprint: string | null;
  readonly remoteId: string | null;
  readonly status: ControlStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly leaseUntil: Date | null;
  readonly claimToken: string | null;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

declare module "koishi" {
  interface Tables {
    x_watcher_raw_event: RawEventRow;
    x_watcher_delivery: DeliveryRow;
    x_watcher_control: ControlRow;
  }
}
