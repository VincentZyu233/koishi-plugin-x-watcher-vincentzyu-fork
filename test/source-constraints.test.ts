import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function forbiddenKind(node: ts.Node): string | null {
  switch (node.kind) {
    case ts.SyntaxKind.AnyKeyword:
      return "any 类型";
    case ts.SyntaxKind.UnknownKeyword:
      return "unknown 类型";
    case ts.SyntaxKind.AsExpression:
    case ts.SyntaxKind.TypeAssertionExpression:
      return "类型断言";
    case ts.SyntaxKind.NonNullExpression:
      return "非空断言";
    case ts.SyntaxKind.QuestionDotToken:
      return "可选链";
    default:
      return null;
  }
}

function inspectFile(file: string): Violation[] {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations: Violation[] = [];
  const visit = (node: ts.Node): void => {
    const kind = forbiddenKind(node);
    if (kind !== null) {
      const position = source.getLineAndCharacterOfPosition(node.getStart());
      violations.push({ file, line: position.line + 1, kind });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

describe("源码语法约束", () => {
  it("不使用 any、unknown、类型断言、非空断言或可选链", () => {
    const root = new URL("../src", import.meta.url).pathname;
    const violations = sourceFiles(root).flatMap(inspectFile);
    expect(violations).toEqual([]);
  });
});
