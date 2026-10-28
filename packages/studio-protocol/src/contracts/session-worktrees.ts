export interface SessionResumeRow { sessionId: string; title: string; modifiedAt: string; currentDirectory: boolean; continuationOf?: string }
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
function object(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid worktree data"); return value as Record<string, unknown>; }
function text(value: unknown, max = 512): void { if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/u.test(value)) throw Error("Invalid worktree text"); }
function uuid(value: unknown): void { text(value, 36); if (!/^[a-f0-9-]{36}$/u.test(value as string)) throw Error("Invalid worktree identity"); }
function flag(value: unknown): void { if (typeof value !== "boolean") throw Error("Invalid worktree flag"); }
function worktree(value: unknown): void { const row = object(value, ["id", "branch", "directory", "sessionId", "current", "dirty", "hasCommits", "detached", "missing", "reason"]); uuid(row.id); text(row.branch); text(row.directory, 4096); text(row.sessionId, 128); for (const key of ["current", "dirty", "hasCommits", "detached", "missing"]) flag(row[key]); if (row.reason !== undefined) text(row.reason, 1024); }
export function validateSessionWorktreeOperation(value: unknown): void {
  const resume = value as { kind?: string; sessionId?: unknown; targetSessionId?: unknown; scope?: unknown };
  if (resume.kind === "worktrees.session.resume.list" || resume.kind === "worktrees.session.resume.prepare") { text(resume.sessionId, 128); if (resume.kind.endsWith("prepare")) text(resume.targetSessionId, 128); if (resume.scope !== undefined && resume.scope !== "directory" && resume.scope !== "repo") throw Error("Invalid resume scope"); return; }
  const row = object(value, ["kind", "sessionId", "id", "branch", "keepChanges", "freshOnly", "token"]); text(row.sessionId, 128);
  if (typeof row.kind !== "string" || !isSessionWorktreeKind(row.kind)) throw Error("Unknown worktree operation");
  if (row.kind === "worktrees.session.create") { object(value, ["kind", "sessionId", "branch", "keepChanges", "freshOnly"]); if (row.branch !== undefined) { text(row.branch, 150); if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(row.branch as string)) throw Error("Invalid branch name"); } if (row.keepChanges !== undefined) flag(row.keepChanges); if (row.freshOnly !== undefined) flag(row.freshOnly); }
  else if (row.kind === "worktrees.session.open" || row.kind === "worktrees.session.remove.prepare") { object(value, ["kind", "sessionId", "id"]); uuid(row.id); }
  else if (row.kind === "worktrees.session.remove.apply") { object(value, ["kind", "sessionId", "token"]); uuid(row.token); }
  else object(value, ["kind", "sessionId"]);
}
export function validateSessionWorktreeResult(kind: SessionWorktreeOperation["kind"], value: unknown): void {
  if (kind === "worktrees.session.resume.list" || kind === "worktrees.session.resume.prepare") return;
  if (JSON.stringify(value).length > 524288) throw Error("Worktree result exceeds limit");
  if (kind === "worktrees.session.continueHere") { if (object(value, ["continued"]).continued !== true) throw Error("Invalid start decision"); return; }
  if (kind === "worktrees.session.list") { const row = object(value, ["worktrees", "truncated"]); flag(row.truncated); if (!Array.isArray(row.worktrees) || row.worktrees.length > 100) throw Error("Invalid worktree list"); row.worktrees.forEach(worktree); return; }
  if (kind === "worktrees.session.startPolicy") { const row = object(value, ["eligible", "policy", "reason"]); flag(row.eligible); if (!["off", "ask", "create"].includes(row.policy as string)) throw Error("Invalid start policy"); if (row.reason !== undefined) text(row.reason, 1024); return; }
  if (kind === "worktrees.session.remove.prepare") { const row = object(value, ["token", "expiresAt", "worktree", "keepBranch"]); uuid(row.token); if (!Number.isSafeInteger(row.expiresAt) || (row.expiresAt as number) < 0) throw Error("Invalid expiry"); worktree(row.worktree); flag(row.keepBranch); return; }
  if (kind === "worktrees.session.remove.apply") { const row = object(value, ["removed", "messages"]); flag(row.removed); if (!Array.isArray(row.messages) || row.messages.length > 20) throw Error("Invalid cleanup messages"); row.messages.forEach(item => text(item, 1024)); return; }
  const row = object(value, kind === "worktrees.session.create" ? ["worktree", "workspaceId", "cwd"] : ["workspaceId", "cwd"]);
  if (kind === "worktrees.session.create") worktree(row.worktree);
  if (row.workspaceId !== undefined) text(row.workspaceId); if (row.cwd !== undefined) text(row.cwd, 4096);
  if (row.workspaceId === undefined && row.cwd === undefined) throw Error("Missing worktree workspace");
}
