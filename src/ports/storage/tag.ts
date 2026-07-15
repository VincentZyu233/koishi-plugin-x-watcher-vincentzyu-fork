import * as Context from "effect/Context";
import type { XWatcherStoreService } from "./service";

/** x-watcher 持久化服务 Tag。 */
export class XWatcherStore extends Context.Tag("x-watcher/XWatcherStore")<
  XWatcherStore,
  XWatcherStoreService
>() {}
