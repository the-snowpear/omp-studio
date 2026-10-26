// Ordinary product selectors must use AppSelect so the popup follows the app theme.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";

const root = fileURLToPath(new URL("../apps/renderer/src/", import.meta.url));
const allowed = new Map([
  ["graphics-harness-entry.tsx", "Development-only graphics sample selector; not part of the workbench."],
]);
const failures = [];
for (const file of readdirSync(root, { recursive: true }).filter(file => /\.[jt]sx$/.test(file) && !/\.test\.[jt]sx$/.test(file))) {
  const name = relative(root, join(root, file)).replaceAll("\\", "/");
  if (allowed.has(name)) continue;
  const source = ts.createSourceFile(name, readFileSync(join(root, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function visit(node) {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === "select") {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      failures.push(`${name}:${line}: use AppSelect for ordinary single-select controls.`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Renderer select check passed.");
