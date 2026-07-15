import type { Context } from "koishi";
import type { CommandRuntime } from "./models";
import { registerListCommand } from "./register-list";
import { registerUnwatchCommand } from "./register-unwatch";
import { registerWatchCommand } from "./register-watch";

/** 注册 watch、unwatch 与 xlist 命令。 */
export const registerCommands = (ctx: Context, runtime: CommandRuntime): void => {
  registerWatchCommand(ctx, runtime);
  registerUnwatchCommand(ctx, runtime);
  registerListCommand(ctx, runtime);
};
