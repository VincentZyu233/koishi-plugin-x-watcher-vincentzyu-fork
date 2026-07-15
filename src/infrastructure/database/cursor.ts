import { compareActivityId, type ActivityId } from "../../domain/identifiers";

/** 返回两个可空动态水位中的较新值。 */
export const newestCursor = (
  left: ActivityId | null,
  right: ActivityId | null,
): ActivityId | null => {
  if (left === null) return right;
  if (right === null) return left;
  return compareActivityId(left, right) >= 0 ? left : right;
};

/** 返回两个订阅水位中更旧的值，任一未知时视为尚未建立基线。 */
export const oldestCursor = (
  left: ActivityId | null,
  right: ActivityId | null,
): ActivityId | null => {
  if (left === null || right === null) return null;
  return compareActivityId(left, right) <= 0 ? left : right;
};
