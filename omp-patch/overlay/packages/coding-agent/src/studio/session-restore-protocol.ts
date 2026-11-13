export interface SessionRestoreInspection {
	targetSessionId: string;
	savedModels: string[];
	status: "available" | "missing-model" | "unconfigured";
	resolvedModel?: string;
	thinking?: string;
	alternatives: Array<{ model: string; label: string }>;
	truncated: boolean;
}
export type SessionRestoreOperation = { kind: "session.restore.inspect"; sessionId: string; targetSessionId: string };
export interface SessionRestoreResultMap {
	"session.restore.inspect": SessionRestoreInspection;
}
export const SESSION_RESTORE_KINDS = ["session.restore.inspect"] as const;
export function isSessionRestoreKind(kind: string): kind is SessionRestoreOperation["kind"] {
	return kind === "session.restore.inspect";
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session restoration data");
	return value as Record<string, unknown>;
}
function text(value: unknown): void {
	if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f]/u.test(value))
		throw new Error("Invalid restoration text");
}
export function validateSessionRestoreOperation(value: unknown): void {
	const row = record(value);
	if (row.kind !== "session.restore.inspect") throw new Error("Unknown restoration command");
	text(row.sessionId);
	text(row.targetSessionId);
}
