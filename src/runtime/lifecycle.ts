import * as Option from "effect/Option";
import type { Context } from "koishi";
import type { Config } from "../config";
import { initializeDatabase } from "../infrastructure/database";
import type { RuntimeDisposer } from "./models";
import { startConfiguredRuntime } from "./start";

/** 注册可处理启动/销毁竞争条件的 Koishi 生命周期桥接。 */
export const installConfiguredRuntime = (ctx: Context, config: Config): void => {
  let disposed = false;
  let disposer = Option.none<RuntimeDisposer>();
  ctx.on("dispose", async () => {
    disposed = true;
    if (Option.isSome(disposer)) await disposer.value();
  });
  void startConfiguredRuntime(ctx, config).then(
    async (started) => {
      if (disposed) {
        await started();
        return;
      }
      disposer = Option.some(started);
    },
    (error) => {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger("x-watcher").error(
        "插件启动失败，命令与 worker 均未启用：%s",
        message,
      );
    },
  );
};

/** 在 Koishi 插件入口阶段同步注册全部数据库模型。 */
export const registerDatabaseModels = (ctx: Context): void => {
  initializeDatabase(ctx);
};
