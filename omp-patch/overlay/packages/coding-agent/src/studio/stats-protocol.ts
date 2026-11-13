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
