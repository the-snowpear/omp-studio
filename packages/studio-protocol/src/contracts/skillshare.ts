export type SkillshareAction =
  | { type: "install"; specs: string[]; scope: "project" | "user" }
  | { type: "update"; names: string[]; scope: "project" | "user" }
  | { type: "uninstall"; names: string[]; scope: "project" | "user" }
  | { type: "publish"; directory: string; scope: string; tag?: string }
  | { type: "import"; file: string }
  | { type: "version"; directory: string; bump: string }
  | { type: "tag.set"; package: string; tag: string; version: string }
  | { type: "tag.remove"; package: string; tag: string }
  | { type: "yank"; package: string; version: string; yanked: boolean }
  | { type: "deprecate"; package: string; version: string; message: string | null }
  | { type: "owner.add"; package: string; username: string }
  | { type: "owner.remove"; package: string; username: string }
  | { type: "token.create"; name: string; packages: string[]; expiresInDays?: number }
  | { type: "token.revoke"; id: string }
  | { type: "reload" };
export interface SkillshareHit { package: string; description: string; version: string; downloads: number; updatedAt: number; deprecated?: string }
export interface SkillshareVersion { version: string; integrity: string; bytes: number; fileCount: number; hasScripts: boolean; yanked: boolean; deprecated?: string; publishedAt: number }
export interface SkillshareFile { path: string; size: number; executable: boolean }
export interface SkillshareToken { id: string; name: string; packages: string[]; createdAt: number; expiresAt?: number; lastUsedAt?: number }
export interface SkillshareInstalled { package: string; scope: "project" | "user"; range?: string; version?: string; stored: boolean }
export interface SkillshareReview {
  id: string; digest: string; expiresAt: number; action: SkillshareAction; registry: string; remoteWrite: boolean;
  changes: Array<{ package: string; from?: string; to?: string; range?: string; integrity?: string }>;
  files: SkillshareFile[]; filesTotal: number;
  scripts: string[]; secrets: Array<{ path: string; line: number; kind: string }>;
  warnings: string[]; sourceDigest?: string;
}
export interface SkillshareActionState { id: string; type: SkillshareAction["type"]; state: "ready" | "running" | "completed" | "failed" | "uncertain"; message?: string; secretId?: string; link?: string }
export type SkillshareOperation =
  | { kind: "skillshare.status"; sessionId: string }
  | { kind: "skillshare.home"; sessionId: string }
  | { kind: "skillshare.search"; sessionId: string; query: string; sort?: "relevance" | "downloads" | "recent"; page?: number }
  | { kind: "skillshare.package"; sessionId: string; package: string; version?: string; offset?: number }
  | { kind: "skillshare.installed"; sessionId: string; offset?: number }
  | { kind: "skillshare.tokens"; sessionId: string }
  | { kind: "skillshare.prepare"; sessionId: string; action: SkillshareAction }
  | { kind: "skillshare.execute"; sessionId: string; id: string; digest: string; allowScripts: boolean; allowSecrets: boolean }
  | { kind: "skillshare.action"; sessionId: string; id: string }
  | { kind: "skillshare.discard"; sessionId: string; id: string };
export interface SkillshareResultMap {
  "skillshare.status": { registry: string; accountAuthenticated: boolean; publishAuthenticated: boolean; privateTokenChannel: boolean; actions: SkillshareActionState[] };
  "skillshare.home": { stats: { packages: number; versions: number; publishers: number; weeklyDownloads: number }; recent: SkillshareHit[]; popular: SkillshareHit[]; trending: SkillshareHit[] };
  "skillshare.search": { hits: SkillshareHit[]; total: number; page: number; perPage: number };
  "skillshare.package": { package: string; description: string; keywords: string[]; owners: string[]; tags: Record<string, string>; versions: SkillshareVersion[]; totalVersions: number; nextOffset?: number; selected?: { version: SkillshareVersion; files: SkillshareFile[]; publisher: string; provenance: string } };
  "skillshare.installed": { skills: SkillshareInstalled[]; total: number; nextOffset?: number };
  "skillshare.tokens": { tokens: SkillshareToken[] };
  "skillshare.prepare": { review: SkillshareReview };
  "skillshare.execute": { action: SkillshareActionState };
  "skillshare.action": { action: SkillshareActionState };
  "skillshare.discard": { discarded: boolean };
}
export const SKILLSHARE_OPERATION_KINDS = ["skillshare.status", "skillshare.home", "skillshare.search", "skillshare.package", "skillshare.installed", "skillshare.tokens", "skillshare.prepare", "skillshare.execute", "skillshare.action", "skillshare.discard"] as const;
export function isSkillshareOperationKind(kind: string): kind is SkillshareOperation["kind"] { return (SKILLSHARE_OPERATION_KINDS as readonly string[]).includes(kind); }
