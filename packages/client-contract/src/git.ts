/**
 * Public Git and GitHub read models.
 *
 * The Host owns executable discovery, repository paths and credentials. These
 * shapes contain only opaque ids, workspace-relative paths and bounded display
 * text; they are safe for Desktop IPC and the browser Renderer.
 */

import type { CommandRequestId, GitRepositoryId, GitWorktreeId, WorkspaceId } from "./ids.js";

export type GitFileState =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted";

export interface GitToolRecord {
  readonly available: boolean;
  readonly version?: string;
  readonly unavailableReason?: string;
}

export interface GitToolchainReadModel {
  readonly git: GitToolRecord;
  readonly githubCli: GitToolRecord;
}

export interface GitFileChange {
  /** Normalized repository-relative path using forward slashes. */
  readonly path: string;
  readonly originalPath?: string;
  readonly index: GitFileState;
  readonly worktree: GitFileState;
  readonly conflicted: boolean;
}

export interface GitRepositoryReadModel {
  readonly workspaceId: WorkspaceId;
  readonly isRepository: boolean;
  readonly repositoryId?: GitRepositoryId;
  readonly worktreeId?: GitWorktreeId;
  readonly branch?: string;
  readonly headOid?: string;
  readonly detached: boolean;
  readonly unborn: boolean;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly stashCount: number;
  readonly operation?: "merge" | "rebase" | "cherry-pick" | "revert";
  readonly changes: ReadonlyArray<GitFileChange>;
  /** Uncommitted line totals vs HEAD (tracked diff plus untracked files as insertions). Omitted when not computable. */
  readonly insertions?: number;
  readonly deletions?: number;
  /** Opaque state fingerprint used to reject stale destructive actions. */
  readonly revision?: string;
  readonly unavailableReason?: string;
}

export type GitDiffTarget = "working" | "staged";

export interface GitDiffReadModel {
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly target: GitDiffTarget;
  readonly patch: string;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly revision: string;
}

export interface GitBranchRecord {
  readonly name: string;
  readonly remote: boolean;
  readonly current: boolean;
  readonly headOid: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly checkedOutWorktreeId?: GitWorktreeId;
}

export interface GitBranchListReadModel {
  readonly workspaceId: WorkspaceId;
  readonly branches: ReadonlyArray<GitBranchRecord>;
}

export interface GitWorktreeRecord {
  readonly worktreeId: GitWorktreeId;
  readonly name: string;
  readonly branch?: string;
  readonly headOid?: string;
  readonly current: boolean;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason?: string;
  readonly prunable: boolean;
  readonly workspaceId?: WorkspaceId;
}

export interface GitWorktreeListReadModel {
  readonly workspaceId: WorkspaceId;
  readonly rootConfigured: boolean;
  readonly worktrees: ReadonlyArray<GitWorktreeRecord>;
}

export interface GitRemoteRecord {
  readonly name: string;
  readonly fetchUrl: string;
  readonly pushUrl: string;
  readonly host?: string;
  readonly repository?: string;
}

export interface GitRemoteListReadModel {
  readonly workspaceId: WorkspaceId;
  readonly remotes: ReadonlyArray<GitRemoteRecord>;
}

export type GitLogRefKind = "head" | "local" | "remote" | "tag";

export interface GitLogRef {
  readonly name: string;
  readonly kind: GitLogRefKind;
  readonly current: boolean;
}

export type GitLogRelation = "head" | "outgoing" | "incoming" | "common";

export interface GitLogCommitRecord {
  readonly oid: string;
  readonly parents: ReadonlyArray<string>;
  readonly subject: string;
  readonly authorName: string;
  readonly authorDate: string;
  readonly refs: ReadonlyArray<GitLogRef>;
  readonly relation: GitLogRelation;
  readonly insertions?: number;
  readonly deletions?: number;
}

export interface GitLogListReadModel {
  readonly workspaceId: WorkspaceId;
  readonly commits: ReadonlyArray<GitLogCommitRecord>;
  readonly truncated: boolean;
  readonly cursor?: string;
  readonly headOid?: string;
  readonly upstream?: string;
  readonly mergeBaseOid?: string;
  readonly ahead: number;
  readonly behind: number;
}

export type GitCommitChangeStatus = "added" | "modified" | "deleted" | "renamed" | "copied";

export interface GitCommitChangeRecord {
  readonly path: string;
  readonly status: GitCommitChangeStatus;
  readonly originalPath?: string;
}

export interface GitCommitChangesReadModel {
  readonly workspaceId: WorkspaceId;
  readonly oid: string;
  readonly subject: string;
  readonly files: ReadonlyArray<GitCommitChangeRecord>;
}

export interface GitCommitDiffReadModel {
  readonly workspaceId: WorkspaceId;
  readonly oid: string;
  readonly path: string;
  readonly patch: string;
  readonly binary: boolean;
  readonly truncated: boolean;
}

export interface GitOperationResult {
  readonly operation: GitOperation["kind"];
  readonly message: string;
  readonly repository?: GitRepositoryReadModel;
  readonly workspaceId?: WorkspaceId;
  readonly createdWorkspaceId?: WorkspaceId;
  readonly url?: string;
}

export type GitOperation =
  | { readonly kind: "init" }
  | { readonly kind: "clone"; readonly url: string; readonly directoryName?: string }
  | { readonly kind: "stage"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "unstage"; readonly paths: ReadonlyArray<string> }
  | { readonly kind: "discard"; readonly paths: ReadonlyArray<string>; readonly expectedRevision: string }
  | { readonly kind: "commit"; readonly message: string; readonly amend?: boolean; readonly sign?: boolean; readonly paths?: ReadonlyArray<string> }
  | { readonly kind: "branch.create"; readonly name: string; readonly startPoint?: string; readonly checkout?: boolean }
  | { readonly kind: "branch.switch"; readonly name: string }
  | { readonly kind: "branch.rename"; readonly oldName?: string; readonly newName: string }
  | { readonly kind: "branch.delete"; readonly name: string; readonly force?: boolean; readonly expectedRevision?: string }
  | { readonly kind: "worktree.pickRoot" }
  | { readonly kind: "worktree.create"; readonly branch: string; readonly startPoint?: string; readonly createBranch?: boolean; readonly directoryName?: string }
  | { readonly kind: "worktree.lock"; readonly worktreeId: GitWorktreeId; readonly reason?: string }
  | { readonly kind: "worktree.unlock"; readonly worktreeId: GitWorktreeId }
  | { readonly kind: "worktree.remove"; readonly worktreeId: GitWorktreeId; readonly force?: boolean; readonly expectedRevision?: string }
  | { readonly kind: "worktree.prune"; readonly dryRun?: boolean }
  | { readonly kind: "remote.add"; readonly name: string; readonly url: string }
  | { readonly kind: "remote.setUrl"; readonly name: string; readonly url: string; readonly push?: boolean }
  | { readonly kind: "remote.remove"; readonly name: string }
  | { readonly kind: "fetch"; readonly remote?: string; readonly prune?: boolean }
  | { readonly kind: "pull"; readonly strategy: "ff-only" | "rebase" | "merge"; readonly remote?: string; readonly branch?: string }
  | { readonly kind: "push"; readonly remote?: string; readonly branch?: string; readonly setUpstream?: boolean; readonly forceWithLease?: boolean; readonly expectedRemoteOid?: string }
  | { readonly kind: "stash.push"; readonly message?: string; readonly includeUntracked?: boolean }
  | { readonly kind: "stash.apply"; readonly stash?: string; readonly pop?: boolean }
  | { readonly kind: "stash.drop"; readonly stash: string; readonly expectedRevision: string }
  | { readonly kind: "tag.create"; readonly name: string; readonly target?: string; readonly message?: string }
  | { readonly kind: "tag.delete"; readonly name: string }
  | { readonly kind: "merge"; readonly ref: string; readonly noFastForward?: boolean }
  | { readonly kind: "rebase"; readonly ref: string }
  | { readonly kind: "cherry-pick"; readonly ref: string }
  | { readonly kind: "revert"; readonly ref: string }
  | { readonly kind: "checkout"; readonly ref: string }
  | { readonly kind: "reset"; readonly mode: "soft" | "mixed" | "hard"; readonly ref: string; readonly expectedRevision: string }
  | { readonly kind: "continue"; readonly operation: "merge" | "rebase" | "cherry-pick" | "revert" }
  | { readonly kind: "abort"; readonly operation: "merge" | "rebase" | "cherry-pick" | "revert" }
  | { readonly kind: "cancel"; readonly requestId: CommandRequestId };

export interface GitExecuteInput {
  /** Clone is allowed without a current workspace; every other operation requires it. */
  readonly workspaceId?: WorkspaceId;
  readonly operation: GitOperation;
}

export interface GitHubAuthReadModel {
  readonly available: boolean;
  readonly authenticated: boolean;
  readonly host?: string;
  readonly account?: string;
  readonly gitProtocol?: "https" | "ssh";
  readonly unavailableReason?: string;
}

export type GitHubPullRequestState = "open" | "closed" | "merged";

export interface GitHubCheckRecord {
  readonly name: string;
  readonly state: string;
  readonly bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
  readonly link?: string;
  readonly workflow?: string;
}

export interface GitHubPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly state: GitHubPullRequestState;
  readonly draft: boolean;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly headOid?: string;
  readonly author?: string;
  readonly url: string;
  readonly reviewDecision?: string;
  readonly mergeState?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
  readonly updatedAt?: string;
}

export interface GitHubPullRequestListReadModel {
  readonly workspaceId: WorkspaceId;
  readonly pullRequests: ReadonlyArray<GitHubPullRequestRecord>;
}

export interface GitHubPullRequestDetailReadModel {
  readonly workspaceId: WorkspaceId;
  readonly pullRequest: GitHubPullRequestRecord;
  readonly checks: ReadonlyArray<GitHubCheckRecord>;
}

export interface GitHubChecksReadModel {
  readonly workspaceId: WorkspaceId;
  readonly pullRequestNumber: number;
  readonly checks: ReadonlyArray<GitHubCheckRecord>;
  readonly overall: "pass" | "fail" | "pending" | "neutral";
}

export type GitHubOperation =
  | { readonly kind: "auth.login"; readonly host?: string; readonly gitProtocol?: "https" | "ssh" }
  | { readonly kind: "auth.logout"; readonly host?: string }
  | { readonly kind: "pr.create"; readonly title: string; readonly body: string; readonly base: string; readonly head?: string; readonly draft?: boolean }
  | { readonly kind: "pr.edit"; readonly number: number; readonly title?: string; readonly body?: string; readonly base?: string }
  | { readonly kind: "pr.ready"; readonly number: number; readonly undo?: boolean }
  | { readonly kind: "pr.comment"; readonly number: number; readonly body: string }
  | { readonly kind: "pr.review"; readonly number: number; readonly decision: "approve" | "comment" | "request-changes"; readonly body?: string }
  | { readonly kind: "pr.updateBranch"; readonly number: number; readonly rebase?: boolean }
  | { readonly kind: "pr.merge"; readonly number: number; readonly method: "merge" | "squash" | "rebase"; readonly expectedHeadOid: string; readonly auto?: boolean; readonly deleteBranch?: boolean }
  | { readonly kind: "pr.close"; readonly number: number; readonly comment?: string; readonly deleteBranch?: boolean }
  | { readonly kind: "pr.reopen"; readonly number: number }
  | { readonly kind: "pr.checkout"; readonly number: number }
  | { readonly kind: "cancel"; readonly requestId: CommandRequestId };

export interface GitHubExecuteInput {
  readonly workspaceId?: WorkspaceId;
  readonly operation: GitHubOperation;
}

export interface GitHubOperationResult {
  readonly operation: GitHubOperation["kind"];
  readonly message: string;
  readonly url?: string;
  readonly pullRequest?: GitHubPullRequestRecord;
}

export interface OperationProgress {
  readonly requestId: CommandRequestId;
  readonly domain: "git" | "github";
  readonly phase: string;
  readonly message: string;
  readonly percent?: number;
}

export interface GitRepositoryChanged {
  readonly workspaceId: WorkspaceId;
  readonly repositoryId?: GitRepositoryId;
  readonly revision?: string;
  readonly reason: "command" | "workspace" | "external";
}
