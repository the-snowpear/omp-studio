import type { GitFileChange, GitRepositoryReadModel, WorkspaceId } from "@omp-studio/client-contract";
import type { EnvironmentCardInput } from "../environment/environmentCardModel";
import { PREVIEW_GIT } from "./fixtures";

/** Demo workspace never leaves the renderer; it only fills `workspaceId`. */
const PREVIEW_WORKSPACE = "preview-environment" as WorkspaceId;

function previewChanges(): GitFileChange[] {
  const file = (entry: { readonly path: string; readonly status: string }): GitFileChange => ({
    path: entry.path,
    index: entry.status === "新增" ? "added" : "unmodified",
    worktree: entry.status === "未跟踪" ? "untracked" : "modified",
    conflicted: false,
  });
  return [...PREVIEW_GIT.staged.map(file), ...PREVIEW_GIT.working.map(file)];
}

/**
 * The environment card's demo read models. Same shape the Host publishes, so
 * the card renders through exactly one code path in preview and real mode —
 * only the numbers differ.
 */
export const PREVIEW_ENVIRONMENT_REPOSITORY: GitRepositoryReadModel = {
  workspaceId: PREVIEW_WORKSPACE,
  isRepository: true,
  branch: PREVIEW_GIT.branch,
  detached: false,
  unborn: false,
  upstream: "origin/main",
  ahead: PREVIEW_GIT.ahead,
  behind: PREVIEW_GIT.behind,
  stashCount: 0,
  changes: previewChanges(),
  insertions: 42,
  deletions: 7,
};

export function previewEnvironmentCard(project?: { readonly name: string; readonly root?: string } | undefined): EnvironmentCardInput {
  return {
    target: { name: "build-box", remote: false },
    runtimeStatus: "connected",
    version: "v0.82.1",
    ...(project === undefined ? {} : { project }),
    repository: { repository: PREVIEW_ENVIRONMENT_REPOSITORY, loading: false },
  };
}
