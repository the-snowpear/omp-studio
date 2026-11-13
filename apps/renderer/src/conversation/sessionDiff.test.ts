import { describe, expect, it } from "vitest";

import type { JsonValue } from "@omp-studio/client-contract";
import type { AssistantSegment, ToolView } from "./conversationViewModel";
import { sessionFileDiffs } from "./sessionDiff";
import { collectTurnFileChanges, toolDiffStats } from "./toolMeta";

function segments(...tools: ToolView[]): AssistantSegment[] {
  return [{ type: "batch", key: "tools", tools }];
}

function nativeResult(data: JsonValue, status: "succeeded" | "failed" = "succeeded"): ToolView {
  return {
    toolCallId: "native-edit", toolName: "edit", status,
    arguments: { path: "src/submitted.ts", diff: "+1|submitted, not applied", perFileResults: [{ path: "src/forged.ts", diff: "+1|forged" }] },
    result: { type: "toolResult", toolCallId: "native-edit", isError: status === "failed", data },
  };
}

describe("sessionFileDiffs", () => {
  it("excludes process control and peer messaging from workspace changes while retaining Windows file paths", () => {
    const paths = ["proc://server/kill", "agent://reviewer", "omp://tools/read.md", "local://generated.txt", "D:\\project\\actual.txt"];
    const diffs = sessionFileDiffs(segments(...paths.map((path, index) => ({ toolCallId: String(index), toolName: "write", status: "succeeded" as const, arguments: { path, content: "hello" } }))));
    expect([...diffs.keys()]).toEqual(["D:/project/actual.txt"]);
  });
  it("projects edit and write tool payloads into numbered hunks", () => {
    const diffs = sessionFileDiffs(segments(
      {
        toolCallId: "edit-1",
        toolName: "edit",
        status: "succeeded",
        arguments: { path: "src/a.ts", diff: [["-", 1, "", "old"], ["+", "", 1, "new"]] },
      },
      {
        toolCallId: "write-1",
        toolName: "write",
        status: "succeeded",
        arguments: { path: "src/new.ts", content: "first\nsecond" },
      },
    ));

    expect(diffs.get("src/a.ts")?.hunks).toEqual([{
      hunkLabel: "@@ Edit · 1/1 @@",
      lines: [
        { kind: "row", mark: "-", oldLn: "1", newLn: "", text: "old" },
        { kind: "row", mark: "+", oldLn: "", newLn: "1", text: "new" },
      ],
    }]);
    expect(diffs.get("src/new.ts")?.hunks[0]?.lines).toEqual([
      { kind: "row", mark: "+", oldLn: "", newLn: "1", text: "first" },
      { kind: "row", mark: "+", oldLn: "", newLn: "2", text: "second" },
    ]);
  });

  it("projects ast_edit before/after records per file and ignores failed edits", () => {
    const diffs = sessionFileDiffs(segments(
      {
        toolCallId: "ast-1",
        toolName: "ast_edit",
        status: "succeeded",
        result: {
          type: "toolResult",
          toolCallId: "ast-1",
          isError: false,
          data: { changes: [{ file: "src/a.ts", before: "old", after: "new" }] },
        },
      },
      {
        toolCallId: "edit-failed",
        toolName: "edit",
        status: "failed",
        arguments: { path: "src/failed.ts", diff: "+1|nope" },
      },
    ));

    expect(diffs.get("src/a.ts")?.hunks[0]?.lines).toEqual([
      { kind: "row", mark: "-", oldLn: "", newLn: "", text: "old" },
      { kind: "row", mark: "+", oldLn: "", newLn: "", text: "new" },
    ]);
    expect(diffs.has("src/failed.ts")).toBe(false);
  });

  it("uses per-file native results for every applied path, hunk and statistic instead of aggregate or input fields", () => {
    const tool = nativeResult({ path: "src/aggregate.ts", diff: "+1|aggregate is not per-file evidence", perFileResults: [
      { path: "src/a.ts", op: "update", diff: "-2|old\n+2|new" },
      { path: "src/b.ts", op: "create", diff: "+1|created" },
    ] });
    const source = segments(tool);
    const diffs = sessionFileDiffs(source);
    expect([...diffs.keys()]).toEqual(["src/a.ts", "src/b.ts"]);
    expect(diffs.get("src/a.ts")?.hunks[0]?.lines).toEqual([
      { kind: "row", mark: "-", oldLn: "2", newLn: "", text: "old" },
      { kind: "row", mark: "+", oldLn: "", newLn: "2", text: "new" },
    ]);
    expect(collectTurnFileChanges(source).map(file => [file.path, file.add, file.del, file.status])).toEqual([
      ["src/a.ts", 1, 1, "modified"], ["src/b.ts", 1, 0, "added"],
    ]);
    expect(toolDiffStats(tool)).toEqual({ add: 2, del: 1 });
  });

  it("keeps confirmed successes from a historical partial result but excludes rejected files and marks the applied part", () => {
    const tool = nativeResult({ perFileResults: [
      { path: "src/applied.ts", diff: "-1|before\n+1|after", isError: false },
      { path: "src/rejected.ts", diff: "+1|not written", isError: true, errorText: "rejected" },
      { path: "src/legacy-rejection.ts", diff: "", displayErrorText: "legacy rejection" },
    ] }, "failed");
    const source = segments(tool);
    expect([...sessionFileDiffs(source).keys()]).toEqual(["src/applied.ts"]);
    expect(sessionFileDiffs(source).get("src/applied.ts")?.partial).toBe(true);
    expect(collectTurnFileChanges(source)).toMatchObject([{ path: "src/applied.ts", add: 1, del: 1, partial: true }]);
    expect(toolDiffStats(tool)).toEqual({ add: 1, del: 1 });
  });

  it.each(["succeeded", "failed"] as const)("an authoritative empty native result never reconstructs applied files from submitted fields (%s)", status => {
    const tool = nativeResult({ perFileResults: [], path: "src/legacy-fallback.ts", diff: "+1|not evidence" }, status);
    expect([...sessionFileDiffs(segments(tool)).keys()]).toEqual([]);
    expect(collectTurnFileChanges(segments(tool))).toEqual([]);
    expect(toolDiffStats(tool)).toEqual({ add: 0, del: 0 });
  });

  it("keeps single-path legacy results readable, preferring the result's resolved path and diff over submitted values", () => {
    const tool = nativeResult({ path: "src/legacy.ts", diff: "-4|old\n+4|native result" });
    const diffs = sessionFileDiffs(segments(tool));
    expect([...diffs.keys()]).toEqual(["src/legacy.ts"]);
    expect(diffs.get("src/legacy.ts")?.hunks[0]?.lines[1]).toMatchObject({ mark: "+", newLn: "4", text: "native result" });
    expect(toolDiffStats(tool)).toEqual({ add: 1, del: 1 });
  });

  it("numbers unified per-file hunks from native headers and keeps full returned statistics when the display is capped", () => {
    const numbered = nativeResult({ perFileResults: [{ path: "src/numbered.ts", diff: "@@ -3,2 +3,3 @@\n keep\n-old\n+new\n+extra\n" }] });
    const rows = sessionFileDiffs(segments(numbered)).get("src/numbered.ts")?.hunks[0]?.lines;
    expect(rows).toEqual([
      { kind: "row", mark: " ", oldLn: "3", newLn: "3", text: "keep" },
      { kind: "row", mark: "-", oldLn: "4", newLn: "", text: "old" },
      { kind: "row", mark: "+", oldLn: "", newLn: "4", text: "new" },
      { kind: "row", mark: "+", oldLn: "", newLn: "5", text: "extra" },
    ]);
    const large = nativeResult({ perFileResults: [{ path: "src/large.ts", diff: Array.from({ length: 510 }, (_, index) => `+${index + 1}|added`).join("\n") }] });
    const shown = sessionFileDiffs(segments(large)).get("src/large.ts");
    expect(shown?.hunks[0]?.lines).toHaveLength(500);
    expect(shown?.truncated).toBe(true);
    expect(toolDiffStats(large)).toEqual({ add: 510, del: 0 });
  });

  it("uses the native final move destination even when no text hunk was produced", () => {
    const tool = nativeResult({ perFileResults: [{ path: "src/old.ts", move: "src/moved.ts", sourcePath: "src/old.ts", op: "update", diff: "" }] });
    expect([...sessionFileDiffs(segments(tool)).keys()]).toEqual(["src/moved.ts"]);
    expect(sessionFileDiffs(segments(tool)).get("src/moved.ts")?.hunks).toEqual([]);
    expect(collectTurnFileChanges(segments(tool))).toMatchObject([{ path: "src/moved.ts", add: 0, del: 0, status: "modified" }]);
  });
});
