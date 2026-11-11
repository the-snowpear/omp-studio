import { describe, expect, it } from "vitest";
import type { GitFileChange } from "@omp-studio/client-contract";
import { buildGitStatusLookup } from "./treeStatus";

const changes: GitFileChange[] = [
  { path: "src/main.ts", index: "unmodified", worktree: "modified", conflicted: false },
  { path: "src/nested/new.ts", index: "unmodified", worktree: "untracked", conflicted: false },
  { path: "src-extra/unrelated.ts", index: "deleted", worktree: "unmodified", conflicted: false },
  { path: "outside.txt", index: "added", worktree: "unmodified", conflicted: false },
];

describe("Explorer Git status paths", () => {
  it("decorates subdirectory workspace files and their folders without importing sibling changes", () => {
    expect([...buildGitStatusLookup(changes, "src")]).toEqual([
      ["main.ts", "modified"], ["nested/new.ts", "untracked"], ["nested", "untracked"],
    ]);
  });

  it("retains repository paths for a root workspace", () => {
    const lookup = buildGitStatusLookup(changes);
    expect(lookup.get("src/main.ts")).toBe("modified");
    expect(lookup.get("src")).toBe("modified");
    expect(lookup.get("outside.txt")).toBe("added");
  });
});
