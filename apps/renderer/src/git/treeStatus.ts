/**
 * Git status decorations for the Explorer file tree.
 *
 * The repository read model carries two porcelain columns per file (index +
 * worktree). A tree row can only carry one signal, so states are combined into
 * a single display status here, and statuses are propagated to ancestor
 * directories so collapsed folders still surface descendant changes (the same
 * behaviour as VS Code's explorer decorations). Shared by the real tree and
 * the preview fixtures.
 */

import type { GitFileChange } from "@omp-studio/client-contract";

export type TreeGitStatus = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

/** Folder propagation order: attention-worthy first, noisy newcomers last. */
const PRIORITY: Readonly<Record<TreeGitStatus, number>> = {
  conflicted: 6,
  deleted: 5,
  renamed: 4,
  modified: 3,
  added: 2,
  untracked: 1,
};

export function combineGitFileState(change: GitFileChange): TreeGitStatus | undefined {
  if (change.conflicted || change.index === "conflicted" || change.worktree === "conflicted") return "conflicted";
  if (change.index === "untracked" || change.worktree === "untracked") return "untracked";
  if (change.index === "deleted" || change.worktree === "deleted") return "deleted";
  // Copied entries render like renames — both are "content now lives at a new path".
  if (change.index === "renamed" || change.index === "copied" || change.worktree === "renamed" || change.worktree === "copied") return "renamed";
  if (change.index === "added" || change.worktree === "added") return "added";
  if (change.index === "modified" || change.worktree === "modified") return "modified";
  return undefined;
}

export function buildGitStatusLookup(changes: ReadonlyArray<GitFileChange>): ReadonlyMap<string, TreeGitStatus> {
  const lookup = new Map<string, TreeGitStatus>();
  const raise = (path: string, status: TreeGitStatus): void => {
    const current = lookup.get(path);
    if (current === undefined || PRIORITY[status] > PRIORITY[current]) lookup.set(path, status);
  };
  for (const change of changes) {
    const status = combineGitFileState(change);
    if (status === undefined) continue;
    raise(change.path, status);
    const segments = change.path.split("/");
    segments.pop();
    for (let depth = 1; depth <= segments.length; depth += 1) raise(segments.slice(0, depth).join("/"), status);
  }
  return lookup;
}

export interface GitStatusMeta {
  readonly letter: string;
  readonly className: string;
  readonly label: string;
}

/** 行尾字母徽标 + 文件名着色双通道，不单靠颜色（WCAG color-not-only）。 */
export const GIT_STATUS_META: Readonly<Record<TreeGitStatus, GitStatusMeta>> = {
  modified: { letter: "M", className: "m", label: "已修改" },
  added: { letter: "A", className: "a", label: "已暂存新增" },
  deleted: { letter: "D", className: "d", label: "已删除" },
  renamed: { letter: "R", className: "r", label: "已重命名" },
  untracked: { letter: "U", className: "u", label: "未跟踪" },
  conflicted: { letter: "!", className: "x", label: "存在冲突" },
};
