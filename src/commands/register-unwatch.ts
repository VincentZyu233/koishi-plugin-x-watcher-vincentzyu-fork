import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { Context } from "koishi";
import { SubscriptionApplication } from "../application/subscription";
import { parseXHandle } from "../domain/identifiers";
import { formatApplicationError, formatUnwatchResult } from "./formatting";
import type { CommandRuntime } from "./models";
import { parseCommandTarget } from "./target";

/** 注册 unwatch 命令及其授权停用流程。 */
export const registerUnwatchCommand = (ctx: Context, runtime: CommandRuntime): void => {
  ctx.command("x-watcher.unwatch <username:string>", "停用 X/Twitter 用户动态订阅", {
    checkArgCount: true,
    checkUnknown: true,
  })
    .alias("unwatch")
    .action(
      /** 解析 unwatch 输入并将命令执行委托给订阅应用服务。 */
      async ({ session }, username) => {
        if (session === undefined) return "当前命令缺少会话上下文";
        const target = parseCommandTarget(session);
        if (Either.isLeft(target)) return target.left;
        const handle = parseXHandle(username);
        if (Either.isLeft(handle)) return "请提供有效的 X/Twitter 用户名";
        return runtime.runPromise(
          SubscriptionApplication.pipe(
            Effect.flatMap((application) => application.unwatch(target.right, handle.right)),
            Effect.match({ onFailure: formatApplicationError, onSuccess: formatUnwatchResult }),
          ),
        );
      },
    );
};
