import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { XDataSource } from "../../ports/source";
import { XWatcherStore, type StoredAccount } from "../../ports/storage";

/** 为单个账号建立基线或执行一次恢复扫描。 */
const recoverAccount = (
  account: StoredAccount,
  consumeRecoveryDue: boolean,
) =>
  Effect.gen(function* () {
    const source = yield* XDataSource;
    const store = yield* XWatcherStore;
    const now = new Date(yield* Clock.currentTimeMillis);
    if (account.status === "initializing") {
      const latest = yield* source.fetchLatestId(account.xUserId);
      yield* store.initializeAccount(
        account.id,
        Option.getOrNull(latest),
        consumeRecoveryDue,
        now,
      );
      return;
    }
    const batch = yield* source.fetchAfter(
      account.xUserId,
      Option.fromNullable(account.cursor),
    );
    yield* store.commitRecovery({
      account,
      activities: batch.activities,
      newestId: Option.getOrNull(batch.newestId),
      overflow: batch.overflow,
      overflowBoundary: batch.overflowBoundary,
      consumeRecoveryDue,
      now,
    });
  });

/** 恢复全部账号，并将单账号失败隔离为日志。 */
const recoverAccounts = (
  accounts: ReadonlyArray<{
    readonly account: StoredAccount;
    readonly consumeRecoveryDue: boolean;
  }>,
) =>
  Effect.forEach(
    accounts,
    ({ account, consumeRecoveryDue }) =>
      recoverAccount(account, consumeRecoveryDue).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `账号 @${account.handle} 恢复失败 [${error._tag}]：${error.message}`,
          ),
        ),
      ),
    { concurrency: 1, discard: true },
  );

/** 执行启动恢复或一轮轮询。 */
export const runRecoveryCycle = Effect.gen(function* () {
  const store = yield* XWatcherStore;
  const accounts = yield* store.listActiveAccounts();
  yield* recoverAccounts(accounts.map((account) => ({
    account,
    consumeRecoveryDue: false,
  })));
});

/** 仅处理初始化账号和到期的一次性实时补拉。 */
export const runDueRecoveryCycle = Effect.gen(function* () {
  const store = yield* XWatcherStore;
  const now = new Date(yield* Clock.currentTimeMillis);
  const accounts = yield* store.listActiveAccounts();
  const due = accounts.flatMap((account) => {
    const consumes = account.recoveryDueAt !== null && account.recoveryDueAt <= now;
    return account.status === "initializing" || consumes
      ? [{ account, consumeRecoveryDue: consumes }]
      : [];
  });
  yield* recoverAccounts(due);
});

/** 创建不重叠的轮询循环。 */
export const pollingLoop = (intervalMinutes: number) =>
  Effect.forever(
    runRecoveryCycle.pipe(
      Effect.catchAll((error) =>
        Effect.logError(`轮询周期失败 [${error._tag}]：${error.message}`),
      ),
      Effect.zipRight(Effect.sleep(`${intervalMinutes} minutes`)),
    ),
  );
