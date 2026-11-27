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

export interface ArchiveReadScope {
 sessionId: string;
 scope: "workspace" | "all";
 since?: number;
 until?: number;
 subagents?: boolean;
}
export type ArchiveTranscriptDetail = "auto" | "omit" | "brief" | "normal" | "full";
export type ArchiveStatsGroup = "tool" | "day" | "model" | "version" | "project" | "session";
export interface NativeArchiveSearchHit extends NativeArchiveSession {
 matches: Array<{ source: "title" | "recap" | "user" | "assistant"; text: string; at: string | null }>;
}
export interface NativeArchiveTranscript {
 text: string; turns: number; records: number; omitted: number;
 detail: Record<"user" | "assistant" | "thinking" | "call" | "result", Exclude<ArchiveTranscriptDetail, "auto">>;
}
export interface NativeArchiveCall {
 session: string; agent: string | null; project: string; at: string | null;
 callId: string; tool: string; args: Record<string, unknown>; result: string | null;
 isError: boolean | null; model: string | null;
}
export interface NativeArchiveGrepHit {
 session: string; agent: string | null; project: string; at: string | null;
 source: string; tool: string | null; text: string; match: string;
}
export type ArchiveQueryOperation =
 | (ArchiveReadScope & { kind: "archive.search"; query: string })
 | { kind: "archive.transcript.read"; sessionId: string; targetSessionId: string; detail?: ArchiveTranscriptDetail; budget?: number; turns?: number | [number, number]; since?: number; until?: number }
 | (ArchiveReadScope & { kind: "archive.calls.list"; tools?: string[] })
 | (ArchiveReadScope & { kind: "archive.messages.grep"; pattern: string })
 | (ArchiveReadScope & { kind: "archive.stats.read"; by: ArchiveStatsGroup });
export interface ArchiveQueryResultMap {
 "archive.search": NativeArchiveList<NativeArchiveSearchHit>;
 "archive.transcript.read": NativeArchiveTranscript;
 "archive.calls.list": NativeArchiveList<NativeArchiveCall>;
 "archive.messages.grep": NativeArchiveList<NativeArchiveGrepHit>;
 "archive.stats.read": NativeArchiveList<{ key: string | null; calls: number; errors: number }>;
}
export const ARCHIVE_QUERY_KINDS = ["archive.search", "archive.transcript.read", "archive.calls.list", "archive.messages.grep", "archive.stats.read"] as const;
export function isArchiveQueryKind(kind: string): kind is ArchiveQueryOperation["kind"] {
 return (ARCHIVE_QUERY_KINDS as readonly string[]).includes(kind);
}
