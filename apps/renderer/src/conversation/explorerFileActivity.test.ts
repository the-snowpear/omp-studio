import { describe, expect, it } from "vitest";
import type { ConversationLiveTool } from "@omp-studio/client";
import type { JsonValue } from "@omp-studio/client-contract";
import {
  deriveExplorerFileActivity,
  explorerRowActivity,
  fileActivityMatches,
} from "./explorerFileActivity";

function tool(partial: {
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly status?: ConversationLiveTool["status"];
  readonly arguments?: JsonValue;
}): ConversationLiveTool {
  return {
    toolCallId: partial.toolCallId ?? "t1",
    turnId: "turn-1",
    toolName: partial.toolName,
    status: partial.status ?? "started",
    ...(partial.arguments === undefined ? {} : { arguments: partial.arguments }),
  };
}

describe("deriveExplorerFileActivity", () => {
  it("lights reading for an in-flight Read and writing for Edit", () => {
    const activity = deriveExplorerFileActivity({
      r1: tool({ toolCallId: "r1", toolName: "Read", arguments: { path: "src/a.ts" } }),
      e1: tool({ toolCallId: "e1", toolName: "Edit", status: "updated", arguments: { path: "src/b.ts" } }),
    });
    expect(activity.reading).toEqual(["src/a.ts"]);
    expect(activity.writing).toEqual(["src/b.ts"]);
  });

  it("drops completed and aborted tools", () => {
    const activity = deriveExplorerFileActivity({
      r1: tool({ toolCallId: "r1", toolName: "Read", status: "completed", arguments: { path: "src/a.ts" } }),
      e1: tool({ toolCallId: "e1", toolName: "Write", status: "aborted", arguments: { path: "src/b.ts" } }),
    });
    expect(activity.reading).toEqual([]);
    expect(activity.writing).toEqual([]);
  });

  it("treats inspect_image as reading and ast_edit change files as writing", () => {
    const activity = deriveExplorerFileActivity({
      i1: tool({ toolCallId: "i1", toolName: "inspect_image", arguments: { path: "shot.png" } }),
      a1: tool({
        toolCallId: "a1",
        toolName: "ast_edit",
        arguments: { changes: [{ file: "src/one.ts" }, { file: "src/two.ts" }] },
      }),
    });
    expect(activity.reading).toEqual(["shot.png"]);
    expect(activity.writing).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("ignores grep, glob, and bash", () => {
    const activity = deriveExplorerFileActivity({
      g1: tool({ toolCallId: "g1", toolName: "Grep", arguments: { path: "src/a.ts", pattern: "foo" } }),
      g2: tool({ toolCallId: "g2", toolName: "Glob", arguments: { path: "src/**/*.ts" } }),
      b1: tool({ toolCallId: "b1", toolName: "Bash", arguments: { command: "cat src/a.ts" } }),
    });
    expect(activity.reading).toEqual([]);
    expect(activity.writing).toEqual([]);
  });
});

describe("fileActivityMatches", () => {
  it("matches workspace-relative, absolute, and home-shortened tool paths", () => {
    expect(fileActivityMatches("src/a.ts", ["src/a.ts"], false)).toBe(true);
    expect(fileActivityMatches("src/a.ts", ["D:/Project/omp-studio/src/a.ts"], false)).toBe(true);
    expect(fileActivityMatches("src/a.ts", ["~/Project/omp-studio/src/a.ts"], false)).toBe(true);
    expect(fileActivityMatches("src/a.ts", ["src\\a.ts"], false)).toBe(true);
  });

  it("lights a folder when a descendant is active", () => {
    expect(fileActivityMatches("src", ["src/a.ts"], true)).toBe(true);
    expect(fileActivityMatches("src", ["D:/proj/src/nested/a.ts"], true)).toBe(true);
    expect(fileActivityMatches("src", ["lib/a.ts"], true)).toBe(false);
  });

  it("does not treat same-named files in other directories as a hit", () => {
    expect(fileActivityMatches("app/index.ts", ["lib/index.ts"], false)).toBe(false);
    expect(fileActivityMatches("lib/index.ts", ["app/index.ts"], false)).toBe(false);
    expect(explorerRowActivity("app/index.ts", false, { reading: ["lib/index.ts"], writing: [] }).reading).toBe(false);
  });
});
