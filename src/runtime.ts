import type { Context, Logger } from "koishi";
import { canonicalHandle, normalizeActivityOrder, type XActivity } from "./domain";
import { getActiveWatchers } from "./database";
import type {
  AccountStreamService,
  MonitorEntry,
  StreamConnection,
  XDataSourceService,
} from "./services";
import {
  createDeliveryTracker,
  createPollingRunner,
  recoverActiveHandles,
  recoverActiveWatchers,
  routeLiveActivities,
  type DeliveryTracker,
} from "./worker";

const MINUTE_MILLISECONDS = 60_000;
const RECONNECT_DELAY_MILLISECONDS = 90_000;
const RETRY_CLOSE_CODE = 1011;

/** 两种运行时共享的生命周期能力。 */
interface RuntimeLifecycle {
  readonly source: XDataSourceService;
  readonly start: () => Promise<void>;
  readonly dispose: () => void;
}

/** 轮询运行时不暴露远端 monitor。 */
export interface PollingPluginRuntime extends RuntimeLifecycle {
  readonly mode: "polling";
  readonly synchronizeMonitors: null;
}

/** WebSocket 运行时显式携带 monitor 对账能力。 */
export interface AccountStreamPluginRuntime extends RuntimeLifecycle {
  readonly mode: "websocket";
  readonly synchronizeMonitors: () => Promise<boolean>;
}

/** 判别联合阻止命令把轮询模式与远端 monitor 能力错误组合。 */
export type PluginRuntime =
  | PollingPluginRuntime
  | AccountStreamPluginRuntime;

/** 把 Promise 失败收敛到日志，避免计时器制造未处理拒绝。 */
function runDetached(
  operation: () => Promise<void>,
  logger: Logger,
  description: string,
): void {
  const pending = operation();
  void pending.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${description}：${message}`);
  });
}

/** 轮询模式启动即执行一次，之后使用非重入 runner 按间隔触发。 */
export function createPollingRuntime(
  ctx: Context,
  source: XDataSourceService,
  logger: Logger,
  intervalMinutes: number,
  tracker: DeliveryTracker = createDeliveryTracker(),
): PollingPluginRuntime {
  let cancelInterval: (() => void) | null = null;
  let disposed = false;
  const runner = createPollingRunner(
    ctx,
    source,
    logger,
    tracker,
    () => !disposed,
  );

  return {
    mode: "polling",
    source,
    synchronizeMonitors: null,
    start: async () => {
      if (disposed || cancelInterval !== null) return;
      await runner();
      if (disposed) return;
      cancelInterval = ctx.setInterval(
        () => runDetached(runner, logger, "X 动态轮询失败"),
        intervalMinutes * MINUTE_MILLISECONDS,
      );
    },
    dispose: () => {
      disposed = true;
      if (cancelInterval === null) return;
      cancelInterval();
      cancelInterval = null;
    },
  };
}

/** 本地活跃订阅按大小写无关用户名折叠，保留一个可提交给远端的原始写法。 */
async function readLocalHandles(ctx: Context): Promise<Map<string, string>> {
  const watchers = await getActiveWatchers(ctx);
  const handles = new Map<string, string>();
  for (const watcher of watchers) {
    const canonical = canonicalHandle(watcher.twitter_username);
    if (!handles.has(canonical)) handles.set(canonical, watcher.twitter_username);
  }
  return handles;
}

/** 判断远端列表是否与本地集合一一对应，重复 monitor 也视为不同步。 */
function isExactMonitorSet(
  monitors: ReadonlyArray<MonitorEntry>,
  local: ReadonlyMap<string, string>,
): boolean {
  if (monitors.length !== local.size) return false;
  const seen = new Set<string>();
  for (const monitor of monitors) {
    const handle = canonicalHandle(monitor.handle);
    if (!local.has(handle) || seen.has(handle)) return false;
    seen.add(handle);
  }
  return seen.size === local.size;
}

/** 记录一次远端列表观察结果，并找出刚首次进入 active 的账号。 */
function observeMonitorStatuses(
  monitors: ReadonlyArray<MonitorEntry>,
  local: ReadonlyMap<string, string>,
  previous: Map<string, MonitorEntry["status"]>,
  awaitingActivation: Set<string>,
  activatedOnce: Set<string>,
  initialized: boolean,
  logger: Logger,
): ReadonlySet<string> {
  const activeTransitions = new Set<string>();
  const next = new Map<string, MonitorEntry["status"]>();

  for (const monitor of monitors) {
    const handle = canonicalHandle(monitor.handle);
    if (!local.has(handle) || next.has(handle)) continue;
    const oldStatus = previous.get(handle);
    next.set(handle, monitor.status);

    if (monitor.status === "failed" && oldStatus !== "failed") {
      logger.error(`TwitterAPI.io 远端 monitor @${handle} 配置失败`);
    }
    if (!initialized && monitor.status !== "active") {
      awaitingActivation.add(handle);
    }
    if (
      monitor.status === "active" &&
      awaitingActivation.has(handle) &&
      !activatedOnce.has(handle)
    ) {
      activeTransitions.add(handle);
      activatedOnce.add(handle);
      awaitingActivation.delete(handle);
    }
  }

  previous.clear();
  for (const [handle, status] of next) previous.set(handle, status);
  for (const handle of [...awaitingActivation]) {
    if (!local.has(handle)) awaitingActivation.delete(handle);
  }
  for (const handle of [...activatedOnce]) {
    if (!local.has(handle)) activatedOnce.delete(handle);
  }
  return activeTransitions;
}

/** Stream 模式所需的内部可变状态，仅存在于闭包，不进入数据库模型。 */
interface StreamState {
  disposed: boolean;
  started: boolean;
  connection: StreamConnection | null;
  activeConnectionSequence: number;
  nextConnectionSequence: number;
  closingConnectionSequence: number;
  awaitingConnected: boolean;
  bufferedActivities: XActivity[];
  pendingRecoveries: number;
  workTail: Promise<boolean>;
  synchronizationTail: Promise<boolean>;
  cancelSynchronization: (() => void) | null;
  cancelReconnect: (() => void) | null;
  statusesInitialized: boolean;
}

/** 创建 Account Stream 调度器：远端对账、缺口恢复和实时投递共用一个串行队列。 */
export function createAccountStreamRuntime(
  ctx: Context,
  source: XDataSourceService,
  stream: AccountStreamService,
  logger: Logger,
  intervalMinutes: number,
  tracker: DeliveryTracker = createDeliveryTracker(),
): AccountStreamPluginRuntime {
  const state: StreamState = {
    disposed: false,
    started: false,
    connection: null,
    activeConnectionSequence: 0,
    nextConnectionSequence: 0,
    closingConnectionSequence: 0,
    awaitingConnected: false,
    bufferedActivities: [],
    pendingRecoveries: 0,
    workTail: Promise.resolve(true),
    synchronizationTail: Promise.resolve(true),
    cancelSynchronization: null,
    cancelReconnect: null,
    statusesInitialized: false,
  };
  const previousStatuses = new Map<string, MonitorEntry["status"]>();
  const awaitingActivation = new Set<string>();
  const activatedOnce = new Set<string>();

  /**
   * 收到账号的首条实时事件本身即可证明 monitor 已激活。
   * 必须在投递该事件前同步领取激活恢复，否则事件先推进水位后，配置窗口内的旧动态会被跳过。
   */
  const claimActivityActivations = (
    activities: ReadonlyArray<XActivity>,
  ): ReadonlySet<string> => {
    const claimed = new Set<string>();
    for (const activity of activities) {
      const handle = canonicalHandle(activity.username);
      if (
        awaitingActivation.has(handle) &&
        !activatedOnce.has(handle)
      ) {
        awaitingActivation.delete(handle);
        activatedOnce.add(handle);
        claimed.add(handle);
      }
    }
    return claimed;
  };

  /**
   * 投递或补漏失败时先立即使当前序号失效，再异步关闭 socket。
   * 这样 close 事件尚未到达时，已经排队的后续帧也不能越过失败水位。
   */
  const closeForRetry = (sequence: number, reason: string): void => {
    if (sequence !== state.activeConnectionSequence || sequence === 0) return;
    const connection = state.connection;
    state.closingConnectionSequence = connection === null ? 0 : sequence;
    state.connection = null;
    state.activeConnectionSequence = 0;
    state.awaitingConnected = false;
    state.bufferedActivities.length = 0;
    if (connection !== null) {
      try {
        connection.close(RETRY_CLOSE_CODE, reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`关闭 Account Stream 连接失败：${message}`);
      }
    }
    scheduleReconnect();
  };

  /** 串行队列永不向外抛出异常；旧连接的异常也不能影响新连接。 */
  const appendWork = (
    sequence: number,
    operation: () => Promise<boolean>,
  ): Promise<boolean> => {
    const guarded = async (): Promise<boolean> => {
      try {
        return await operation();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Account Stream 调度失败：${message}`);
        closeForRetry(sequence, "stream work failed");
        return false;
      }
    };
    const next = state.workTail.then(guarded, guarded);
    state.workTail = next;
    return next;
  };

  /**
   * 每次连接先按持久化水位补漏；monitor 激活只补对应账号。
   * 所有排队恢复完成后才按 ID 顺序排空实时事件，避免流数据越过 REST 缺口。
   */
  const enqueueRecovery = (
    sequence: number,
    handles: ReadonlySet<string> | null,
  ): Promise<boolean> => {
    state.pendingRecoveries += 1;
    const stableHandles = handles === null ? null : new Set(handles);
    return appendWork(sequence, async () => {
      const isCurrent = (): boolean =>
        !state.disposed && sequence === state.activeConnectionSequence;
      if (!isCurrent()) {
        state.pendingRecoveries -= 1;
        return false;
      }
      let recovered = false;
      try {
        recovered = stableHandles === null
          ? await recoverActiveWatchers(
              ctx,
              source,
              logger,
              tracker,
              isCurrent,
            )
          : await recoverActiveHandles(
              ctx,
              source,
              logger,
              tracker,
              stableHandles,
              isCurrent,
            );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Account Stream 补漏失败：${message}`);
      } finally {
        state.pendingRecoveries -= 1;
      }
      if (!isCurrent()) return false;
      if (!recovered) {
        state.bufferedActivities.length = 0;
        closeForRetry(sequence, "gap recovery failed");
        return false;
      }
      if (state.pendingRecoveries > 0) return true;

      const buffered = normalizeActivityOrder(state.bufferedActivities);
      state.bufferedActivities.length = 0;
      if (buffered.length === 0 || state.connection === null) return true;
      const delivered = await routeLiveActivities(
        ctx,
        logger,
        tracker,
        buffered,
        isCurrent,
      );
      if (!isCurrent()) return false;
      if (!delivered) closeForRetry(sequence, "buffer delivery failed");
      return delivered;
    });
  };

  /**
   * 恢复标记在回调到达时同步检查，不能等排队任务真正执行后再判断。
   * 这样恢复期间跨多个帧的动态才能合并、去重并按 ID 升序排空。
   */
  const enqueueActivities = (
    sequence: number,
    activities: ReadonlyArray<XActivity>,
  ): Promise<void> => {
    if (
      state.disposed ||
      sequence !== state.activeConnectionSequence
    ) {
      return Promise.resolve();
    }
    // connected 前的整连接补漏已经覆盖所有账号；连接就绪后则为流事件推断出的首次激活补一次缺口。
    const claimedActivations = state.awaitingConnected
      ? new Set<string>()
      : claimActivityActivations(activities);
    if (claimedActivations.size > 0) {
      state.bufferedActivities.push(...activities);
      return enqueueRecovery(sequence, claimedActivations).then(() => undefined);
    }
    if (state.awaitingConnected || state.pendingRecoveries > 0) {
      state.bufferedActivities.push(...activities);
      return Promise.resolve();
    }
    const isCurrent = (): boolean =>
      !state.disposed && sequence === state.activeConnectionSequence;
    return appendWork(sequence, async () => {
      if (!isCurrent()) return false;
      const delivered = await routeLiveActivities(
        ctx,
        logger,
        tracker,
        activities,
        isCurrent,
      );
      if (!isCurrent()) return false;
      if (!delivered) closeForRetry(sequence, "live delivery failed");
      return delivered;
    }).then(() => undefined);
  };

  /** 至多保留一个重连计时器，且异常断线后固定等待不少于 90 秒。 */
  const scheduleReconnect = (): void => {
    if (
      state.disposed ||
      state.connection !== null ||
      state.cancelReconnect !== null
    ) {
      return;
    }
    state.cancelReconnect = ctx.setTimeout(() => {
      state.cancelReconnect = null;
      openConnection();
    }, RECONNECT_DELAY_MILLISECONDS);
  };

  /** 创建单一 WebSocket；正常 dispose 的 1000 close 不会进入重连路径。 */
  const openConnection = (): void => {
    if (state.disposed || state.connection !== null) return;
    state.nextConnectionSequence += 1;
    const sequence = state.nextConnectionSequence;
    state.activeConnectionSequence = sequence;
    state.awaitingConnected = true;
    const connected = stream.connect({
      onConnected: async () => {
        if (
          state.disposed ||
          sequence !== state.activeConnectionSequence ||
          !state.awaitingConnected
        ) {
          return;
        }
        state.awaitingConnected = false;
        await enqueueRecovery(sequence, null);
      },
      onActivities: (activities) => enqueueActivities(sequence, activities),
      onError: (error) => {
        if (sequence !== state.activeConnectionSequence) return;
        if (error.kind === "decode") {
          logger.warn(`已忽略无法解码的 Account Stream 事件：${error.message}`);
          return;
        }
        logger.error(`Account Stream 错误 [${error.kind}]：${error.message}`);
        closeForRetry(sequence, "stream transport failed");
      },
      onClosed: (code, reason) => {
        if (sequence === state.closingConnectionSequence) {
          state.closingConnectionSequence = 0;
          if (state.cancelReconnect !== null) {
            state.cancelReconnect();
            state.cancelReconnect = null;
          }
          if (state.disposed) return;
          logger.warn(`Account Stream 异常断开 (${code}: ${reason})，90 秒后重连`);
          scheduleReconnect();
          return;
        }
        if (sequence !== state.activeConnectionSequence) return;
        state.connection = null;
        state.activeConnectionSequence = 0;
        state.awaitingConnected = false;
        state.bufferedActivities.length = 0;
        if (state.disposed) return;
        logger.warn(`Account Stream 连接断开 (${code}: ${reason})，90 秒后重连`);
        scheduleReconnect();
      },
    });
    if (!connected.ok) {
      state.activeConnectionSequence = 0;
      state.awaitingConnected = false;
      logger.error(
        `创建 Account Stream 连接失败 [${connected.error.kind}]：${connected.error.message}`,
      );
      scheduleReconnect();
      return;
    }
    if (
      state.disposed ||
      sequence !== state.activeConnectionSequence
    ) {
      connected.value.close(1000, "stale connection");
      return;
    }
    state.connection = connected.value;
  };

  /**
   * 将远端 monitor 精确对账为本地活跃用户名集合。
   * 只删除本地不存在或重复的项；failed 状态只报警，绝不删除重建。
   */
  const reconcileMonitors = async (): Promise<boolean> => {
    const local = await readLocalHandles(ctx);
    const listed = await stream.listMonitors();
    if (!listed.ok) {
      // 首次状态读取失败时无法判断远端是否仍在配置；先保守标记，避免首条流事件越过配置窗口缺口。
      if (!state.statusesInitialized) {
        for (const handle of local.keys()) awaitingActivation.add(handle);
      }
      logger.error(
        `读取远端 monitor 失败 [${listed.error.kind}]：${listed.error.message}`,
      );
      return false;
    }

    let operationsSucceeded = true;
    let changed = false;
    const kept = new Set<string>();
    for (const monitor of listed.value) {
      const handle = canonicalHandle(monitor.handle);
      if (!local.has(handle) || kept.has(handle)) {
        const removed = await stream.removeMonitor(monitor.idForUser);
        changed = true;
        if (!removed.ok) {
          operationsSucceeded = false;
          logger.error(`删除远端 monitor @${handle} 失败：${removed.error.message}`);
        }
        continue;
      }
      kept.add(handle);
    }

    for (const [handle, remoteSpelling] of local) {
      if (kept.has(handle)) continue;
      awaitingActivation.add(handle);
      const added = await stream.addMonitor(remoteSpelling);
      changed = true;
      if (!added.ok) {
        operationsSucceeded = false;
        logger.error(`添加远端 monitor @${handle} 失败：${added.error.message}`);
      }
    }

    const verified = changed ? await stream.listMonitors() : listed;
    if (!verified.ok) {
      logger.error(`验证远端 monitor 失败：${verified.error.message}`);
      return false;
    }
    const exact = isExactMonitorSet(verified.value, local);
    if (!exact) logger.warn("远端 monitor 列表尚未与本地订阅完全一致");

    const activated = observeMonitorStatuses(
      verified.value,
      local,
      previousStatuses,
      awaitingActivation,
      activatedOnce,
      state.statusesInitialized,
      logger,
    );
    state.statusesInitialized = true;
    const sequence = state.activeConnectionSequence;
    // 尚未收到 connected 时由整连接补漏覆盖，不能让局部激活补漏抢先排空缓存。
    if (
      activated.size > 0 &&
      sequence !== 0 &&
      !state.awaitingConnected
    ) {
      void enqueueRecovery(sequence, activated);
    }

    const hasFailed = verified.value.some((monitor) =>
      local.has(canonicalHandle(monitor.handle)) && monitor.status === "failed"
    );
    return operationsSucceeded && exact && !hasFailed;
  };

  /** 并发命令和周期任务按调用顺序串行对账，每次调用都观察最新本地订阅。 */
  const synchronizeMonitors = (): Promise<boolean> => {
    const operation = async (): Promise<boolean> => {
      if (state.disposed) return false;
      try {
        return await reconcileMonitors();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`远端 monitor 同步失败：${message}`);
        return false;
      }
    };
    const scheduled = state.synchronizationTail.then(operation, operation);
    state.synchronizationTail = scheduled;
    return scheduled;
  };

  return {
    mode: "websocket",
    source,
    synchronizeMonitors,
    start: async () => {
      if (state.disposed || state.started) return;
      state.started = true;
      await synchronizeMonitors();
      if (state.disposed) return;
      openConnection();
      state.cancelSynchronization = ctx.setInterval(
        () => runDetached(
          async () => {
            await synchronizeMonitors();
          },
          logger,
          "远端 monitor 周期同步失败",
        ),
        intervalMinutes * MINUTE_MILLISECONDS,
      );
    },
    dispose: () => {
      state.disposed = true;
      if (state.cancelSynchronization !== null) {
        state.cancelSynchronization();
        state.cancelSynchronization = null;
      }
      if (state.cancelReconnect !== null) {
        state.cancelReconnect();
        state.cancelReconnect = null;
      }
      const connection = state.connection;
      state.connection = null;
      state.activeConnectionSequence = 0;
      state.closingConnectionSequence = 0;
      state.bufferedActivities.length = 0;
      if (connection !== null) connection.close(1000, "plugin disposed");
    },
  };
}
