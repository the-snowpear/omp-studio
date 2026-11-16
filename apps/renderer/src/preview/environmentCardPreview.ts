import type { GitFileChange, GitRepositoryReadModel, WorkspaceId } from "@omp-studio/client-contract";
import type { EnvironmentCardInput } from "../environment/environmentCardModel";
import { isZh } from "../i18n";
import { getPreviewGit } from "./fixtures";

/** Demo workspace never leaves the renderer; it only fills `workspaceId`. */
const PREVIEW_WORKSPACE = "preview-environment" as WorkspaceId;

function previewChanges(zh = isZh()): GitFileChange[] {
  const git = getPreviewGit(zh);
  const file = (entry: { readonly path: string; readonly status: string }): GitFileChange => ({
    path: entry.path,
    index: entry.status === "新增" || entry.status === "Added" ? "added" : "unmodified",
    worktree: entry.status === "未跟踪" || entry.status === "Untracked" ? "untracked" : "modified",
    conflicted: false,
  });
  return [...git.staged.map(file), ...git.working.map(file)];
}

/**
 * The environment card's demo read models. Same shape the Host publishes, so
 * the card renders through exactly one code path in preview and real mode —
 * only the numbers differ.
 */
export function getPreviewEnvironmentRepository(zh = isZh()): GitRepositoryReadModel {
  const git = getPreviewGit(zh);
  return {
    workspaceId: PREVIEW_WORKSPACE,
    isRepository: true,
    branch: git.branch,
    detached: false,
    unborn: false,
    upstream: "origin/main",
    ahead: git.ahead,
    behind: git.behind,
    stashCount: 0,
    changes: previewChanges(zh),
    insertions: 42,
    deletions: 7,
  };
}

export const PREVIEW_ENVIRONMENT_REPOSITORY: GitRepositoryReadModel = getPreviewEnvironmentRepository();

export function previewEnvironmentCard(project?: { readonly name: string; readonly root?: string } | undefined, zh = isZh()): EnvironmentCardInput {
  return {
    target: { name: "build-box", remote: false },
    runtimeStatus: "connected",
    version: "v0.82.1",
    ...(project === undefined ? {} : { project }),
    repository: { repository: getPreviewEnvironmentRepository(zh), loading: false },
  };
}
