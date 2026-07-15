import { describe, expect, it } from "@effect/vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** 递归列出目录中的全部 TypeScript 源文件。 */
const listTypeScriptFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? listTypeScriptFiles(path)
      : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });

/** 判断节点前紧邻的注释是否包含中文说明。 */
const hasChineseLeadingComment = (
  source: ts.SourceFile,
  node: ts.Node,
): boolean => {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  return ranges.some((range) => /[\u3400-\u9fff]/u.test(
    source.text.slice(range.pos, range.end),
  ));
};

/** 判断变量是否直接声明了一个具名函数边界。 */
const isFunctionVariable = (node: ts.VariableDeclaration): boolean =>
  node.initializer !== undefined &&
  (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));

/** 收集缺少中文前置说明的函数、方法与服务函数签名。 */
const undocumentedFunctions = (
  source: ts.SourceFile,
  file: string,
): ReadonlyArray<string> => {
  const failures: Array<string> = [];
  /** 递归检查需要中文说明的声明节点。 */
  const visit = (node: ts.Node): void => {
    const documentedNode = ts.isVariableDeclaration(node) && isFunctionVariable(node)
      ? node.parent.parent
      : node;
    const requiresComment = ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyAssignment(node) &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ||
      ts.isPropertySignature(node) && node.type !== undefined && ts.isFunctionTypeNode(node.type) ||
      ts.isVariableDeclaration(node) && isFunctionVariable(node);
    if (requiresComment && !hasChineseLeadingComment(source, documentedNode)) {
      const position = source.getLineAndCharacterOfPosition(node.getStart(source));
      failures.push(`${relative(process.cwd(), file)}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
};

describe("中文代码说明约束", () => {
  it("每个函数、方法与服务函数签名前都有中文注释", () => {
    const files = listTypeScriptFiles(join(process.cwd(), "src"));
    const failures = files.flatMap((file) => {
      const text = readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
      return undocumentedFunctions(source, file);
    });
    expect(failures).toEqual([]);
  });
});
