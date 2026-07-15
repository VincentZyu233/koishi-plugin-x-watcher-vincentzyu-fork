import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { XActivity } from "../domain/activity";
import type {
  PersistenceError,
  SourceError,
  RemoteMonitorError,
} from "../domain/errors";
import type { ActivityId, XHandle, XUserId } from "../domain/identifiers";

/** 数据源解析得到的 X/Twitter 用户。 */
export interface ResolvedXUser {
  readonly id: XUserId;
  readonly handle: XHandle;
  readonly displayName: string;
}

/** 最多包含 20 条详情；第 21 个唯一动态只保留路由边界。 */
export interface RecoveryBatch {
  readonly activities: ReadonlyArray<XActivity>;
  readonly newestId: Option.Option<ActivityId>;
  readonly overflow: boolean;
  readonly overflowBoundary: RecoveryOverflowBoundary | null;
}

/** 恢复批次第 21 个唯一动态的最小路由边界。 */
export interface RecoveryOverflowBoundary {
  readonly id: ActivityId;
  readonly createdAtEpochMillis: number;
}

/** 实时入口收到且尚未规范化的原始事件。 */
export interface RawRealtimeEvent {
  readonly provider: "twitterapiio";
  readonly eventKey: string;
  readonly accountId: Option.Option<XUserId>;
  readonly activityId: Option.Option<ActivityId>;
  readonly reduced: boolean;
  readonly payloadJson: string;
  readonly receivedAtEpochMillis: number;
}

/** 数据源实现必须提供的公共能力。 */
export interface XDataSourceService {
  /** 通过用户名解析稳定用户 ID 和当前资料。 */
  readonly resolveUser: (
    handle: XHandle,
  ) => Effect.Effect<ResolvedXUser, SourceError>;

  /** 获取当前最新动态 ID，用于无历史基线。 */
  readonly fetchLatestId: (
    userId: XUserId,
  ) => Effect.Effect<Option.Option<ActivityId>, SourceError>;

  /** 从水位向前扫描，最多确认到第 21 条新原始动态。 */
  readonly fetchAfter: (
    userId: XUserId,
    cursor: Option.Option<ActivityId>,
  ) => Effect.Effect<RecoveryBatch, SourceError>;

  /** 将持久化的精简实时事件补全为规范化动态。 */
  readonly hydrate: (
    event: RawRealtimeEvent,
  ) => Effect.Effect<XActivity, SourceError>;
}

/** 与运行模式无关的数据源服务 Tag。 */
export class XDataSource extends Context.Tag("x-watcher/XDataSource")<
  XDataSource,
  XDataSourceService
>() {}

/** 实时连接向应用层提交事件的回调。 */
export type RawEventSink = (
  event: RawRealtimeEvent,
) => Effect.Effect<void, PersistenceError>;

/** WebSocket 或 Webhook 实时入口能力。 */
export interface RealtimeIngressService {
  /** 在当前 Scope 内启动入口并将事件交给持久化 sink。 */
  readonly run: (
    sink: RawEventSink,
    onConnected: Effect.Effect<void, never>,
  ) => Effect.Effect<never, SourceError>;
}

/** 实时入口服务 Tag。 */
export class RealtimeIngress extends Context.Tag("x-watcher/RealtimeIngress")<
  RealtimeIngress,
  RealtimeIngressService
>() {}

/** Account Stream 远端监控条目。 */
export interface RemoteMonitorEntry {
  readonly remoteId: string;
  readonly userId: Option.Option<XUserId>;
  readonly handle: XHandle;
}

/** Account Stream 远端监控控制能力。 */
export interface RemoteMonitorService {
  /** 添加一个 X/Twitter 用户到远端监控集合。 */
  readonly add: (
    handle: XHandle,
  ) => Effect.Effect<RemoteMonitorEntry, RemoteMonitorError>;

  /** 删除由插件持久化持有的远端监控条目。 */
  readonly remove: (
    remoteId: string,
  ) => Effect.Effect<void, RemoteMonitorError>;

  /** 列出当前 API key 下的远端监控条目。 */
  readonly list: () => Effect.Effect<
    ReadonlyArray<RemoteMonitorEntry>,
    RemoteMonitorError
  >;
}

/** Account Stream 远端控制服务 Tag。 */
export class RemoteMonitor extends Context.Tag("x-watcher/RemoteMonitor")<
  RemoteMonitor,
  RemoteMonitorService
>() {}
