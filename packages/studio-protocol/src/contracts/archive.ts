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
