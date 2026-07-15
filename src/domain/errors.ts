import * as Data from "effect/Data";

/** 表示插件配置无效。 */
export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly message: string;
}> {}

/** 表示数据源认证失败。 */
export class AuthenticationError extends Data.TaggedError("AuthenticationError")<{
  readonly provider: string;
  readonly message: string;
}> {}

/** 表示数据源触发限流。 */
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  readonly provider: string;
  readonly retryAfterMillis: number;
  readonly message: string;
}> {}

/** 表示网络或上游服务暂时不可用。 */
export class TransportError extends Data.TaggedError("TransportError")<{
  readonly provider: string;
  readonly message: string;
}> {}

/** 表示外部数据无法通过 Schema 解码。 */
export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly provider: string;
  readonly message: string;
}> {}

/** 表示目标 X/Twitter 用户不存在或不可访问。 */
export class UserUnavailableError extends Data.TaggedError("UserUnavailableError")<{
  readonly handle: string;
  readonly message: string;
}> {}

/** 表示 Account Stream 远端监控同步失败。 */
export class RemoteMonitorError extends Data.TaggedError("RemoteMonitorError")<{
  readonly operation: "add" | "remove" | "list";
  readonly message: string;
  readonly disposition?: "retry" | "manual";
  readonly candidateRemoteIds?: ReadonlyArray<string>;
}> {}

/** 表示数据库读写或迁移失败。 */
export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** 表示频道消息投递失败。 */
export class DeliveryError extends Data.TaggedError("DeliveryError")<{
  readonly classification: "unsupported" | "transient";
  readonly message: string;
}> {}

/** 表示调用者无权修改该频道订阅。 */
export class AuthorizationError extends Data.TaggedError("AuthorizationError")<{
  readonly message: string;
}> {}

/** 数据源边界可能返回的错误联合。 */
export type SourceError =
  | AuthenticationError
  | RateLimitError
  | TransportError
  | DecodeError
  | UserUnavailableError;
