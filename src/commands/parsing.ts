import * as Either from "effect/Either";
import { compileFilter } from "../domain/filter";
import type { FilterPatch } from "../ports/storage";

/** 判断对象是否显式包含指定选项。 */
export const hasOption = (options: object, name: string): boolean =>
  Object.prototype.hasOwnProperty.call(options, name);

/** 将 watch 命令参数解析为过滤规则补丁。 */
export const parseFilterPatch = (
  regexp: string | undefined,
  clearFilter: boolean,
): Either.Either<FilterPatch, string> => {
  const normalized = regexp === undefined ? "" : regexp.trim();
  if (clearFilter && normalized.length > 0) {
    return Either.left("不能同时提供正则表达式与 --clear-filter");
  }
  if (clearFilter) return Either.right({ _tag: "Clear" });
  if (normalized.length === 0) return Either.right({ _tag: "Preserve" });
  const compiled = compileFilter(normalized);
  return Either.isLeft(compiled)
    ? Either.left(`正则表达式不受 RE2 支持：${compiled.left}`)
    : Either.right({ _tag: "Set", pattern: compiled.right.pattern });
};
