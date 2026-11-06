import type { WorkspaceId } from "./ids.js";
import type { GitHubCheckRecord } from "./git.js";

export interface GitHubTarget { readonly workspaceId: WorkspaceId; readonly remote?: string }
export interface GitHubRepository { readonly remote: string; readonly host: string; readonly ownerRepo: string; readonly url: string }
export interface GitHubRepositories { readonly workspaceId: WorkspaceId; readonly repositories: readonly GitHubRepository[] }
export type GitHubItemKind = "issue" | "pr";
export interface GitHubListInput extends GitHubTarget {
  readonly kind: GitHubItemKind;
  readonly state?: "open" | "closed" | "merged" | "all";
  readonly search?: string;
  readonly label?: string;
  readonly assignedToMe?: boolean;
  readonly reviewRequested?: boolean;
  readonly cursor?: string;
}
export interface GitHubItemInput extends GitHubTarget { readonly kind: GitHubItemKind; readonly number: number }
export interface GitHubItem {
  readonly kind: GitHubItemKind;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly state: "open" | "closed" | "merged";
  readonly author: string;
  readonly updatedAt: string;
  readonly labels: readonly string[];
  readonly commentCount: number;
  readonly draft?: boolean;
  readonly headBranch?: string;
  readonly baseBranch?: string;
  readonly headOid?: string;
  readonly reviewDecision?: string;
  readonly checkState?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly changedFiles?: number;
}
export interface GitHubItemPage {
  readonly repository: GitHubRepository;
  readonly items: readonly GitHubItem[];
  readonly totalCount: number;
  readonly nextCursor?: string;
}
export interface GitHubItemDetail { readonly repository: GitHubRepository; readonly item: GitHubItem; readonly checks: readonly GitHubCheckRecord[] }
export interface GitHubComment {
  readonly id: string;
  readonly kind: "comment" | "review" | "inline";
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly url: string;
  readonly state?: string;
  readonly path?: string;
  readonly line?: number;
}
export interface GitHubDiscussionPage { readonly comments: readonly GitHubComment[]; readonly nextPage?: number }
export interface GitHubFile { readonly path: string; readonly previousPath?: string; readonly status: string; readonly additions: number; readonly deletions: number }
export interface GitHubFilesPage { readonly files: readonly GitHubFile[]; readonly nextPage?: number; readonly headOid: string }
export interface GitHubFileDiff { readonly path: string; readonly patch: string; readonly headOid: string; readonly unavailableReason?: string }

/** Self-contained source material; no credentials or executable instructions. */
export interface GitHubReference {
  readonly repository: GitHubRepository;
  readonly item: GitHubItem;
  readonly capturedAt: string;
  readonly comments: readonly GitHubComment[];
  readonly checks: readonly GitHubCheckRecord[];
  readonly diffs: readonly GitHubFileDiff[];
}
