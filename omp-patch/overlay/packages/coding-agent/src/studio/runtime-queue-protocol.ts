export interface RuntimeQueueEntry {
	id: string;
	text: string;
	queue: "steering" | "followUp";
	state: "queued" | "inFlight" | "held";
	imageCount: number;
	editable: boolean;
}
export interface RuntimeQueueResult {
	entries: RuntimeQueueEntry[];
	total: number;
	truncated: boolean;
}
export type RuntimeQueueOperation =
	| { kind: "session.queue.get"; sessionId: string }
	| { kind: "session.queue.entry.remove"; sessionId: string; id: string; queue: "steering" | "followUp" }
	| { kind: "session.queue.restore"; sessionId: string; id: string; queue: "steering" | "followUp" }
	| { kind: "session.queue.promote"; sessionId: string; id: string; queue: "steering" | "followUp" }
	| {
			kind: "session.queue.edit";
			sessionId: string;
			id: string;
			queue: "steering" | "followUp";
			expectedText: string;
			text: string;
	  };
export interface RuntimeQueueResultMap {
	"session.queue.get": RuntimeQueueResult;
	"session.queue.entry.remove": RuntimeQueueResult;
	"session.queue.promote": RuntimeQueueResult;
	"session.queue.edit": RuntimeQueueResult;
	"session.queue.restore": RuntimeQueueResult;
}
export const RUNTIME_QUEUE_KINDS = [
	"session.queue.get",
	"session.queue.entry.remove",
	"session.queue.promote",
	"session.queue.edit",
	"session.queue.restore",
] as const;
export function isRuntimeQueueKind(kind: string): kind is RuntimeQueueOperation["kind"] {
	return (RUNTIME_QUEUE_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid native queue object");
	return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): void {
	if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0"))
		throw new Error("Invalid native queue text");
}
export function validateRuntimeQueueOperation(value: unknown): void {
	const row = record(value, ["kind", "sessionId", "id", "queue", "expectedText", "text"]);
	if (typeof row.kind !== "string" || !isRuntimeQueueKind(row.kind)) throw new Error("Unknown native queue operation");
	text(row.sessionId, 512);
	if (row.kind === "session.queue.get") {
		record(row, ["kind", "sessionId"]);
		return;
	}
	text(row.id, 128);
	if (!["steering", "followUp"].includes(row.queue as string)) throw new Error("Invalid native queue selection");
	if (row.kind === "session.queue.edit") {
		text(row.expectedText, 32768, true);
		text(row.text, 32768);
	} else record(row, ["kind", "sessionId", "id", "queue"]);
}
export function validateRuntimeQueueResult(_kind: RuntimeQueueOperation["kind"], value: unknown): void {
	const row = record(value, ["entries", "total", "truncated"]);
	if (
		!Array.isArray(row.entries) ||
		row.entries.length > 100 ||
		typeof row.total !== "number" ||
		!Number.isSafeInteger(row.total) ||
		row.total < row.entries.length ||
		typeof row.truncated !== "boolean"
	)
		throw new Error("Invalid native queue result");
	for (const entry of row.entries) {
		const item = record(entry, ["id", "text", "queue", "state", "imageCount", "editable"]);
		text(item.id, 128);
		text(item.text, 32768, true);
		if (
			!["steering", "followUp"].includes(item.queue as string) ||
			!["queued", "inFlight", "held"].includes(item.state as string) ||
			typeof item.imageCount !== "number" ||
			!Number.isSafeInteger(item.imageCount) ||
			item.imageCount < 0 ||
			typeof item.editable !== "boolean"
		)
			throw new Error("Invalid native queue entry");
	}
}
