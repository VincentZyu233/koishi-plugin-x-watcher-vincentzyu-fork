import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import type { Context } from "koishi";
import { SubscriptionApplication } from "../application/subscription";
import { parseActivityKinds } from "../domain/activity";
import { parseXHandle } from "../domain/identifiers";
import { formatApplicationError, formatWatchResult } from "./formatting";
import type { CommandRuntime, WatchOptions } from "./models";
import { hasOption, parseFilterPatch } from "./parsing";
import { parseCommandTarget } from "./target";

/** 注册 watch 命令及其局部补丁解析流程。 */
export const registerWatchCommand = (ctx: Context, runtime: CommandRuntime): void => {
  ctx.command("x-watcher.watch <username:string> [regexp:string]", "订阅 X/Twitter 用户动态", {
    checkArgCount: true,
    checkUnknown: true,
  })
    .option("media", "-m, --media")
    .option("types", "-t, --types <types:string>")
    .option("clearFilter", "--clear-filter")
    .alias("watch")
    .action(
      /** 解析 watch 输入并将命令执行委托给订阅应用服务。 */
      async ({ session, options }, username, regexp) => {
        if (session === undefined) return "当前命令缺少会话上下文";
        const target = parseCommandTarget(session);
        if (Either.isLeft(target)) return target.left;
        const handle = parseXHandle(username);
        if (Either.isLeft(handle)) return "请提供有效的 X/Twitter 用户名";
        const typedOptions: WatchOptions = options === undefined ? {} : options;
        const kinds = typedOptions.types === undefined
          ? null
          : parseActivityKinds(typedOptions.types);
        if (typeof kinds === "string") return kinds;
        const filter = parseFilterPatch(regexp, typedOptions.clearFilter === true);
        if (Either.isLeft(filter)) return filter.left;
        const includeMedia = hasOption(typedOptions, "media")
          ? typedOptions.media === true
          : null;
        return runtime.runPromise(
          SubscriptionApplication.pipe(
            Effect.flatMap((application) =>
              application.watch({
                target: target.right,
                handle: handle.right,
                kinds,
                filter: filter.right,
                includeMedia,
              }),
            ),
            Effect.match({ onFailure: formatApplicationError, onSuccess: formatWatchResult }),
          ),
        );
      },
    );
};
