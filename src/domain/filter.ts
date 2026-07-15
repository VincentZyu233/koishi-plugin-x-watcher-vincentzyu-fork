import * as Either from "effect/Either";
import { RE2JS } from "re2js";

/** 已通过 RE2JS 编译验证的过滤规则。 */
export interface CompiledFilter {
  readonly pattern: string;
  /** 判断输入文本是否命中过滤规则。 */
  readonly test: (input: string) => boolean;
}

/** 编译不区分大小写的 RE2 安全过滤规则。 */
export const compileFilter = (
  pattern: string,
): Either.Either<CompiledFilter, string> => {
  const normalized = pattern.trim();
  if (normalized.length === 0) return Either.left("过滤规则不能为空");
  try {
    const compiled = RE2JS.compile(normalized, RE2JS.CASE_INSENSITIVE);
    return Either.right({
      pattern: normalized,
      /** 判断完整可见文本是否命中过滤规则。 */
      test: (input: string) => compiled.test(input),
    });
  } catch (error) {
    return Either.left(error instanceof Error ? error.message : String(error));
  }
};

/** 在无规则时放行，有规则时使用 RE2JS 匹配。 */
export const matchesFilter = (
  pattern: string | null,
  searchableText: string,
): Either.Either<boolean, string> => {
  if (pattern === null) return Either.right(true);
  const compiled = compileFilter(pattern);
  return Either.map(compiled, (filter) => filter.test(searchableText));
};
