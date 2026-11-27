export interface NativeArchiveSession {
	id: string;
	title: string;
	project: string;
	created: string;
	modified: string;
	messages: number;
	status?: string;
	recap?: string;
	truncated: boolean;
}
export interface NativeArchiveText {
	text: string;
	at: string;
	sessionId?: string;
	project?: string;
	uses?: number;
	truncated: boolean;
}
export interface NativeArchiveList<T> {
	rows: T[];
	truncated: boolean;
}
export interface NativeArchiveDetail {
	session: NativeArchiveSession;
	recaps: NativeArchiveText[];
	prompts: NativeArchiveText[];
	truncated: boolean;
}
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
export const ARCHIVE_OPERATION_KINDS = [
	"archive.sessions.list",
	"archive.recaps.list",
	"archive.prompts.search",
	"archive.session.inspect",
] as const;
export function isArchiveOperationKind(kind: string): kind is ArchiveOperation["kind"] {
	return (ARCHIVE_OPERATION_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Archive data");
	return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): void {
	if (typeof value !== "string" || (!empty && !value.length) || value.length > limit || value.includes("\0"))
		throw new Error("Invalid Archive text");
}
export function validateArchiveOperation(value: unknown): void {
	const row = record(value);
	if (typeof row.kind !== "string" || !isArchiveOperationKind(row.kind)) throw new Error("Unknown Archive command");
	text(row.sessionId, 128);
	if (row.kind === "archive.session.inspect") {
		text(row.targetSessionId, 128);
		if (!/^[a-zA-Z0-9_-]+$/.test(row.targetSessionId as string) || row.scope !== undefined || row.query !== undefined)
			throw new Error("Invalid Archive target");
	} else {
		if (!["workspace", "all"].includes(row.scope as string) || row.targetSessionId !== undefined)
			throw new Error("Invalid Archive scope");
		if (row.kind === "archive.prompts.search") text(row.query, 256, true);
		else if (row.query !== undefined) throw new Error("Unexpected Archive query");
	}
}

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
	text: string;
	turns: number;
	records: number;
	omitted: number;
	detail: Record<"user" | "assistant" | "thinking" | "call" | "result", Exclude<ArchiveTranscriptDetail, "auto">>;
}
export interface NativeArchiveCall {
	session: string;
	agent: string | null;
	project: string;
	at: string | null;
	callId: string;
	tool: string;
	args: Record<string, unknown>;
	result: string | null;
	isError: boolean | null;
	model: string | null;
}
export interface NativeArchiveGrepHit {
	session: string;
	agent: string | null;
	project: string;
	at: string | null;
	source: string;
	tool: string | null;
	text: string;
	match: string;
}
export type ArchiveQueryOperation =
	| (ArchiveReadScope & { kind: "archive.search"; query: string })
	| {
			kind: "archive.transcript.read";
			sessionId: string;
			targetSessionId: string;
			detail?: ArchiveTranscriptDetail;
			budget?: number;
			turns?: number | [number, number];
			since?: number;
			until?: number;
	  }
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
export const ARCHIVE_QUERY_KINDS = [
	"archive.search",
	"archive.transcript.read",
	"archive.calls.list",
	"archive.messages.grep",
	"archive.stats.read",
] as const;
export function isArchiveQueryKind(kind: string): kind is ArchiveQueryOperation["kind"] {
	return (ARCHIVE_QUERY_KINDS as readonly string[]).includes(kind);
}

export function validateArchiveQuery(value: unknown): void {
	const row = record(value);
	if (typeof row.kind !== "string" || !isArchiveQueryKind(row.kind)) throw new Error("Unknown Archive query");
	text(row.sessionId, 128);
	for (const key of ["since", "until"] as const) {
		if (row[key] !== undefined && (typeof row[key] !== "number" || !Number.isFinite(row[key])))
			throw new Error("Invalid Archive time window");
	}
	if (typeof row.since === "number" && typeof row.until === "number" && row.since >= row.until)
		throw new Error("Archive end must follow its start");
	if (row.kind === "archive.transcript.read") {
		text(row.targetSessionId, 128);
		if (!/^[a-zA-Z0-9_-]+$/.test(row.targetSessionId as string)) throw new Error("Invalid Archive target");
		if (row.detail !== undefined && !["auto", "omit", "brief", "normal", "full"].includes(row.detail as string))
			throw new Error("Invalid transcript detail");
		if (
			row.budget !== undefined &&
			(!Number.isSafeInteger(row.budget) || (row.budget as number) < 512 || (row.budget as number) > 64000)
		)
			throw new Error("Transcript budget must be between 512 and 64000 characters");
		if (row.turns !== undefined) {
			const turns = Array.isArray(row.turns) ? row.turns : [row.turns];
			if (
				turns.length < 1 ||
				turns.length > 2 ||
				!turns.every(item => Number.isSafeInteger(item) && Math.abs(item) <= 1000000)
			)
				throw new Error("Invalid transcript turns");
		}
		return;
	}
	if (!["workspace", "all"].includes(row.scope as string)) throw new Error("Invalid Archive scope");
	if (row.subagents !== undefined && typeof row.subagents !== "boolean")
		throw new Error("Invalid Archive subagent scope");
	if (row.kind === "archive.search") text(row.query, 256, true);
	if (row.kind === "archive.messages.grep") text(row.pattern, 256);
	if (row.kind === "archive.calls.list" && row.tools !== undefined) {
		if (!Array.isArray(row.tools) || row.tools.length > 20) throw new Error("Invalid Archive tool filter");
		row.tools.forEach(tool => text(tool, 128));
	}
	if (
		row.kind === "archive.stats.read" &&
		!["tool", "day", "model", "version", "project", "session"].includes(row.by as string)
	)
		throw new Error("Invalid Archive grouping");
}
