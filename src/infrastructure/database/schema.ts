import type { Context } from "koishi";
import { initializeDomainTables, initializeLegacyTable } from "./schema-domain";
import { initializeQueueTables } from "./schema-queue";

/** 同步注册六张新表及只用于迁移的旧表模型。 */
export const initializeDatabase = (ctx: Context): void => {
  initializeDomainTables(ctx);
  initializeQueueTables(ctx);
  initializeLegacyTable(ctx);
};
