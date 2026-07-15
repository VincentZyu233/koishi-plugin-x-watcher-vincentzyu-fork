import type * as Effect from "effect/Effect";
import type { SubscriptionApplication } from "../application/subscription";

/** watch 命令中媒体与过滤选项的最小结构。 */
export interface WatchOptions {
  readonly media?: boolean;
  readonly types?: string;
  readonly clearFilter?: boolean;
}

/** list 命令选项。 */
export interface ListOptions {
  readonly all?: boolean;
}

/** 命令边界所需的最小 Effect runtime 能力。 */
export interface CommandRuntime {
  /** 执行仅依赖订阅应用服务的 Effect。 */
  readonly runPromise: <A, E>(
    effect: Effect.Effect<A, E, SubscriptionApplication>,
  ) => Promise<A>;
}
