export interface SessionTitleCard {
	code: string;
	emoji?: string;
	nf?: string;
}
export interface SessionTitleRow {
	sessionId: string;
	state: "available" | "missing" | "unavailable";
	title?: string;
	source?: "auto" | "user";
	card?: SessionTitleCard;
	reason?: string;
}
export interface SessionTitlesResult {
	rows: SessionTitleRow[];
}
export type SessionTitlesOperation = { kind: "session.titles.inspect"; sessionId: string; targetSessionIds: string[] };
export interface SessionTitlesResultMap {
	"session.titles.inspect": SessionTitlesResult;
}
export const SESSION_TITLES_KINDS = ["session.titles.inspect"] as const;
export function isSessionTitlesKind(kind: string): kind is SessionTitlesOperation["kind"] {
	return kind === "session.titles.inspect";
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session title fields");
	return value as Record<string, unknown>;
}
function text(value: unknown, max: number): void {
	if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f]/.test(value))
		throw new Error("Invalid session title text");
}
function identity(value: unknown): void {
	text(value, 128);
	if (!/^[a-zA-Z0-9_-]+$/.test(value as string)) throw new Error("Invalid session title identity");
}
export function validateSessionTitlesOperation(value: unknown): void {
	const row = object(value);
	if (row.kind !== "session.titles.inspect") throw new Error("Unknown session title command");
	identity(row.sessionId);
	if (
		!Array.isArray(row.targetSessionIds) ||
		row.targetSessionIds.length > 32 ||
		row.targetSessionIds.length === 0 ||
		new Set(row.targetSessionIds).size !== row.targetSessionIds.length
	)
		throw new Error("Select 1–32 distinct session identities");
	row.targetSessionIds.forEach(identity);
}
