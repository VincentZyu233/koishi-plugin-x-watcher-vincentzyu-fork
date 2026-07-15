import type { Context } from "koishi";
import { randomUUID } from "node:crypto";
import type { ClaimedDelivery } from "../../ports/storage";
import { runTransaction } from "./database-effect";
import { toClaimedDelivery } from "./mapping";
import type { DeliveryRow } from "./rows-queue";

/** 判断投递头任务当前是否可领取。 */
const isDeliveryEligible = (row: DeliveryRow, now: Date): boolean => {
  if (row.availableAt.getTime() > now.getTime()) return false;
  if (row.status === "pending") return true;
  return row.status === "processing" &&
    row.leaseUntil !== null &&
    row.leaseUntil.getTime() <= now.getTime();
};

/** 按每个订阅的最早非终态任务阻塞顺序原子领取一条投递。 */
export const claimDelivery = (
  ctx: Context,
  now: Date,
  leaseUntil: Date,
) =>
  runTransaction(
    ctx,
    "claimDelivery",
    async (database): Promise<ClaimedDelivery | null> => {
      const rows = await database.get(
        "x_watcher_delivery",
        { $or: [{ status: "pending" }, { status: "processing" }] },
        { sort: { id: "asc" } },
      );
      const seen = new Set<number>();
      for (const row of rows) {
        if (row.status !== "pending" && row.status !== "processing") continue;
        if (seen.has(row.subscriptionId)) continue;
        seen.add(row.subscriptionId);
        if (!isDeliveryEligible(row, now)) continue;
        const subscriptions = await database.get(
          "x_watcher_subscription",
          { id: row.subscriptionId },
          { limit: 1 },
        );
        const subscription = subscriptions[0];
        if (subscription === undefined || !subscription.active) {
          await database.set(
            "x_watcher_delivery",
            {
              id: row.id,
              status: row.status,
              claimToken: row.claimToken === null ? { $exists: false } : row.claimToken,
            },
            {
              status: "cancelled",
              leaseUntil: null,
              claimToken: null,
              completedAt: now,
            },
          );
          continue;
        }
        const attempts = row.attempts + 1;
        const claimToken = randomUUID();
        await database.set(
          "x_watcher_delivery",
          {
            id: row.id,
            status: row.status,
            claimToken: row.claimToken === null ? { $exists: false } : row.claimToken,
          },
          {
            status: "processing",
            attempts,
            leaseUntil,
            claimToken,
            lastError: null,
          },
        );
        const claimed = await database.get(
          "x_watcher_delivery",
          { id: row.id, status: "processing", claimToken },
          { limit: 1 },
        );
        if (claimed[0] === undefined) continue;
        return toClaimedDelivery(
          claimed[0],
          subscription,
          claimToken,
        );
      }
      return null;
    },
  );

/** 完成投递任务并清除其租约与错误。 */
export const completeDelivery = (
  ctx: Context,
  deliveryId: number,
  claimToken: string,
  now: Date,
) =>
  runTransaction(ctx, "completeDelivery", async (database) => {
    await database.set(
      "x_watcher_delivery",
      { id: deliveryId, status: "processing", claimToken },
      {
        status: "sent",
        leaseUntil: null,
        claimToken: null,
        lastError: null,
        completedAt: now,
      },
    );
  });

/** 保存降级阶段或分片进度，并释放任务等待下一次领取。 */
export const updateDeliveryProgress = (
  ctx: Context,
  deliveryId: number,
  claimToken: string,
  stage: DeliveryRow["stage"],
  partIndex: number,
  availableAt: Date,
  message: string | null,
) =>
  runTransaction(ctx, "updateDeliveryProgress", async (database) => {
    await database.set(
      "x_watcher_delivery",
      { id: deliveryId, status: "processing", claimToken },
      {
        status: "pending",
        stage,
        partIndex,
        availableAt,
        leaseUntil: null,
        claimToken: null,
        lastError: message,
        ...(message === null ? { attempts: 0 } : {}),
      },
    );
  });
