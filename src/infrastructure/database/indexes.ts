import type { Driver } from "koishi";

/** 创建带稳定名称的唯一索引定义。 */
export const uniqueIndex = <K extends string>(
  name: string,
  keys: { readonly [P in K]?: "asc" | "desc" },
): Driver.Index<K> => ({ name, keys, unique: true });
