export interface CompressionFile { sessionId: string; name: string; bytes: number; allocated: number }
export interface CompressionSummary { supported: boolean; method?: "ntfs" | "apfs"; scanned: number; skippedLive: number; sessions: number; candidates: number; compressed: number; bytes: number; allocatedBefore: number; allocatedAfter: number; files: CompressionFile[]; truncated: boolean; errors: string[] }
export interface CompressionState { phase: "idle" | "scanning" | "ready" | "applying" | "complete" | "failed"; days?: number; token?: string; expiresAt?: number; summary?: CompressionSummary; error?: string }
export type SessionCompressionOperation =
  | { kind: "maintenance.compression.scan"; sessionId: string }
  | { kind: "maintenance.compression.apply"; sessionId: string; token: string }
  | { kind: "maintenance.compression.status"; sessionId: string };
export interface SessionCompressionResultMap { "maintenance.compression.scan": CompressionState; "maintenance.compression.apply": CompressionState; "maintenance.compression.status": CompressionState }
export const SESSION_COMPRESSION_KINDS = ["maintenance.compression.scan", "maintenance.compression.apply", "maintenance.compression.status"] as const;
export function isSessionCompressionKind(kind: string): kind is SessionCompressionOperation["kind"] { return (SESSION_COMPRESSION_KINDS as readonly string[]).includes(kind); }
function object(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid compression data"); return value as Record<string, unknown>; }
function text(value: unknown, max = 1024): void { if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) throw Error("Invalid compression text"); }
function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) throw Error("Invalid compression count"); }
export function validateSessionCompressionOperation(value: unknown): void {
  const row = object(value, ["kind", "sessionId", "token"]); text(row.sessionId, 128);
  if (typeof row.kind !== "string" || !isSessionCompressionKind(row.kind)) throw Error("Unknown compression operation");
  if (row.kind === "maintenance.compression.apply") { text(row.token, 36); if (!/^[a-f0-9-]{36}$/u.test(row.token as string)) throw Error("Invalid compression token"); }
  else if (row.token !== undefined) throw Error("Unexpected compression token");
}
export function validateSessionCompressionResult(_kind: SessionCompressionOperation["kind"], value: unknown): void {
  if (JSON.stringify(value).length > 131072) throw Error("Compression result exceeds limit");
  const row = object(value, ["phase", "days", "token", "expiresAt", "summary", "error"]);
  if (!["idle", "scanning", "ready", "applying", "complete", "failed"].includes(row.phase as string)) throw Error("Invalid compression phase");
  if (row.days !== undefined) count(row.days); if (row.expiresAt !== undefined) count(row.expiresAt); if (row.token !== undefined) text(row.token, 36); if (row.error !== undefined) text(row.error);
  if (row.summary === undefined) return;
  const s = object(row.summary, ["supported", "method", "scanned", "skippedLive", "sessions", "candidates", "compressed", "bytes", "allocatedBefore", "allocatedAfter", "files", "truncated", "errors"]);
  if (typeof s.supported !== "boolean" || typeof s.truncated !== "boolean" || s.method !== undefined && !["ntfs", "apfs"].includes(s.method as string)) throw Error("Invalid filesystem compression support");
  for (const key of ["scanned", "skippedLive", "sessions", "candidates", "compressed", "bytes", "allocatedBefore", "allocatedAfter"]) count(s[key]);
  if (!Array.isArray(s.files) || s.files.length > 200 || !Array.isArray(s.errors) || s.errors.length > 20) throw Error("Compression inventory exceeds limit");
  s.errors.forEach(item => text(item));
  for (const value of s.files) { const file = object(value, ["sessionId", "name", "bytes", "allocated"]); text(file.sessionId, 128); text(file.name, 512); count(file.bytes); count(file.allocated); }
}
