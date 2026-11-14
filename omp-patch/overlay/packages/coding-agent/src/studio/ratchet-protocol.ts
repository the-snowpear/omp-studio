export type RatchetStage = "inputs" | "grader" | "plan";
export interface RatchetRoundView {
	round: number;
	variant: string;
	change: string;
	decision: "baseline" | "keep" | "revert" | "rerun";
	reasons: string[];
	train: number | null;
	test: number | null;
	at: string;
}
export interface RatchetRunView {
	id: string;
	flow: string;
	workspace: string;
	state: "ready" | "running" | "stopped" | "completed" | "failed" | "interrupted";
	createdAt: number;
	roundsLimit: number;
	costLimit: number;
	modelCost: number;
	agentId?: string;
	error?: string;
	approvals: Record<RatchetStage, string>;
	rounds: RatchetRoundView[];
	best?: string;
	goal?: string;
	command?: string;
	cases: string[];
	harness: string[];
	change: string[];
	offLimits: string[];
	trainCount: number;
	testCount: number;
}
export type RatchetOperation =
	| { kind: "ratchet.list"; sessionId: string }
	| { kind: "ratchet.read"; sessionId: string; id: string }
	| {
			kind: "ratchet.create";
			sessionId: string;
			flow: string;
			cases: string[];
			harness: string[];
			change: string[];
			offLimits: string[];
			command: string;
			cohorts: Record<string, string>;
			metric: string;
			direction: "higher" | "lower";
			reps: number;
			roundsLimit: number;
			costLimit: number;
	  }
	| { kind: "ratchet.approve"; sessionId: string; id: string; stage: RatchetStage }
	| { kind: "ratchet.start"; sessionId: string; id: string }
	| { kind: "ratchet.stop"; sessionId: string; id: string };
export interface RatchetResultMap {
	"ratchet.list": { runs: RatchetRunView[] };
	"ratchet.read": RatchetRunView;
	"ratchet.create": RatchetRunView;
	"ratchet.approve": { approved: boolean; run: RatchetRunView };
	"ratchet.start": RatchetRunView;
	"ratchet.stop": RatchetRunView;
}
export const RATCHET_OPERATION_KINDS = [
	"ratchet.list",
	"ratchet.read",
	"ratchet.create",
	"ratchet.approve",
	"ratchet.start",
	"ratchet.stop",
] as const;
export function isRatchetKind(kind: string): kind is RatchetOperation["kind"] {
	return (RATCHET_OPERATION_KINDS as readonly string[]).includes(kind);
}
function obj(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Ratchet object");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): asserts value is string {
	if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new Error("Invalid Ratchet text");
}
function number(value: unknown, min: number, max: number, integer = true): void {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		(integer && !Number.isInteger(value)) ||
		value < min ||
		value > max
	)
		throw new Error("Invalid Ratchet number");
}
function strings(value: unknown): void {
	if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid Ratchet paths");
	for (const item of value) text(item);
}
export function validateRatchetOperation(value: unknown): asserts value is RatchetOperation {
	const row = obj(value);
	if (typeof row.kind !== "string" || !isRatchetKind(row.kind)) throw new Error("Unknown Ratchet operation");
	text(row.sessionId, 512);
	if (!row.sessionId) throw new Error("Session required");
	if (row.kind === "ratchet.create") {
		text(row.flow, 64);
		if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.flow)) throw new Error("Invalid flow");
		for (const key of ["cases", "harness", "change", "offLimits"]) strings(row[key]);
		text(row.command, 8192);
		text(row.metric, 256);
		if (!row.command || !row.metric || !["higher", "lower"].includes(String(row.direction)))
			throw new Error("Runner, metric and direction required");
		number(row.reps, 1, 100);
		number(row.roundsLimit, 1, 100);
		number(row.costLimit, 0.01, 10000, false);
		if (
			!row.cohorts ||
			typeof row.cohorts !== "object" ||
			Array.isArray(row.cohorts) ||
			Object.keys(row.cohorts).length > 10000
		)
			throw new Error("Invalid cohorts");
		for (const [key, cohort] of Object.entries(row.cohorts)) {
			text(key, 256);
			text(cohort, 256);
		}
	} else if (row.kind !== "ratchet.list") {
		text(row.id, 36);
		if (!/^[a-f0-9-]{36}$/u.test(row.id)) throw new Error("Invalid run identity");
		if (row.kind === "ratchet.approve" && !["inputs", "grader", "plan"].includes(String(row.stage)))
			throw new Error("Invalid stage");
	}
}
