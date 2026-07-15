import type { Context } from "koishi";
import type { XDataSourceService } from "../../../ports/source";
import { makeTwitterApiHydrate } from "./hydration-source";
import {
  makeTwitterApiFetchAfter,
  makeTwitterApiFetchLatestId,
} from "./timeline-source";
import { makeTwitterApiResolveUser } from "./user-source";

/** 创建 TwitterAPI.io REST 数据源服务。 */
export const makeTwitterApiDataSource = (
  ctx: Context,
  apiKey: string,
): XDataSourceService => ({
  /** 通过用户名解析稳定用户 ID 与当前资料。 */
  resolveUser: makeTwitterApiResolveUser(ctx, apiKey),
  /** 获取包含回复的首页并选择最大 Snowflake ID。 */
  fetchLatestId: makeTwitterApiFetchLatestId(ctx, apiKey),
  /** 跨页恢复最多 20 条动态并以第 21 条标记溢出。 */
  fetchAfter: makeTwitterApiFetchAfter(ctx, apiKey),
  /** 补全实时入口持久化的标准或精简事件。 */
  hydrate: makeTwitterApiHydrate(ctx, apiKey),
});
