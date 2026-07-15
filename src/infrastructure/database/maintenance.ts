import type { Context } from "koishi";
import { runTransaction } from "./database-effect";

/** 清理七天保留线之前的终态队列与不再被引用的动态审计。 */
export const cleanupTerminalRecords = (ctx: Context, before: Date) =>
  runTransaction(ctx, "cleanupTerminalRecords", async (database) => {
    const deliveries = await database.get("x_watcher_delivery", {});
    const deliveryIds = deliveries
      .filter(
        (row) =>
          (row.status === "sent" || row.status === "cancelled") &&
          row.completedAt !== null &&
          row.completedAt.getTime() <= before.getTime(),
      )
      .map((row) => row.id);
    if (deliveryIds.length > 0) {
      await database.remove("x_watcher_delivery", { id: deliveryIds });
    }
    const rawEvents = await database.get("x_watcher_raw_event", {});
    const rawIds = rawEvents
      .filter(
        (row) =>
          row.status === "completed" &&
          row.completedAt !== null &&
          row.completedAt.getTime() <= before.getTime(),
      )
      .map((row) => row.id);
    if (rawIds.length > 0) {
      await database.remove("x_watcher_raw_event", { id: rawIds });
    }
    const controls = await database.get("x_watcher_control", {});
    const controlIds = controls
      .filter(
        (row) =>
          (row.status === "completed" || row.status === "cancelled") &&
          row.completedAt !== null &&
          row.completedAt.getTime() <= before.getTime(),
      )
      .map((row) => row.id);
    if (controlIds.length > 0) {
      await database.remove("x_watcher_control", { id: controlIds });
    }
    const activities = (await database.get("x_watcher_activity", {})).filter(
      (row) => row.recordedAt.getTime() <= before.getTime(),
    );
    for (const activity of activities) {
      const references = await database.get(
        "x_watcher_delivery",
        { activityRecordId: activity.id },
        { limit: 1 },
      );
      if (references.length === 0) {
        await database.remove("x_watcher_activity", { id: activity.id });
      }
    }
  });
