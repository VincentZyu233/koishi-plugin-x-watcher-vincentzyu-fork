/** 函数式边界统一使用的成功结果。 */
export interface Success<Value> {
  readonly ok: true;
  readonly value: Value;
}

/** 函数式边界统一使用的失败结果。 */
export interface Failure<ErrorValue> {
  readonly ok: false;
  readonly error: ErrorValue;
}

/** 避免用异常表达可预期失败的判别联合。 */
export type Result<Value, ErrorValue> =
  | Success<Value>
  | Failure<ErrorValue>;

/** 创建成功结果。 */
export function success<Value>(value: Value): Success<Value> {
  return { ok: true, value };
}

/** 创建失败结果。 */
export function failure<ErrorValue>(error: ErrorValue): Failure<ErrorValue> {
  return { ok: false, error };
}

/** 插件支持的四种 X 动态。 */
export type ActivityKind = "post" | "reply" | "quote" | "retweet";

/** 规范化后的媒体附件。 */
export interface XMedia {
  readonly kind: "image" | "gif" | "video";
  readonly url: string;
}

/** 与供应商无关的 X 用户资料。 */
export interface XUser {
  readonly id: string;
  readonly username: string;
  readonly fullname: string;
}

/** 与供应商无关的 X 动态。 */
export interface XActivity {
  readonly id: string;
  readonly authorId: string;
  readonly username: string;
  readonly fullname: string;
  readonly kind: ActivityKind;
  readonly text: string;
  readonly createdAt: Date;
  readonly url: string;
  readonly media: ReadonlyArray<XMedia>;
}

/** 查询增量动态所需的持久化水位。 */
export interface ActivityCursor {
  readonly lastId: string | null;
  readonly enabledAt: Date;
}

/** 一次数据源扫描返回的规范化动态。 */
export interface ActivityBatch {
  readonly activities: ReadonlyArray<XActivity>;
  readonly newestId: string | null;
}

/** 数据源错误所属的供应商。 */
export type SourceProvider = "rettiwt" | "twitterapiio";

/** 数据源边界可预期的错误种类。 */
export type SourceErrorKind =
  | "authentication"
  | "rate-limit"
  | "transport"
  | "decode"
  | "not-found"
  | "unavailable";

/** 屏蔽 SDK 和 HTTP 客户端异常结构的稳定错误。 */
export interface SourceError {
  readonly kind: SourceErrorKind;
  readonly provider: SourceProvider;
  readonly message: string;
  readonly retryAfterMilliseconds: number | null;
}

/** 构造不会携带原始密钥或响应正文的数据源错误。 */
export function sourceError(
  provider: SourceProvider,
  kind: SourceErrorKind,
  message: string,
  retryAfterMilliseconds: number | null = null,
): SourceError {
  return { provider, kind, message, retryAfterMilliseconds };
}

/** 清理 @ 前缀并验证 X 用户名。 */
export function normalizeHandle(
  input: string,
): Result<string, string> {
  const trimmed = input.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(withoutAt)) {
    return failure("用户名必须由 1～15 个字母、数字或下划线组成");
  }
  return success(withoutAt);
}

/** 生成用于数据库和远端监控对账的大小写无关用户名。 */
export function canonicalHandle(handle: string): string {
  return handle.trim().replace(/^@/, "").toLowerCase();
}

/** 验证 Twitter Snowflake ID 的安全字符串表示。 */
export function isSnowflakeId(value: string): boolean {
  return /^\d+$/.test(value);
}

/** 不转成 Number，按十进制位数和字典序比较 Snowflake。 */
export function compareSnowflake(left: string, right: string): number {
  const leftNormalized = left.replace(/^0+/, "") || "0";
  const rightNormalized = right.replace(/^0+/, "") || "0";
  if (leftNormalized.length !== rightNormalized.length) {
    return leftNormalized.length < rightNormalized.length ? -1 : 1;
  }
  if (leftNormalized === rightNormalized) return 0;
  return leftNormalized < rightNormalized ? -1 : 1;
}

/** 选择两个可空 Snowflake 水位中的较大者。 */
export function maxSnowflake(
  left: string | null,
  right: string,
): string {
  if (left === null) return right;
  return compareSnowflake(left, right) < 0 ? right : left;
}

/** 从 Snowflake 计算创建时间，失败时返回 null。 */
export function snowflakeDate(id: string): Date | null {
  if (!isSnowflakeId(id)) return null;
  try {
    const timestamp = (BigInt(id) >> 22n) + 1288834974657n;
    const numeric = Number(timestamp);
    if (!Number.isSafeInteger(numeric)) return null;
    const date = new Date(numeric);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch (error) {
    return null;
  }
}

/** 按 ID 去重并以从旧到新的顺序返回动态。 */
export function normalizeActivityOrder(
  activities: ReadonlyArray<XActivity>,
): ReadonlyArray<XActivity> {
  const seen = new Set<string>();
  const unique = activities.filter((activity) => {
    if (seen.has(activity.id)) return false;
    seen.add(activity.id);
    return true;
  });
  return unique.sort((left, right) => compareSnowflake(left.id, right.id));
}

/** 从动态列表中选出最大水位。 */
export function newestActivityId(
  activities: ReadonlyArray<XActivity>,
): string | null {
  let newest: string | null = null;
  for (const activity of activities) {
    newest = maxSnowflake(newest, activity.id);
  }
  return newest;
}

/** 编译不区分大小写的过滤规则。 */
export function compileFilter(
  input: string | null,
): Result<RegExp | null, string> {
  if (input === null || input.trim().length === 0) return success(null);
  try {
    return success(new RegExp(input, "i"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure(message);
  }
}
