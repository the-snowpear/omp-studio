export interface StatsFilter {
	range?: "1h" | "24h" | "7d" | "30d" | "90d" | "all";
	model?: string;
	provider?: string;
	folder?: string;
}
export interface StatsRow {
	id: string;
	label: string;
	requests: number;
	errors: number | null;
	tokens: number;
	costEstimate: number | null;
	unpriced: number;
}
export interface FrustrationCounts {
	messages: number;
	judged: number;
	annoyed: number;
	atAssistant: number;
	angry: number;
}
export interface FrustrationJob {
	state: "idle" | "running" | "done" | "cancelled" | "failed";
	total: number;
	done: number;
	failed: number;
	cost: number | null;
	judge: string | null;
	filter?: StatsFilter;
}
export interface FrustrationData {
	overall: FrustrationCounts;
	models: Array<FrustrationCounts & { id: string; label: string }>;
	job: FrustrationJob;
}
export interface FrustrationInput {
	action: "estimate" | "start" | "cancel" | "retry";
	filter: StatsFilter;
	quoteId?: string;
}
export interface FrustrationResult {
	available: boolean;
	reason?: string;
	quote?: { id: string; filter: StatsFilter; messages: number; cost: number | null; judge: string; expiresAt: number };
	job?: FrustrationJob;
}
export function validateFrustrationInput(value: unknown): asserts value is FrustrationInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Frustration request");
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some(key => !["action", "filter", "quoteId"].includes(key)) ||
		!["estimate", "start", "cancel", "retry"].includes(v.action as string)
	)
		throw Error("Invalid Frustration action");
	validateStatsFilter(v.filter);
	if (v.action === "start" && (typeof v.quoteId !== "string" || !v.quoteId || v.quoteId.length > 128))
		throw Error("A reviewed quote is required");
	if (v.action !== "start" && v.quoteId !== undefined) throw Error("Only start accepts a quote");
}
export interface StatsSnapshot {
	available: boolean;
	reason?: string;
	updatedAt: number;
	cached: boolean;
	filter: StatsFilter;
	sync: {
		state: "idle" | "running" | "completed" | "failed";
		current: number;
		total: number;
		processed: number;
		error?: string;
	};
	overall: StatsRow;
	models: StatsRow[];
	providers: StatsRow[];
	projects: StatsRow[];
	tools: StatsRow[];
	frustration?: FrustrationData;
	sessions?: StatsRow[];
}
export function validateStatsFilter(value: unknown): asserts value is StatsFilter {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid stats filter");
	const v = value as Record<string, unknown>;
	if (Object.keys(v).some(key => !["range", "model", "provider", "folder"].includes(key)))
		throw Error("Unknown stats filter");
	if (v.range !== undefined && !["1h", "24h", "7d", "30d", "90d", "all"].includes(v.range as string))
		throw Error("Invalid stats range");
	for (const key of ["model", "provider", "folder"])
		if (
			v[key] !== undefined &&
			(typeof v[key] !== "string" || !v[key] || v[key].length > 4096 || v[key].includes("\0"))
		)
			throw Error("Invalid stats dimension");
}
export function validateStatsSnapshot(value: unknown): asserts value is StatsSnapshot {
	exact(value, [
		"available",
		"reason",
		"updatedAt",
		"cached",
		"filter",
		"sync",
		"overall",
		"models",
		"providers",
		"projects",
		"tools",
		"frustration",
		"sessions",
	]);
	if (!value || typeof value !== "object") throw Error("Invalid stats snapshot");
	const v = value as StatsSnapshot;
	validateStatsFilter(v.filter);
	optionalText(v.reason);
	exact(v.sync, ["state", "current", "total", "processed", "error"]);
	optionalText(v.sync.error);
	if (
		typeof v.available !== "boolean" ||
		typeof v.cached !== "boolean" ||
		!Number.isFinite(v.updatedAt) ||
		!v.sync ||
		!["idle", "running", "completed", "failed"].includes(v.sync.state)
	)
		throw Error("Invalid stats state");
	for (const n of [v.sync.current, v.sync.total, v.sync.processed])
		if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid stats progress");
	if (v.frustration !== undefined) {
		const f = v.frustration;
		exact(f, ["overall", "models", "job"]);
		validateFrustrationJob(f.job);
		if (!Array.isArray(f.models) || f.models.length > 500) throw Error("Invalid Frustration rows");
		for (const row of [f.overall, ...f.models]) {
			exact(
				row,
				row === f.overall
					? ["messages", "judged", "annoyed", "atAssistant", "angry"]
					: ["messages", "judged", "annoyed", "atAssistant", "angry", "id", "label"],
			);
			for (const key of ["messages", "judged", "annoyed", "atAssistant", "angry"] as const)
				if (!Number.isSafeInteger(row[key]) || row[key] < 0) throw Error("Invalid Frustration count");
		}
		for (const row of f.models)
			if (
				typeof row.id !== "string" ||
				typeof row.label !== "string" ||
				row.id.length > 4096 ||
				row.label.length > 4096
			)
				throw Error("Invalid Frustration model");
	}
	for (const rows of [[v.overall], v.models, v.providers, v.projects, v.tools, v.sessions ?? []]) {
		if (!Array.isArray(rows) || rows.length > 500) throw Error("Invalid stats rows");
		for (const r of rows) {
			exact(r, ["id", "label", "requests", "errors", "tokens", "costEstimate", "unpriced"]);
			if (
				!r ||
				typeof r.id !== "string" ||
				typeof r.label !== "string" ||
				r.id.length > 4096 ||
				r.label.length > 4096
			)
				throw Error("Invalid stats identity");
			if (r.errors !== null && (!Number.isFinite(r.errors) || r.errors < 0)) throw Error("Invalid stats errors");
			for (const n of [r.requests, r.tokens, r.unpriced])
				if (!Number.isFinite(n) || n < 0) throw Error("Invalid stats count");
			if (r.costEstimate !== null && (!Number.isFinite(r.costEstimate) || r.costEstimate < 0))
				throw Error("Invalid stats cost");
		}
	}
}
function validateFrustrationJob(job: FrustrationJob): void {
	exact(job, ["state", "total", "done", "failed", "cost", "judge", "filter"]);
	if (!job || !["idle", "running", "done", "cancelled", "failed"].includes(job.state))
		throw Error("Invalid Frustration job");
	if (job.cost !== null && (!Number.isFinite(job.cost) || job.cost < 0)) throw Error("Invalid Frustration cost");
	for (const n of [job.total, job.done, job.failed])
		if (!Number.isSafeInteger(n) || n < 0) throw Error("Invalid Frustration progress");
	if (job.judge !== null && (typeof job.judge !== "string" || job.judge.length > 4096)) throw Error("Invalid Judge");
	if (job.filter !== undefined) validateStatsFilter(job.filter);
}
export function validateFrustrationResult(value: unknown): asserts value is FrustrationResult {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid Frustration result");
	const v = value as FrustrationResult;
	exact(v, ["available", "reason", "quote", "job"]);
	if (
		typeof v.available !== "boolean" ||
		(v.reason !== undefined && (typeof v.reason !== "string" || v.reason.length > 4096))
	)
		throw Error("Invalid Frustration availability");
	if (v.job !== undefined) validateFrustrationJob(v.job);
	if (v.quote !== undefined) {
		const q = v.quote;
		exact(q, ["id", "filter", "messages", "cost", "judge", "expiresAt"]);
		validateStatsFilter(q.filter);
		if (
			typeof q.id !== "string" ||
			!q.id ||
			q.id.length > 128 ||
			typeof q.judge !== "string" ||
			!q.judge ||
			q.judge.length > 4096 ||
			!Number.isSafeInteger(q.messages) ||
			q.messages < 0 ||
			!Number.isFinite(q.expiresAt) ||
			(q.cost !== null && (!Number.isFinite(q.cost) || q.cost < 0))
		)
			throw Error("Invalid analysis quote");
	}
}
export function emptyStats(filter: StatsFilter, reason?: string): StatsSnapshot {
	return {
		available: false,
		...(reason ? { reason } : {}),
		filter,
		updatedAt: 0,
		cached: false,
		sync: { state: "idle", current: 0, total: 0, processed: 0 },
		overall: { id: "all", label: "All", requests: 0, errors: 0, tokens: 0, costEstimate: null, unpriced: 0 },
		models: [],
		providers: [],
		projects: [],
		tools: [],
	};
}

function exact(value: unknown, keys: readonly string[]): void {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw Error("Invalid statistics fields");
}
function optionalText(value: unknown): void {
	if (value !== undefined && (typeof value !== "string" || value.length > 4096))
		throw Error("Invalid statistics description");
}
