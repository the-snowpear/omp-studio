export interface NativeArchiveSession {
 id: string; title: string; project: string; created: string; modified: string; messages: number; status?: string; recap?: string; truncated: boolean;
}
export interface NativeArchiveText { text: string; at: string; sessionId?: string; project?: string; uses?: number; truncated: boolean; }
export interface NativeArchiveList<T> { rows: T[]; truncated: boolean; }
export interface NativeArchiveDetail { session: NativeArchiveSession; recaps: NativeArchiveText[]; prompts: NativeArchiveText[]; truncated: boolean; }
export type ArchiveOperation =
 | { kind: "archive.sessions.list"; sessionId: string; scope: "workspace" | "all" }
 | { kind: "archive.recaps.list"; sessionId: string; scope: "workspace" | "all" }
 | { kind: "archive.prompts.search"; sessionId: string; scope: "workspace" | "all"; query: string }
 | { kind: "archive.session.inspect"; sessionId: string; targetSessionId: string };
export interface ArchiveResultMap {
 "archive.sessions.list": NativeArchiveList<NativeArchiveSession>;
 "archive.recaps.list": NativeArchiveList<NativeArchiveText>;
 "archive.prompts.search": NativeArchiveList<NativeArchiveText>;
 "archive.session.inspect": NativeArchiveDetail;
}
export const ARCHIVE_OPERATION_KINDS = ["archive.sessions.list", "archive.recaps.list", "archive.prompts.search", "archive.session.inspect"] as const;
export function isArchiveOperationKind(kind: string): kind is ArchiveOperation["kind"] { return (ARCHIVE_OPERATION_KINDS as readonly string[]).includes(kind); }
function record(value: unknown, keys: string[]): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid Archive data");
 return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): void {
 if (typeof value !== "string" || (!empty && !value.length) || value.length > limit || value.includes("\0")) throw new Error("Invalid Archive text");
}
function flag(value: unknown): void { if (typeof value !== "boolean") throw new Error("Invalid Archive flag"); }
function count(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid Archive count"); }
function date(value: unknown): void { text(value, 64); if (!Number.isFinite(Date.parse(value as string))) throw new Error("Invalid Archive date"); }
function texts(value: unknown): void {
 if (!Array.isArray(value) || value.length > 20) throw new Error("Archive page is too large");
 for (const entry of value) {
  const row = record(entry, ["text", "at", "sessionId", "project", "uses", "truncated"]);
  text(row.text, 768, true); date(row.at); flag(row.truncated);
  if (row.sessionId !== undefined) text(row.sessionId, 128);
  if (row.project !== undefined) text(row.project, 256, true);
  if (row.uses !== undefined) count(row.uses);
 }
}
function session(value: unknown): void {
 const row = record(value, ["id", "title", "project", "created", "modified", "messages", "status", "recap", "truncated"]);
 text(row.id,128); text(row.title,256,true); text(row.project,256,true); date(row.created); date(row.modified); count(row.messages); flag(row.truncated);
 if (row.status !== undefined) text(row.status,64);
 if (row.recap !== undefined) text(row.recap,512,true);
}
export function validateArchiveOperation(value: unknown): void {
 const row=record(value,["kind","sessionId","scope","query","targetSessionId"]);
 if (typeof row.kind !== "string" || !isArchiveOperationKind(row.kind)) throw new Error("Unknown Archive command");
 text(row.sessionId,128);
 if (row.kind === "archive.session.inspect") {
  text(row.targetSessionId,128);
  if (!/^[a-zA-Z0-9_-]+$/.test(row.targetSessionId as string) || row.scope !== undefined || row.query !== undefined) throw new Error("Invalid Archive target");
 } else {
  if (!["workspace","all"].includes(row.scope as string) || row.targetSessionId !== undefined) throw new Error("Invalid Archive scope");
  if (row.kind === "archive.prompts.search") text(row.query,256,true);
  else if(row.query !== undefined) throw new Error("Unexpected Archive query");
 }
}
export function validateArchiveResult(kind: ArchiveOperation["kind"], value: unknown): void {
 if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) throw new Error("Archive result exceeds limit");
 if (kind === "archive.session.inspect") {
  const row=record(value,["session","recaps","prompts","truncated"]);
  session(row.session); texts(row.recaps); texts(row.prompts); flag(row.truncated);
 } else {
  const row=record(value,["rows","truncated"]); flag(row.truncated);
  if (kind === "archive.sessions.list") {
   if (!Array.isArray(row.rows) || row.rows.length > 20) throw new Error("Archive page is too large");
   row.rows.forEach(session);
  } else texts(row.rows);
 }
}
