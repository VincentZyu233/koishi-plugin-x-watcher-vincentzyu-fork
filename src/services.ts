import type {
  ActivityBatch,
  ActivityCursor,
  Result,
  SourceError,
  XActivity,
  XUser,
} from "./domain";

/** 两个 provider 都必须实现的最小数据源能力。 */
export interface XDataSourceService {
  readonly provider: "rettiwt" | "twitterapiio";
  readonly resolveUser: (
    handle: string,
  ) => Promise<Result<XUser, SourceError>>;
  readonly fetchBaseline: (
    user: XUser,
  ) => Promise<Result<string | null, SourceError>>;
  readonly fetchAfter: (
    user: XUser,
    cursor: ActivityCursor,
    until: Date,
  ) => Promise<Result<ActivityBatch, SourceError>>;
  readonly fetchLatest?: (
    user: XUser,
    kind: "post" | "reply",
  ) => Promise<Result<XActivity | null, SourceError>>;
  readonly fetchRecent?: (
    user: XUser,
    count: number,
  ) => Promise<Result<ReadonlyArray<XActivity>, SourceError>>;
}

/** TwitterAPI.io Account Stream 的远端状态。 */
export type MonitorStatus = "waiting" | "configuring" | "active" | "failed";

/** 规范化后的远端监控账号。 */
export interface MonitorEntry {
  readonly idForUser: string;
  readonly handle: string;
  readonly status: MonitorStatus;
}

/** Account Stream 建立连接后交给上层的回调。 */
export interface StreamHandlers {
  readonly onConnected: () => Promise<void>;
  readonly onActivities: (
    activities: ReadonlyArray<XActivity>,
  ) => Promise<void>;
  readonly onError: (error: SourceError) => void;
  readonly onClosed: (code: number, reason: string) => void;
}

/** 上层只需具备关闭当前 WebSocket 的能力。 */
export interface StreamConnection {
  readonly close: (code: number, reason: string) => void;
}

/** TwitterAPI.io 实时模式独有的远端控制和连接能力。 */
export interface AccountStreamService {
  readonly listMonitors: () => Promise<
    Result<ReadonlyArray<MonitorEntry>, SourceError>
  >;
  readonly addMonitor: (
    handle: string,
  ) => Promise<Result<void, SourceError>>;
  readonly removeMonitor: (
    idForUser: string,
  ) => Promise<Result<void, SourceError>>;
  readonly connect: (
    handlers: StreamHandlers,
  ) => Result<StreamConnection, SourceError>;
}
