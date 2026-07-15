import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { Context } from "koishi";
import { SubscriptionApplication } from "../application/subscription";
import { formatSubscriptionList } from "./formatting";
import type { CommandRuntime, ListOptions } from "./models";
import { parseCommandTarget } from "./target";

/** 注册 xlist 命令及其频道订阅查询流程。 */
export const registerListCommand = (ctx: Context, runtime: CommandRuntime): void => {
  ctx.command("x-watcher.list", "查看当前频道的 X/Twitter 订阅")
    .option("all", "-a, --all")
    .alias("xlist")
    .action(
      /** 查询当前频道订阅并将存储结果渲染为文本。 */
      async ({ session, options }) => {
        if (session === undefined) return "当前命令缺少会话上下文";
        const target = parseCommandTarget(session);
        if (Either.isLeft(target)) return target.left;
        const typedOptions: ListOptions = options === undefined ? {} : options;
        return runtime.runPromise(
          SubscriptionApplication.pipe(
            Effect.flatMap((application) => application.list(target.right, typedOptions.all === true)),
            Effect.match({
              /** 将列表失败翻译为中文。 */
              onFailure: (error) => `订阅数据库操作失败：${error.message}`,
              onSuccess: formatSubscriptionList,
            }),
          ),
        );
      },
    );
};
