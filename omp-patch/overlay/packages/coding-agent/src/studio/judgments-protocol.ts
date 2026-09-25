/** Batch judgments share the native judge role, queue and accounting. */
export type JudgmentJson = null | boolean | number | string | JudgmentJson[] | { [key: string]: JudgmentJson };
export type JudgmentQuestion =
	| { type: "bool"; instructions: string; criteria?: { true?: string; false?: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string | null> }
	| { type: "score"; instructions: string; criteria: string[] };
export interface JudgmentBatchSpec {
	intent: string;
	items: Array<{ key: string | number; state: string | JudgmentJson[] | Record<string, JudgmentJson> }>;
	questions: Record<string, JudgmentQuestion>;
	concurrency: number;
	retries: number;
	minOk: number;
}
export type JudgmentAnswer =
	| { type: "bool"; bool: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| { type: "score"; score: number; probabilities: Record<string, number>; confidence: number };
export interface JudgmentBatchRow {
	id: string;
	intent: string;
	total: number;
	done: number;
	failed: number;
	cost: number;
	running: boolean;
	model?: string;
	elapsedS: number;
	error?: string;
}
export interface JudgmentBatchItem {
	key: string | number;
	answers?: Record<string, JudgmentAnswer>;
	error?: string;
	model?: string;
}
export interface JudgmentBatchPage {
	batch: JudgmentBatchRow;
	items: JudgmentBatchItem[];
	offset: number;
	nextOffset: number;
}
export type JudgmentOperation =
	| { kind: "judgments.list"; sessionId: string; cursor?: string; limit?: number }
	| { kind: "judgments.create"; sessionId: string; spec: JudgmentBatchSpec }
	| { kind: "judgments.read"; sessionId: string; id: string; offset?: number; limit?: number }
	| { kind: "judgments.cancel"; sessionId: string; id: string }
	| { kind: "judgments.close"; sessionId: string; id: string }
	| { kind: "judgments.retry"; sessionId: string; id: string };
export interface JudgmentResultMap {
	"judgments.list": { batches: JudgmentBatchRow[]; nextCursor?: string };
	"judgments.create": { batch: JudgmentBatchRow };
	"judgments.read": JudgmentBatchPage;
	"judgments.cancel": { batch: JudgmentBatchRow; cancelled: boolean };
	"judgments.close": { closed: boolean };
	"judgments.retry": { batch: JudgmentBatchRow; sourceId: string };
}
export const JUDGMENT_OPERATION_KINDS = [
	"judgments.list",
	"judgments.create",
	"judgments.read",
	"judgments.cancel",
	"judgments.close",
	"judgments.retry",
] as const;
export function isJudgmentOperationKind(value: string): value is JudgmentOperation["kind"] {
	return (JUDGMENT_OPERATION_KINDS as readonly string[]).includes(value);
}
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const forbidden = new Set(["__proto__", "constructor", "prototype"]);
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a judgment object");
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some(key => forbidden.has(key) || (keys && !keys.includes(key))))
		throw new Error("Unknown or unsafe judgment field");
	return row;
}
function text(value: unknown, max = 512, empty = false): void {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || value.length > max)
		throw new Error("Invalid judgment text");
}
function number(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): void {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isSafeInteger(value))
	)
		throw new Error("Invalid judgment number");
}
function safeJson(value: unknown, depth = 0): void {
	if (depth > 16) throw new Error("Judgment input nesting exceeds 16 levels");
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "string") {
		text(value, 32000, true);
		return;
	}
	if (typeof value === "number") {
		number(value, -Number.MAX_VALUE, Number.MAX_VALUE);
		return;
	}
	const values = Array.isArray(value) ? value : Object.values(record(value));
	if (values.length > 1000) throw new Error("Judgment input collection is too large");
	values.forEach(item => safeJson(item, depth + 1));
}
function key(value: unknown): void {
	if (typeof value === "number") number(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
	else text(value, 256);
	if (forbidden.has(String(value))) throw new Error("Unsafe judgment key");
}
export function validateJudgmentBatchSpec(value: unknown): asserts value is JudgmentBatchSpec {
	const spec = record(value, ["intent", "items", "questions", "concurrency", "retries", "minOk"]);
	text(spec.intent, 256);
	if (!Array.isArray(spec.items) || !spec.items.length || spec.items.length > 500)
		throw new Error("A batch needs 1–500 items");
	const keys = new Set<string>();
	for (const entry of spec.items) {
		const item = record(entry, ["key", "state"]);
		key(item.key);
		if (keys.has(String(item.key))) throw new Error("Item keys must be unique, including string/number equivalents");
		keys.add(String(item.key));
		if (typeof item.state === "string") text(item.state, 32000);
		else if (!item.state || typeof item.state !== "object")
			throw new Error("Item state must be text, an object or an array");
		safeJson(item.state);
		if (bytes(item.state) > 48000) throw new Error("An item exceeds 48 KB");
	}
	const questions = record(spec.questions);
	if (!Object.keys(questions).length || Object.keys(questions).length > 16)
		throw new Error("A batch needs 1–16 questions");
	for (const [id, value] of Object.entries(questions)) {
		text(id, 128);
		const question = record(value, ["type", "instructions", "criteria"]);
		text(question.instructions, 8000);
		if (question.type === "bool") {
			if (question.criteria !== undefined)
				for (const item of Object.values(record(question.criteria, ["true", "false"]))) text(item, 2000, true);
		} else if (question.type === "choice") {
			const criteria = record(question.criteria);
			if (Object.keys(criteria).length < 2 || Object.keys(criteria).length > 32)
				throw new Error("Choice questions need 2–32 options");
			for (const [label, rubric] of Object.entries(criteria)) {
				text(label, 256);
				if (rubric !== null) text(rubric, 2000, true);
			}
		} else if (question.type === "score") {
			if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 32)
				throw new Error("Score questions need 2–32 levels");
			question.criteria.forEach(level => text(level, 2000));
		} else throw new Error("Unknown judgment question kind");
	}
	number(spec.concurrency, 1, 32, true);
	number(spec.retries, 0, 5, true);
	number(spec.minOk, 0, spec.items.length, true);
	if (bytes(spec) > 600000) throw new Error("Batch exceeds 600 KB; split the input");
}
export function validateJudgmentOperation(value: unknown): asserts value is JudgmentOperation {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !isJudgmentOperationKind(kind)) throw new Error("Unknown judgment operation");
	const fields =
		kind === "judgments.create"
			? ["spec"]
			: kind === "judgments.list"
				? ["cursor", "limit"]
				: kind === "judgments.read"
					? ["id", "offset", "limit"]
					: ["id"];
	const input = record(value, ["kind", "sessionId", ...fields]);
	text(input.sessionId);
	if (kind === "judgments.create") validateJudgmentBatchSpec(input.spec);
	else if (kind !== "judgments.list") text(input.id);
	if (input.cursor !== undefined) text(input.cursor);
	if (input.offset !== undefined) number(input.offset, 0, Number.MAX_SAFE_INTEGER, true);
	if (input.limit !== undefined) number(input.limit, 1, 50, true);
}
function status(value: unknown): void {
	const row = record(value, [
		"id",
		"intent",
		"total",
		"done",
		"failed",
		"cost",
		"running",
		"model",
		"elapsedS",
		"error",
	]);
	text(row.id);
	text(row.intent, 512);
	for (const field of ["total", "done", "failed"]) number(row[field], 0, Number.MAX_SAFE_INTEGER, true);
	if ((row.failed as number) > (row.done as number) || (row.done as number) > (row.total as number))
		throw new Error("Inconsistent judgment status");
	number(row.cost);
	number(row.elapsedS);
	if (typeof row.running !== "boolean") throw new Error("Invalid running flag");
	if (row.model !== undefined) text(row.model);
	if (row.error !== undefined) text(row.error, 4000);
}
function answer(value: unknown): void {
	const row = record(value, ["type", "bool", "choice", "score", "confidence", "probabilities"]);
	if (row.type === "bool") {
		record(row, ["type", "bool"]);
		number(row.bool, 0, 1);
		return;
	}
	if (row.type !== "choice" && row.type !== "score") throw new Error("Invalid answer kind");
	record(row, ["type", row.type, "confidence", "probabilities"]);
	if (row.type === "choice") text(row.choice, 256);
	else number(row.score);
	number(row.confidence, 0, 1);
	const probabilities = record(row.probabilities);
	if (Object.keys(probabilities).length > 128) throw new Error("Too many answer probabilities");
	for (const [label, probability] of Object.entries(probabilities)) {
		text(label, 256);
		number(probability, 0, 1);
	}
}
export function validateJudgmentItem(value: unknown): asserts value is JudgmentBatchItem {
	const row = record(value, ["key", "answers", "error", "model"]);
	key(row.key);
	if ((row.answers === undefined) === (row.error === undefined)) throw new Error("An item needs answers or an error");
	if (row.answers !== undefined) {
		const answers = record(row.answers);
		if (Object.keys(answers).length > 64) throw new Error("Too many answers");
		for (const [id, value] of Object.entries(answers)) {
			text(id, 128);
			answer(value);
		}
	}
	if (row.error !== undefined) text(row.error, 4000);
	if (row.model !== undefined) text(row.model);
}
export function validateJudgmentResult(kind: JudgmentOperation["kind"], value: unknown): void {
	if (bytes(value) > 450000) throw new Error("Judgment result exceeds its page budget");
	const fields =
		kind === "judgments.list"
			? ["batches", "nextCursor"]
			: kind === "judgments.read"
				? ["batch", "items", "offset", "nextOffset"]
				: kind === "judgments.close"
					? ["closed"]
					: kind === "judgments.cancel"
						? ["batch", "cancelled"]
						: kind === "judgments.retry"
							? ["batch", "sourceId"]
							: ["batch"];
	const row = record(value, fields);
	if (kind === "judgments.list") {
		if (!Array.isArray(row.batches) || row.batches.length > 50) throw new Error("Invalid batch list");
		row.batches.forEach(status);
		if (row.nextCursor !== undefined) text(row.nextCursor);
	} else if (kind === "judgments.close") {
		if (typeof row.closed !== "boolean") throw new Error("Invalid close result");
	} else {
		status(row.batch);
		if (kind === "judgments.read") {
			number(row.offset, 0, Number.MAX_SAFE_INTEGER, true);
			number(row.nextOffset, row.offset as number, Number.MAX_SAFE_INTEGER, true);
			if (!Array.isArray(row.items) || row.items.length > 50) throw new Error("Invalid item page");
			row.items.forEach(validateJudgmentItem);
			if (row.nextOffset !== (row.offset as number) + row.items.length) throw new Error("Invalid result cursor");
		}
		if (kind === "judgments.cancel" && typeof row.cancelled !== "boolean") throw new Error("Invalid cancel result");
		if (kind === "judgments.retry") text(row.sourceId);
	}
}
