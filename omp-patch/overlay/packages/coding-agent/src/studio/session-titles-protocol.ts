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
function object(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid session title fields");
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
	const row = object(value, ["kind", "sessionId", "targetSessionIds"]);
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
export function validateSessionTitlesResult(_kind: SessionTitlesOperation["kind"], value: unknown): void {
	const result = object(value, ["rows"]);
	if (!Array.isArray(result.rows) || result.rows.length > 32) throw new Error("Too many session titles");
	const seen = new Set<string>();
	for (const value of result.rows) {
		const row = object(value, ["sessionId", "state", "title", "source", "card", "reason"]);
		identity(row.sessionId);
		if (seen.has(row.sessionId as string)) throw new Error("Duplicate session title identity");
		seen.add(row.sessionId as string);
		if (!["available", "missing", "unavailable"].includes(row.state as string))
			throw new Error("Invalid session title state");
		if (row.title !== undefined) text(row.title, 1024);
		if (row.source !== undefined && !["auto", "user"].includes(row.source as string))
			throw new Error("Invalid title source");
		if (row.reason !== undefined) text(row.reason, 512);
		if (row.card !== undefined) {
			const card = object(row.card, ["code", "emoji", "nf"]);
			if (
				row.state !== "available" ||
				!row.title ||
				typeof card.code !== "string" ||
				!/^[A-Z0-9]{1,6}$/.test(card.code)
			)
				throw new Error("Invalid session title card");
			if (card.emoji !== undefined) text(card.emoji, 32);
			if (card.nf !== undefined) {
				text(card.nf, 128);
				if (!/^nf-[a-z0-9_-]+$/.test(card.nf as string)) throw new Error("Invalid title icon");
			}
		}
	}
}
