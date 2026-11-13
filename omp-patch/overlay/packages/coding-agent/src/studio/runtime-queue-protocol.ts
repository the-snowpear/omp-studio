export interface RuntimeQueueEntry {
	kind?: "compaction";
	heldFor?: "compaction";
	id: string;
	text: string;
	queue: "steering" | "followUp";
	state: "queued" | "inFlight" | "held";
	imageCount: number;
	editable: boolean;
}
export interface RuntimeQueueResult {
	compactionError?: string;
	entries: RuntimeQueueEntry[];
	total: number;
	truncated: boolean;
}
export type RuntimeQueueOperation =
	| { kind: "session.compaction.enqueue"; sessionId: string; instructions?: string }
	| { kind: "session.compaction.cancel"; sessionId: string; id?: string }
	| { kind: "session.compaction.status"; sessionId: string }
	| { kind: "session.queue.get"; sessionId: string }
	| {
			kind: "session.queue.entry.remove";
			sessionId: string;
			id: string;
			queue: "steering" | "followUp";
	  }
	| {
			kind: "session.queue.restore";
			sessionId: string;
			id: string;
			queue: "steering" | "followUp";
	  }
	| {
			kind: "session.queue.promote";
			sessionId: string;
			id: string;
			queue: "steering" | "followUp";
	  }
	| {
			kind: "session.queue.edit";
			sessionId: string;
			id: string;
			queue: "steering" | "followUp";
			expectedText: string;
			text: string;
	  };
export interface RuntimeQueueResultMap {
	"session.compaction.enqueue": RuntimeQueueResult;
	"session.compaction.cancel": RuntimeQueueResult;
	"session.compaction.status": RuntimeQueueResult;
	"session.queue.get": RuntimeQueueResult;
	"session.queue.entry.remove": RuntimeQueueResult;
	"session.queue.promote": RuntimeQueueResult;
	"session.queue.edit": RuntimeQueueResult;
	"session.queue.restore": RuntimeQueueResult;
}
export const RUNTIME_QUEUE_KINDS = [
	"session.compaction.enqueue",
	"session.compaction.cancel",
	"session.compaction.status",
	"session.queue.get",
	"session.queue.entry.remove",
	"session.queue.promote",
	"session.queue.edit",
	"session.queue.restore",
] as const;
export function isRuntimeQueueKind(kind: string): kind is RuntimeQueueOperation["kind"] {
	return (RUNTIME_QUEUE_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native queue object");
	return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): void {
	if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0"))
		throw new Error("Invalid native queue text");
}
export function validateRuntimeQueueOperation(value: unknown): void {
	const row = record(value);
	if (typeof row.kind !== "string" || !isRuntimeQueueKind(row.kind)) throw new Error("Unknown native queue operation");
	text(row.sessionId, 512);
	if (String(row.kind).startsWith("session.compaction.")) return;
	if (row.kind === "session.queue.get") {
		return;
	}
	text(row.id, 128);
	if (!["steering", "followUp"].includes(row.queue as string)) throw new Error("Invalid native queue selection");
	if (row.kind === "session.queue.edit") {
		text(row.expectedText, 32768, true);
		text(row.text, 32768);
	}
}
