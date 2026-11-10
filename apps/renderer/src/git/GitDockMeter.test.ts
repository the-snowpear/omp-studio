import { describe, expect, it } from "vitest";
import type { GitRepositoryReadModel, WorkspaceId } from "@omp-studio/client-contract";
import { buildGitDockMeter } from "./GitDockMeter";

const base = { loading: false, error: undefined, preview: false, marks: false, zh: true } as const;

function repository(overrides: Partial<GitRepositoryReadModel> = {}): GitRepositoryReadModel {
  return { workspaceId: "ws" as WorkspaceId, isRepository: true, detached: false, unborn: false, ahead: 0, behind: 0, stashCount: 0, changes: [], ...overrides };
}

describe("folded Git card summary", () => {
  it("counts changed files by status and keeps ahead/behind beside them", () => {
    const meter = buildGitDockMeter({ ...base, repository: repository({
      ahead: 2, behind: 1,
      changes: [
        { path: "a.ts", index: "unmodified", worktree: "modified", conflicted: false },
        { path: "b.ts", index: "added", worktree: "unmodified", conflicted: false },
        { path: "c.ts", index: "unmodified", worktree: "untracked", conflicted: false },
      ],
    }) });
    expect(meter.total).toBe(3);
    expect(meter.counts.map(item => [item.id, item.label, item.count])).toEqual([["modified", "M", 1], ["added", "A", 1], ["untracked", "U", 1]]);
    expect(meter.note).toBe("↑2 ↓1");
    expect(meter.label).toBe("3 个文件改动 · ↑2 ↓1");
    expect(meter.badge).toBeUndefined();
  });

  it("keeps a clean tree, conflicts and missing repositories readable while folded", () => {
    expect(buildGitDockMeter({ ...base, repository: repository() }).emptyLabel).toBe("工作区干净");
    expect(buildGitDockMeter({ ...base, repository: repository({
      changes: [{ path: "a.ts", index: "conflicted", worktree: "conflicted", conflicted: true }],
    }) }).tone).toBe("danger");
    expect(buildGitDockMeter({ ...base, loading: true, repository: undefined }).emptyLabel).toBe("读取中");
    expect(buildGitDockMeter({ ...base, repository: undefined }).emptyLabel).toBe("未连接");
    const failed = buildGitDockMeter({ ...base, repository: undefined, error: "git 不可用" });
    expect(failed.label).toBe("不可用");
    expect(failed.stale).toBe(true);
    expect(buildGitDockMeter({ ...base, repository: repository({ isRepository: false }) }).emptyLabel).toBe("非 Git 仓库");
  });
});
