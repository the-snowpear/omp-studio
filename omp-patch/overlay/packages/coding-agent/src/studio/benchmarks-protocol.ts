/** The native one-based --account choice, bound to stable credential rows for each provider. */
export interface BenchmarkAccountSelection {
	account: number;
	credentialIds: Record<string, number>;
}
export interface BenchmarkAccountOption {
	account: number;
	credentialId: number;
	label: string;
}
export interface BenchmarkAccounts {
	providerId: string;
	accounts: BenchmarkAccountOption[];
}

export interface BenchmarkSpec {
	account?: BenchmarkAccountSelection;
	serviceTier?: string;
	models: string[];
	profile: "chat" | "prefill" | "generation" | "mix" | "cache" | "detailed";
	runs: number;
	concurrency: number;
	maxTokens?: number;
	prompt?: string;
	prefillBytes?: number;
	cachePrefixBytes?: number;
}
export interface BenchmarkMetric {
	mean: number;
	min: number;
	p50: number;
	p95: number;
	max: number;
}
export interface BenchmarkStats {
	ttftMs: BenchmarkMetric;
	durationMs: BenchmarkMetric;
	tokensPerSecond: BenchmarkMetric;
	generationTps: BenchmarkMetric;
	prefillTps: BenchmarkMetric;
	inputTokens: number;
	outputTokens: number;
	cost: number;
}
export interface BenchmarkMeasurement {
	transport?: "http" | "websocket";
	workloadPhase?: "single" | "parallel" | "prefill";
	ok: boolean;
	challenge?: "chat" | "prefill" | "generation";
	error?: string;
	phase?: "cold" | "warm" | "single" | "parallel" | "prefill";
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	cacheObservations?: Array<
		"prompt_cache_read_observed" | "prompt_cache_write_observed" | "response_cache_hit_observed" | "no_provider_proof"
	>;
	ttftMs?: number;
	durationMs?: number;
	generationMs?: number;
	inputTokens?: number;
	outputTokens?: number;
	tokensPerSecond?: number;
	generationTps?: number;
	prefillTps?: number;
	cost?: number;
}
export interface BenchmarkModelResult {
	phases?: Partial<
		Record<
			"single" | "parallel" | "prefill",
			{ concurrency: number; runs: number; wallMs: number; aggregateTps: number; stats: BenchmarkStats | null }
		>
	>;
	selector: string;
	model: string;
	state: "queued" | "running" | "done";
	total: number;
	completed: number;
	failed: number;
	inFlight: number;
	stats: BenchmarkStats | null;
	byChallenge: Partial<Record<"chat" | "prefill" | "generation", BenchmarkStats>>;
	measurements: BenchmarkMeasurement[];
}
export interface BenchmarkRun {
	id: string;
	sessionId: string;
	createdAt: number;
	finishedAt?: number;
	state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
	spec: BenchmarkSpec;
	error?: string;
}
export interface BenchmarkSnapshot {
	run: BenchmarkRun;
	models: BenchmarkModelResult[];
}
export type BenchmarkOperation =
	| { kind: "benchmarks.accounts.read"; sessionId: string; providerId: string }
	| { kind: "benchmarks.list"; sessionId: string }
	| { kind: "benchmarks.start"; sessionId: string; spec: BenchmarkSpec }
	| { kind: "benchmarks.read"; sessionId: string; id: string }
	| { kind: "benchmarks.cancel"; sessionId: string; id: string }
	| { kind: "benchmarks.close"; sessionId: string; id: string };
export interface BenchmarkResultMap {
	"benchmarks.accounts.read": BenchmarkAccounts;
	"benchmarks.list": { runs: BenchmarkRun[] };
	"benchmarks.start": { run: BenchmarkRun };
	"benchmarks.read": BenchmarkSnapshot;
	"benchmarks.cancel": { run: BenchmarkRun };
	"benchmarks.close": { closed: boolean };
}
export const BENCHMARK_OPERATION_KINDS = [
	"benchmarks.accounts.read",
	"benchmarks.list",
	"benchmarks.start",
	"benchmarks.read",
	"benchmarks.cancel",
	"benchmarks.close",
] as const;
export function isBenchmarkOperationKind(kind: string): kind is BenchmarkOperation["kind"] {
	return (BENCHMARK_OPERATION_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a benchmark object");
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown benchmark field");
	return row;
}
function text(value: unknown, max = 512): void {
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max)
		throw new Error("Invalid benchmark text");
}
function number(value: unknown, min = 0, max = Number.MAX_VALUE, integer = false): void {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isSafeInteger(value))
	)
		throw new Error("Invalid benchmark number");
}
export function validateBenchmarkAccountSelection(value: unknown): asserts value is BenchmarkAccountSelection {
	const selection = record(value, ["account", "credentialIds"]);
	number(selection.account, 1, Number.MAX_SAFE_INTEGER, true);
	if (
		!selection.credentialIds ||
		typeof selection.credentialIds !== "object" ||
		Array.isArray(selection.credentialIds)
	)
		throw new Error("Choose the stored credential for each selected provider");
	const entries = Object.entries(selection.credentialIds);
	if (!entries.length || entries.length > 8) throw new Error("Choose 1–8 provider credentials");
	for (const [provider, id] of entries) {
		text(provider);
		number(id, 1, Number.MAX_SAFE_INTEGER, true);
	}
}
export function validateBenchmarkSpec(value: unknown): asserts value is BenchmarkSpec {
	const spec = record(value, [
		"models",
		"profile",
		"runs",
		"concurrency",
		"maxTokens",
		"prompt",
		"prefillBytes",
		"cachePrefixBytes",
		"serviceTier",
		"account",
	]);
	if (spec.account !== undefined) validateBenchmarkAccountSelection(spec.account);
	if (spec.serviceTier !== undefined) text(spec.serviceTier);
	if (
		!Array.isArray(spec.models) ||
		spec.models.length < 1 ||
		spec.models.length > 8 ||
		new Set(spec.models).size !== spec.models.length
	)
		throw new Error("Choose 1–8 distinct models");
	spec.models.forEach(model => {
		text(model);
		if (!(model as string).includes("/")) throw new Error("Use an explicit provider/model selector");
	});
	if (!["chat", "prefill", "generation", "mix", "cache", "detailed"].includes(spec.profile as string))
		throw new Error("Unknown benchmark profile");
	if (spec.profile === "detailed") number(spec.concurrency, 2, 8, true);
	number(spec.runs, 1, spec.profile === "cache" ? 10 : 20, true);
	number(spec.concurrency, 1, spec.profile === "cache" ? 4 : 8, true);
	if (spec.maxTokens !== undefined) number(spec.maxTokens, 1, 8192, true);
	if (spec.prompt !== undefined) {
		text(spec.prompt, 8000);
		if (spec.profile !== "chat" && spec.profile !== "generation")
			throw new Error("Custom prompts require chat or generation profile");
	}
	if (spec.prefillBytes !== undefined) {
		number(spec.prefillBytes, 1024, 262144, true);
		if (spec.profile !== "prefill" && spec.profile !== "mix")
			throw new Error("Prefill size requires a prefill workload");
	}
	if (spec.cachePrefixBytes !== undefined) {
		number(spec.cachePrefixBytes, 1024, 262144, true);
		if (spec.profile !== "cache") throw new Error("Cache prefix requires the cache workload");
	}
}
export function validateBenchmarkOperation(value: unknown): asserts value is BenchmarkOperation {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !isBenchmarkOperationKind(kind)) throw new Error("Unknown benchmark operation");
	const input = record(value, [
		"kind",
		"sessionId",
		...(kind === "benchmarks.start"
			? ["spec"]
			: kind === "benchmarks.accounts.read"
				? ["providerId"]
				: kind === "benchmarks.list"
					? []
					: ["id"]),
	]);
	text(input.sessionId);
	if (kind === "benchmarks.start") validateBenchmarkSpec(input.spec);
	else if (kind === "benchmarks.accounts.read") text(input.providerId);
	else if (kind !== "benchmarks.list") text(input.id);
}
