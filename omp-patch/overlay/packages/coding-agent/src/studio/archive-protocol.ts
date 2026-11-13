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
