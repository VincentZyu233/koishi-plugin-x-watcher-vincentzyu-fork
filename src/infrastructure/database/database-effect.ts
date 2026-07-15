import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Context } from "koishi";
import { PersistenceError } from "../../domain/errors";

/** x-watcher 事务回调可见的数据库类型。 */
export type XWatcherDatabase = Context["database"];

/** 将任意数据库异常转换为稳定的持久化错误。 */
export const persistenceError = <E>(
  operation: string,
  error: E,
): PersistenceError =>
  new PersistenceError({
    operation,
    message: error instanceof Error ? error.message : String(error),
  });

/** 将 Promise 数据库操作提升为带类型错误的 Effect。 */
export const runDatabase = <A>(
  operation: string,
  task: () => Promise<A>,
): Effect.Effect<A, PersistenceError> =>
  Effect.tryPromise({
    try: task,
    /** 把任意数据库拒绝原因收敛为持久化错误。 */
    catch: (error) => persistenceError(operation, error),
  });

/** 在 Minato 事务内运行操作并保留其结果。 */
export const runTransaction = <A>(
  ctx: Context,
  operation: string,
  task: (database: XWatcherDatabase) => Promise<A>,
): Effect.Effect<A, PersistenceError> =>
  runDatabase(operation, async () => {
    let result: Option.Option<A> = Option.none();
    await ctx.database.withTransaction(async (database) => {
      result = Option.some(await task(database));
    });
    return Option.match(result, {
      /** 将违反事务回调约定的状态变成可映射的 Promise 拒绝。 */
      onNone: () => Promise.reject(new Error(`事务 ${operation} 未返回结果`)),
      /** 返回事务回调已经保存的成功值。 */
      onSome: (value) => Promise.resolve(value),
    });
  });
