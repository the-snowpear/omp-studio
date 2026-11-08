import { describe, expect, it } from "vitest";
import { parsePatchMarks } from "./gitMarks";

describe("parsePatchMarks", () => {
  it("separates added, modified and deleted lines on the working-tree side", () => {
    const patch = [
      "diff --git a/src/main.ts b/src/main.ts",
      "index 1111111..2222222 100644",
      "--- a/src/main.ts",
      "+++ b/src/main.ts",
      "@@ -1,6 +1,7 @@",
      " // OMP Studio",
      "-export function hello(name) {",
      "+export function hello(name: string) {",
      "+  const trimmed = name.trim();",
      "   return `Hello, ${name}`;",
      " }",
      "-",
      "-// legacy",
      " export {};",
      "@@ -20,2 +21,3 @@",
      " const a = 1;",
      "+const b = 2;",
      " const c = 3;",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parsePatchMarks(patch)).toEqual({ added: [22], modified: [2, 3], deleted: [5], additions: 3, deletions: 3 });
  });

  it("anchors a deletion at the top of the file to line 1", () => {
    expect(parsePatchMarks("@@ -1,2 +1,1 @@\n-gone\n kept\n").deleted).toEqual([1]);
  });
});
