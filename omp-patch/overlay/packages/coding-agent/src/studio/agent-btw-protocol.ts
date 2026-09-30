/** Child BTW is bound to an opaque Runtime target incarnation, never the main BTW slot. */
export type AgentBtwOperation =
	| { kind: "agent.btw.read"; sessionId: string; agentId: string; binding?: string; topicId?: string }
	| { kind: "agent.btw.ask"; sessionId: string; agentId: string; binding: string; question: string; topicId?: string }
	| { kind: "agent.btw.abort"; sessionId: string; agentId: string; binding: string; ephemeralId: string };
export interface AgentBtwState {
	binding: string;
	agentId: string;
	targetSessionId: string;
	snapshot: null | {
		ephemeralId: string;
		topicId?: string;
		question?: string;
		status: "running" | "completed" | "failed" | "aborted";
		text: string;
		error?: { code: "INTERNAL_ERROR" | "OUTPUT_LIMIT"; message: string };
	};
	topics: Array<{ topicId: string; question: string; status: string; updatedAt: number; turnCount: number }>;
	turns: Array<{
		question: string;
		answer: string;
		status: string;
		createdAt: number;
		updatedAt: number;
		error?: string;
	}>;
}
export interface AgentBtwResultMap {
	"agent.btw.read": AgentBtwState;
	"agent.btw.ask": AgentBtwState;
	"agent.btw.abort": AgentBtwState;
}
export const AGENT_BTW_KINDS = ["agent.btw.read", "agent.btw.ask", "agent.btw.abort"] as const;
export function isAgentBtwKind(kind: string): kind is AgentBtwOperation["kind"] {
	return (AGENT_BTW_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw Error("Invalid child BTW fields");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 512, empty = false): void {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || value.includes("\0"))
		throw Error("Invalid child BTW text");
}
export function validateAgentBtwOperation(value: unknown): asserts value is AgentBtwOperation {
	const kind = (value as { kind?: unknown })?.kind;
	if (typeof kind !== "string" || !isAgentBtwKind(kind)) throw Error("Invalid child BTW operation");
	const row = object(value, [
		"kind",
		"sessionId",
		"agentId",
		"binding",
		...(kind === "agent.btw.abort"
			? ["ephemeralId"]
			: kind === "agent.btw.ask"
				? ["question", "topicId"]
				: ["topicId"]),
	]);
	text(row.sessionId);
	text(row.agentId);
	if (kind !== "agent.btw.read" || row.binding !== undefined) text(row.binding, 128);
	if (row.topicId !== undefined) text(row.topicId, 128);
	if (kind === "agent.btw.ask") text(row.question, 65536);
	if (kind === "agent.btw.abort") text(row.ephemeralId, 128);
}
export function validateAgentBtwState(value: unknown): asserts value is AgentBtwState {
	if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1048576)
		throw Error("Child BTW exceeds wire budget");
	const row = object(value, ["binding", "agentId", "targetSessionId", "snapshot", "topics", "turns"]);
	text(row.binding, 128);
	text(row.agentId);
	text(row.targetSessionId);
	const number = (v: unknown) => {
		if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw Error("Invalid child BTW count");
	};
	if (row.snapshot !== null) {
		const s = object(row.snapshot, ["ephemeralId", "topicId", "question", "status", "text", "error"]);
		text(s.ephemeralId, 128);
		text(s.text, 262144, true);
		if (s.topicId !== undefined) text(s.topicId, 128);
		if (s.question !== undefined) text(s.question, 65536);
		if (!["running", "completed", "failed", "aborted"].includes(s.status as string))
			throw Error("Invalid child BTW status");
		if (s.error !== undefined) {
			const e = object(s.error, ["code", "message"]);
			if (!["INTERNAL_ERROR", "OUTPUT_LIMIT"].includes(e.code as string)) throw Error("Invalid child BTW error");
			text(e.message);
		}
	}
	for (const key of ["topics", "turns"] as const) {
		const items = row[key];
		if (!Array.isArray(items) || items.length > (key === "topics" ? 100 : 32))
			throw Error("Invalid child BTW history");
		for (const item of items) {
			const r = object(
				item,
				key === "topics"
					? ["topicId", "question", "status", "updatedAt", "turnCount"]
					: ["question", "answer", "status", "createdAt", "updatedAt", "error"],
			);
			text(r.question, 65536);
			number(r.updatedAt);
			if (!["running", "complete", "cancelled", "error", "interrupted"].includes(r.status as string))
				throw Error("Invalid history status");
			if (key === "topics") {
				text(r.topicId, 128);
				number(r.turnCount);
			} else {
				text(r.answer, 262144, true);
				number(r.createdAt);
				if (r.error !== undefined) text(r.error);
			}
		}
	}
}
