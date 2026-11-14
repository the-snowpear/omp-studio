export interface SessionResumeRow {
  sessionId: string;
  title: string;
  modifiedAt: string;
  currentDirectory: boolean;
  continuationOf?: string;
  directoryName?: string;
  messageCount?: number;
  status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
  firstMessage?: string;
  conversationExcerpt?: string;
}
export interface SessionWorktreeRow { id: string; branch: string; directory: string; sessionId: string; current: boolean; dirty: boolean; hasCommits: boolean; detached: boolean; missing: boolean; reason?: string }
export interface WorktreeStartPolicy { eligible: boolean; policy: "off" | "ask" | "create"; reason?: string }
export interface WorktreeRemovalPreview { token: string; expiresAt: number; worktree: SessionWorktreeRow; keepBranch: boolean }
export type SessionWorktreeOperation =
  | { kind: "worktrees.session.resume.list"; sessionId: string; scope?: "directory" | "repo" }
  | { kind: "worktrees.session.resume.prepare"; sessionId: string; targetSessionId: string; scope: "directory" | "repo" }
  | { kind: "worktrees.session.list"; sessionId: string }
  | { kind: "worktrees.session.startPolicy"; sessionId: string }
  | { kind: "worktrees.session.continueHere"; sessionId: string }
  | { kind: "worktrees.session.create"; sessionId: string; branch?: string; keepChanges?: boolean; freshOnly?: boolean }
  | { kind: "worktrees.session.open"; sessionId: string; id: string }
  | { kind: "worktrees.session.remove.prepare"; sessionId: string; id: string }
  | { kind: "worktrees.session.remove.apply"; sessionId: string; token: string };
export interface SessionWorktreeResultMap {
  "worktrees.session.resume.list": { scope: "directory" | "repo"; sessions: SessionResumeRow[]; truncated: boolean };
  "worktrees.session.resume.prepare": { targetSessionId: string; requestedSessionId: string; workspaceId?: string; cwd?: string };
  "worktrees.session.list": { worktrees: SessionWorktreeRow[]; truncated: boolean };
  "worktrees.session.startPolicy": WorktreeStartPolicy;
  "worktrees.session.continueHere": { continued: true };
  "worktrees.session.create": { worktree: SessionWorktreeRow; workspaceId?: string; cwd?: string };
  "worktrees.session.open": { workspaceId?: string; cwd?: string };
  "worktrees.session.remove.prepare": WorktreeRemovalPreview;
  "worktrees.session.remove.apply": { removed: boolean; messages: string[] };
}
export const SESSION_WORKTREE_KINDS = ["worktrees.session.resume.list", "worktrees.session.resume.prepare","worktrees.session.list", "worktrees.session.startPolicy", "worktrees.session.continueHere", "worktrees.session.create", "worktrees.session.open", "worktrees.session.remove.prepare", "worktrees.session.remove.apply"] as const;
export function isSessionWorktreeKind(kind: string): kind is SessionWorktreeOperation["kind"] { return (SESSION_WORKTREE_KINDS as readonly string[]).includes(kind); }
