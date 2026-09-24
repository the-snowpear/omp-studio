import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

function syntax(source: string): unknown {
  const tree = ts.createSourceFile("diagnostics.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): unknown => {
    if (ts.isParenthesizedExpression(node)) return visit(node.expression);
    if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
    const children: unknown[] = [];
    ts.forEachChild(node, (child) => { children.push(visit(child)); });
    const text = (node as ts.Node & { text?: unknown }).text;
    return { kind: node.kind, ...(!ts.isSourceFile(node) && typeof text === "string" ? { text } : {}), children };
  };
  return visit(tree);
}

test("Runtime's independently bundled numerical helper stays identical to the canonical module", async () => {
  const canonical = await readFile(new URL("../../src/performance-diagnostics.ts", import.meta.url), "utf8");
  const mirror = await readFile(new URL("../../../../omp-patch/overlay/packages/coding-agent/src/studio/performance-diagnostics.ts", import.meta.url), "utf8");
  assert.deepEqual(syntax(mirror), syntax(canonical));
});
