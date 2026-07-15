import * as Effect from "effect/Effect";
import * as Either from "effect/Either";
import * as Option from "effect/Option";
import type { CursoredData, Tweet } from "rettiwt-api";
import type { XActivity } from "../../../domain/activity";
import { DecodeError, type SourceError } from "../../../domain/errors";
import {
  compareActivityId,
  isActivityAfter,
  parseActivityId,
  type ActivityId,
  type XUserId,
} from "../../../domain/identifiers";
import { withHealthyClient, type RettiwtClientPool } from "./client-pool";
import { mapRettiwtTweet } from "./mapper";

/** Rettiwt 支持的两条用户动态时间线。 */
export type RettiwtTimelineKind = "timeline" | "replies";

/** Rettiwt 单时间线扫描结果及全部可观察水位。 */
export interface RettiwtScanResult {
  readonly activities: ReadonlyArray<XActivity>;
  readonly observedIds: ReadonlyArray<ActivityId>;
}

/** 安全调用 Rettiwt mapper 并收纳外部对象造成的同步异常。 */
const decodeTweet = (tweet: Tweet): Either.Either<XActivity, DecodeError> => {
  try {
    return mapRettiwtTweet(tweet);
  } catch (error) {
    return Either.left(
      new DecodeError({ provider: "rettiwt", message: String(error) }),
    );
  }
};

/** 从可能损坏的 Rettiwt 对象安全提取可观察 Tweet ID。 */
export const extractRettiwtActivityId = (
  tweet: Tweet,
): Option.Option<ActivityId> => {
  try {
    const parsed = parseActivityId(tweet.id);
    return Either.isRight(parsed) ? Option.some(parsed.right) : Option.none();
  } catch {
    return Option.none();
  }
};

/** 将一页 Rettiwt 推文逐项解析并保留可用动态与水位。 */
const mapPage = (
  page: CursoredData<Tweet>,
  cursor: Option.Option<ActivityId>,
): Effect.Effect<RettiwtScanResult> =>
  Effect.gen(function* () {
    const items = page.list.map((tweet) => ({
      observedId: extractRettiwtActivityId(tweet),
      decoded: decodeTweet(tweet),
    }));
    yield* Effect.forEach(
      items,
      (item, index) =>
        Either.isLeft(item.decoded)
          ? Effect.logWarning(
              `Rettiwt 当前页第 ${index + 1} 条推文已跳过 [${item.decoded.left._tag}]`,
            )
          : Effect.void,
      { discard: true },
    );
    return {
      activities: items.flatMap((item) =>
        Either.isRight(item.decoded) &&
        (Option.isNone(cursor) || isActivityAfter(item.decoded.right.id, cursor.value))
          ? [item.decoded.right]
          : [],
      ),
      observedIds: items.flatMap((item) =>
        Option.isSome(item.observedId) ? [item.observedId.value] : [],
      ),
    };
  });

/** 判断当前页的可观察 ID 是否已经穿过调用方水位。 */
const pageCrossedCursor = (
  observedIds: ReadonlyArray<ActivityId>,
  cursor: Option.Option<ActivityId>,
): boolean =>
  Option.isSome(cursor) &&
  observedIds.some((id) => compareActivityId(id, cursor.value) <= 0);

/** 分页读取单条 Rettiwt 时间线直到水位、结尾或第 21 条唯一候选。 */
export const scanRettiwtTimeline = (
  pool: RettiwtClientPool,
  userId: XUserId,
  cursor: Option.Option<ActivityId>,
  kind: RettiwtTimelineKind,
): Effect.Effect<RettiwtScanResult, SourceError> =>
  Effect.gen(function* () {
    const collected = new Map<string, XActivity>();
    const observed = new Map<string, ActivityId>();
    const visitedCursors = new Set<string>();
    let next: string | undefined;
    let finished = false;
    while (!finished && collected.size < 21) {
      const requestCursor = next === undefined ? "" : next;
      if (visitedCursors.has(requestCursor)) {
        yield* Effect.logWarning("Rettiwt 分页游标重复，已停止本轮扫描");
        break;
      }
      visitedCursors.add(requestCursor);
      const page = yield* withHealthyClient(pool, (client) =>
        kind === "timeline"
          ? client.user.timeline(userId, 20, next)
          : client.user.replies(userId, 20, next),
      );
      const mapped = yield* mapPage(page, cursor);
      for (const id of mapped.observedIds) observed.set(id, id);
      for (const activity of mapped.activities) {
        if (!collected.has(activity.id) && collected.size < 21) {
          collected.set(activity.id, activity);
        }
      }
      next = typeof page.next === "string" ? page.next : "";
      const repeated = next.length > 0 && visitedCursors.has(next);
      if (repeated) yield* Effect.logWarning("Rettiwt 返回重复分页游标，已停止本轮扫描");
      finished =
        pageCrossedCursor(mapped.observedIds, cursor) ||
        next.length === 0 ||
        page.list.length === 0 ||
        repeated;
    }
    return {
      activities: [...collected.values()],
      observedIds: [...observed.values()],
    };
  });
