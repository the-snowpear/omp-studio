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
import { isZh } from "../i18n";
import { workspacePathForRepositoryFile } from "./workspacePaths";

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

export function buildGitStatusLookup(changes: ReadonlyArray<GitFileChange>, workspacePrefix = ""): ReadonlyMap<string, TreeGitStatus> {
  const lookup = new Map<string, TreeGitStatus>();
  const raise = (path: string, status: TreeGitStatus): void => {
    const current = lookup.get(path);
    if (current === undefined || PRIORITY[status] > PRIORITY[current]) lookup.set(path, status);
  };
  for (const change of changes) {
    const path = workspacePathForRepositoryFile(change.path, workspacePrefix);
    if (path === undefined) continue;
    const status = combineGitFileState(change);
    if (status === undefined) continue;
    raise(path, status);
    const segments = path.split("/");
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

const STATUS_LABELS: Readonly<Record<TreeGitStatus, readonly [string, string]>> = {
  modified: ["已修改", "Modified"],
  added: ["已暂存新增", "Staged addition"],
  deleted: ["已删除", "Deleted"],
  renamed: ["已重命名", "Renamed"],
  untracked: ["未跟踪", "Untracked"],
  conflicted: ["存在冲突", "Conflicted"],
};

export function gitStatusLabel(status: TreeGitStatus, zh = isZh()): string {
  const pair = STATUS_LABELS[status];
  return zh ? pair[0] : pair[1];
}

/** Trailing status letter + filename color dual channel (WCAG color-not-only). */
export const GIT_STATUS_META: Readonly<Record<TreeGitStatus, GitStatusMeta>> = {
  modified: { letter: "M", className: "m", get label() { return gitStatusLabel("modified"); } },
  added: { letter: "A", className: "a", get label() { return gitStatusLabel("added"); } },
  deleted: { letter: "D", className: "d", get label() { return gitStatusLabel("deleted"); } },
  renamed: { letter: "R", className: "r", get label() { return gitStatusLabel("renamed"); } },
  untracked: { letter: "U", className: "u", get label() { return gitStatusLabel("untracked"); } },
  conflicted: { letter: "!", className: "x", get label() { return gitStatusLabel("conflicted"); } },
};
