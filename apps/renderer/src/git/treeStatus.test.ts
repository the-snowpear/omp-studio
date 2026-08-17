import { describe, expect, it } from "vitest";

import type { GitFileChange } from "@omp-studio/client-contract";

import { buildGitStatusLookup, combineGitFileState, GIT_STATUS_META } from "./treeStatus.js";

function change(path: string, index: GitFileChange["index"], worktree: GitFileChange["worktree"], extra: Partial<GitFileChange> = {}): GitFileChange {
  return { path, index, worktree, conflicted: false, ...extra };
}

describe("combineGitFileState", () => {
  it("prefers conflicted over everything else", () => {
    expect(combineGitFileState(change("a.ts", "modified", "modified", { conflicted: true }))).toBe("conflicted");
    expect(combineGitFileState(change("a.ts", "conflicted", "unmodified"))).toBe("conflicted");
  });

  it("maps untracked, deleted, renamed and copied from either column", () => {
    expect(combineGitFileState(change("a.ts", "unmodified", "untracked"))).toBe("untracked");
    expect(combineGitFileState(change("a.ts", "deleted", "unmodified"))).toBe("deleted");
    expect(combineGitFileState(change("a.ts", "renamed", "unmodified"))).toBe("renamed");
    expect(combineGitFileState(change("a.ts", "copied", "modified"))).toBe("renamed");
  });

  it("shows added while a staged new file keeps changing in the worktree", () => {
    expect(combineGitFileState(change("a.ts", "added", "modified"))).toBe("added");
  });

  it("collapses staged plus worktree edits into modified", () => {
    expect(combineGitFileState(change("a.ts", "modified", "modified"))).toBe("modified");
    expect(combineGitFileState(change("a.ts", "unmodified", "modified"))).toBe("modified");
  });

  it("returns undefined for unmodified rows", () => {
    expect(combineGitFileState(change("a.ts", "unmodified", "unmodified"))).toBeUndefined();
  });
});

describe("buildGitStatusLookup", () => {
  it("propagates statuses to every ancestor directory", () => {
    const lookup = buildGitStatusLookup([change("packages/client/src/index.ts", "unmodified", "modified")]);
    expect(lookup.get("packages/client/src/index.ts")).toBe("modified");
    expect(lookup.get("packages/client/src")).toBe("modified");
    expect(lookup.get("packages/client")).toBe("modified");
    expect(lookup.get("packages")).toBe("modified");
    expect(lookup.has("apps")).toBe(false);
  });

  it("keeps the highest-priority status per folder and per file", () => {
    const lookup = buildGitStatusLookup([
      change("src/new.ts", "unmodified", "untracked"),
      change("src/gone.ts", "unmodified", "deleted"),
      change("src/lib/renamed.ts", "renamed", "unmodified"),
    ]);
    expect(lookup.get("src")).toBe("deleted");
    expect(lookup.get("src/lib")).toBe("renamed");
    expect(lookup.get("src/new.ts")).toBe("untracked");
  });

  it("resolves sibling conflicts at the shared parent", () => {
    const lookup = buildGitStatusLookup([
      change("src/a.ts", "unmodified", "modified"),
      change("src/b.ts", "conflicted", "unmodified"),
    ]);
    expect(lookup.get("src")).toBe("conflicted");
  });

  it("skips unmodified entries and stays empty for a clean repository", () => {
    expect(buildGitStatusLookup([change("a.ts", "unmodified", "unmodified")]).size).toBe(0);
    expect(buildGitStatusLookup([]).size).toBe(0);
  });
});

describe("GIT_STATUS_META", () => {
  it("covers every status with letter, class and label", () => {
    for (const meta of Object.values(GIT_STATUS_META)) {
      expect(meta.letter).toMatch(/^[\w!]$/u);
      expect(["m", "a", "d", "r", "u", "x"]).toContain(meta.className);
      expect(meta.label).toBeTruthy();
    }
    expect(new Set(Object.values(GIT_STATUS_META).map((meta) => meta.className)).size).toBe(Object.keys(GIT_STATUS_META).length);
    expect(new Set(Object.values(GIT_STATUS_META).map((meta) => meta.letter)).size).toBe(Object.keys(GIT_STATUS_META).length);
  });
});
