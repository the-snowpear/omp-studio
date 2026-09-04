import { describe, expect, it } from "vitest";

import type { AssistantSegment, ToolView } from "./conversationViewModel";
import { sessionFileDiffs } from "./sessionDiff";

function segments(...tools: ToolView[]): AssistantSegment[] {
  return [{ type: "batch", key: "tools", tools }];
}

describe("sessionFileDiffs", () => {
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
});
