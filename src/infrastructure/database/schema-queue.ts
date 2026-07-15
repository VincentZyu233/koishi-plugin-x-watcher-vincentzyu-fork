import type { Context } from "koishi";
import { uniqueIndex } from "./indexes";

/** 注册原始事件、消息投递与控制 outbox 三张队列表。 */
export const initializeQueueTables = (ctx: Context): void => {
  ctx.database.extend(
    "x_watcher_raw_event",
    {
      id: "unsigned",
      eventKey: "string",
      accountId: { type: "unsigned", nullable: true, initial: null },
      accountXUserId: { type: "string", nullable: true, initial: null },
      activityId: { type: "string", nullable: true, initial: null },
      provider: "string",
      reduced: "boolean",
      payloadJson: "text",
      receivedAt: "timestamp",
      status: "string",
      attempts: "unsigned",
      availableAt: "timestamp",
      leaseUntil: { type: "timestamp", nullable: true, initial: null },
      claimToken: { type: "string", nullable: true, initial: null },
      lastError: { type: "text", nullable: true, initial: null },
      completedAt: { type: "timestamp", nullable: true, initial: null },
      createdAt: "timestamp",
    },
    {
      primary: "id",
      autoInc: true,
      indexes: [
        uniqueIndex("x_watcher_raw_event_key", { eventKey: "asc" }),
        ["status", "availableAt", "id"],
        ["accountId", "status"],
        "completedAt",
      ],
    },
  );
  ctx.database.extend(
    "x_watcher_delivery",
    {
      id: "unsigned",
      subscriptionId: "unsigned",
      activityRecordId: { type: "unsigned", nullable: true, initial: null },
      dedupeKey: "string",
      plan: "json",
      status: "string",
      stage: "string",
      partIndex: "unsigned",
      attempts: "unsigned",
      availableAt: "timestamp",
      leaseUntil: { type: "timestamp", nullable: true, initial: null },
      claimToken: { type: "string", nullable: true, initial: null },
      lastError: { type: "text", nullable: true, initial: null },
      createdAt: "timestamp",
      completedAt: { type: "timestamp", nullable: true, initial: null },
    },
    {
      primary: "id",
      autoInc: true,
      indexes: [
        uniqueIndex("x_watcher_delivery_subscription_dedupe", {
          subscriptionId: "asc",
          dedupeKey: "asc",
        }),
        ["status", "availableAt", "id"],
        ["subscriptionId", "status", "id"],
        "completedAt",
      ],
    },
  );
  ctx.database.extend(
    "x_watcher_control",
    {
      id: "unsigned",
      accountId: "unsigned",
      operation: "string",
      keyFingerprint: { type: "string", nullable: true, initial: null },
      remoteId: { type: "string", nullable: true, initial: null },
      status: "string",
      attempts: "unsigned",
      availableAt: "timestamp",
      leaseUntil: { type: "timestamp", nullable: true, initial: null },
      claimToken: { type: "string", nullable: true, initial: null },
      lastError: { type: "text", nullable: true, initial: null },
      createdAt: "timestamp",
      completedAt: { type: "timestamp", nullable: true, initial: null },
    },
    {
      primary: "id",
      autoInc: true,
      indexes: [
        ["status", "availableAt", "id"],
        ["accountId", "status", "id"],
        "completedAt",
      ],
    },
  );
};
