export interface BenchmarkSpec {
  models: string[]; profile: "chat" | "prefill" | "generation" | "mix" | "cache";
  runs: number; concurrency: number; maxTokens?: number; prompt?: string;
  prefillBytes?: number; cachePrefixBytes?: number;
}
export interface BenchmarkMetric { mean: number; min: number; p50: number; p95: number; max: number }
export interface BenchmarkStats {
  ttftMs: BenchmarkMetric; durationMs: BenchmarkMetric; tokensPerSecond: BenchmarkMetric; generationTps: BenchmarkMetric; prefillTps: BenchmarkMetric;
  inputTokens: number; outputTokens: number; cost: number;
}
export interface BenchmarkMeasurement {
  ok: boolean; challenge?: "chat" | "prefill" | "generation"; error?: string;
  phase?: "cold" | "warm"; cacheReadTokens?: number; cacheWriteTokens?: number;
  cacheObservations?: Array<"prompt_cache_read_observed" | "prompt_cache_write_observed" | "response_cache_hit_observed" | "no_provider_proof">;
  ttftMs?: number; durationMs?: number; generationMs?: number; inputTokens?: number; outputTokens?: number;
  tokensPerSecond?: number; generationTps?: number; prefillTps?: number; cost?: number;
}
export interface BenchmarkModelResult {
  selector: string; model: string; state: "queued" | "running" | "done";
  total: number; completed: number; failed: number; inFlight: number;
  stats: BenchmarkStats | null; byChallenge: Partial<Record<"chat" | "prefill" | "generation", BenchmarkStats>>;
  measurements: BenchmarkMeasurement[];
}
export interface BenchmarkRun {
  id: string; sessionId: string; createdAt: number; finishedAt?: number;
  state: "running" | "cancelling" | "completed" | "cancelled" | "failed";
  spec: BenchmarkSpec; error?: string;
}
export interface BenchmarkSnapshot { run: BenchmarkRun; models: BenchmarkModelResult[] }
export type BenchmarkOperation =
  | { kind: "benchmarks.list"; sessionId: string }
  | { kind: "benchmarks.start"; sessionId: string; spec: BenchmarkSpec }
  | { kind: "benchmarks.read"; sessionId: string; id: string }
  | { kind: "benchmarks.cancel"; sessionId: string; id: string }
  | { kind: "benchmarks.close"; sessionId: string; id: string };
export interface BenchmarkResultMap {
  "benchmarks.list": { runs: BenchmarkRun[] };
  "benchmarks.start": { run: BenchmarkRun };
  "benchmarks.read": BenchmarkSnapshot;
  "benchmarks.cancel": { run: BenchmarkRun };
  "benchmarks.close": { closed: boolean };
}
export const BENCHMARK_OPERATION_KINDS = ["benchmarks.list", "benchmarks.start", "benchmarks.read", "benchmarks.cancel", "benchmarks.close"] as const;
export function isBenchmarkOperationKind(kind: string): kind is BenchmarkOperation["kind"] { return (BENCHMARK_OPERATION_KINDS as readonly string[]).includes(kind); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a benchmark object");
  const row = value as Record<string, unknown>; if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown benchmark field"); return row;
}
function text(value: unknown, max = 512): void { if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max) throw new Error("Invalid benchmark text"); }
function number(value: unknown, min = 0, max = Number.MAX_VALUE, integer = false): void { if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error("Invalid benchmark number"); }
export function validateBenchmarkSpec(value: unknown): asserts value is BenchmarkSpec {
  const spec = record(value, ["models", "profile", "runs", "concurrency", "maxTokens", "prompt", "prefillBytes", "cachePrefixBytes"]);
  if (!Array.isArray(spec.models) || spec.models.length < 1 || spec.models.length > 8 || new Set(spec.models).size !== spec.models.length) throw new Error("Choose 1–8 distinct models");
  spec.models.forEach(model => { text(model); if (!(model as string).includes("/")) throw new Error("Use an explicit provider/model selector"); });
  if (!["chat", "prefill", "generation", "mix", "cache"].includes(spec.profile as string)) throw new Error("Unknown benchmark profile");
  number(spec.runs, 1, spec.profile === "cache" ? 10 : 20, true); number(spec.concurrency, 1, spec.profile === "cache" ? 4 : 8, true);
  if (spec.maxTokens !== undefined) number(spec.maxTokens, 1, 8192, true);
  if (spec.prompt !== undefined) { text(spec.prompt, 8000); if (spec.profile !== "chat" && spec.profile !== "generation") throw new Error("Custom prompts require chat or generation profile"); }
  if (spec.prefillBytes !== undefined) { number(spec.prefillBytes, 1024, 262144, true); if (spec.profile !== "prefill" && spec.profile !== "mix") throw new Error("Prefill size requires a prefill workload"); }
  if (spec.cachePrefixBytes !== undefined) { number(spec.cachePrefixBytes, 1024, 262144, true); if (spec.profile !== "cache") throw new Error("Cache prefix requires the cache workload"); }
}
export function validateBenchmarkOperation(value: unknown): asserts value is BenchmarkOperation {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (typeof kind !== "string" || !isBenchmarkOperationKind(kind)) throw new Error("Unknown benchmark operation");
  const input = record(value, ["kind", "sessionId", ...(kind === "benchmarks.start" ? ["spec"] : kind === "benchmarks.list" ? [] : ["id"])]); text(input.sessionId);
  if (kind === "benchmarks.start") validateBenchmarkSpec(input.spec); else if (kind !== "benchmarks.list") text(input.id);
}
function run(value: unknown): void {
  const row = record(value, ["id", "sessionId", "createdAt", "finishedAt", "state", "spec", "error"]); text(row.id); text(row.sessionId); number(row.createdAt, 0, Number.MAX_SAFE_INTEGER, true);
  if (row.finishedAt !== undefined) number(row.finishedAt, 0, Number.MAX_SAFE_INTEGER, true);
  if (!["running", "cancelling", "completed", "cancelled", "failed"].includes(row.state as string)) throw new Error("Invalid benchmark state");
  validateBenchmarkSpec(row.spec); if (row.error !== undefined) text(row.error, 4000);
}
function stats(value: unknown): void {
  const row = record(value, ["ttftMs", "durationMs", "tokensPerSecond", "generationTps", "prefillTps", "inputTokens", "outputTokens", "cost"]);
  for (const key of ["ttftMs", "durationMs", "tokensPerSecond", "generationTps", "prefillTps"]) {
    const metric = record(row[key], ["mean", "min", "p50", "p95", "max"]); for (const field of ["mean", "min", "p50", "p95", "max"]) number(metric[field]);
  }
  for (const key of ["inputTokens", "outputTokens", "cost"]) number(row[key]);
}
export function validateBenchmarkResult(kind: BenchmarkOperation["kind"], value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 700000) throw new Error("Benchmark result exceeds its budget");
  if (kind === "benchmarks.close") { if (typeof record(value, ["closed"]).closed !== "boolean") throw new Error("Invalid close result"); return; }
  if (kind === "benchmarks.list") { const input = record(value, ["runs"]); if (!Array.isArray(input.runs) || input.runs.length > 10) throw new Error("Invalid run list"); input.runs.forEach(run); return; }
  const input = record(value, kind === "benchmarks.read" ? ["run", "models"] : ["run"]); run(input.run);
  if (kind !== "benchmarks.read") return;
  if (!Array.isArray(input.models) || input.models.length > 8) throw new Error("Invalid benchmark models");
  for (const entry of input.models) {
    const model = record(entry, ["selector", "model", "state", "total", "completed", "failed", "inFlight", "stats", "byChallenge", "measurements"]); text(model.selector); text(model.model);
    if (!["queued", "running", "done"].includes(model.state as string)) throw new Error("Invalid model run state");
    for (const key of ["total", "completed", "failed", "inFlight"]) number(model[key], 0, 40, true);
    if (model.stats !== null) stats(model.stats);
    const groups = record(model.byChallenge, ["chat", "prefill", "generation"]); Object.values(groups).forEach(stats);
    if (!Array.isArray(model.measurements) || model.measurements.length > 20) throw new Error("Invalid measurements");
    for (const item of model.measurements) {
      const measurement = record(item, ["ok", "challenge", "error", "phase", "cacheReadTokens", "cacheWriteTokens", "cacheObservations", "ttftMs", "durationMs", "generationMs", "inputTokens", "outputTokens", "tokensPerSecond", "generationTps", "prefillTps", "cost"]);
      if (typeof measurement.ok !== "boolean") throw new Error("Invalid measurement");
      if (measurement.error !== undefined) text(measurement.error, 4000);
      if (measurement.challenge !== undefined && !["chat", "prefill", "generation"].includes(measurement.challenge as string)) throw new Error("Invalid challenge");
      if (measurement.phase !== undefined && measurement.phase !== "cold" && measurement.phase !== "warm") throw new Error("Invalid cache phase");
      if (measurement.cacheObservations !== undefined && (!Array.isArray(measurement.cacheObservations) || measurement.cacheObservations.length > 4 || measurement.cacheObservations.some(item => !["prompt_cache_read_observed", "prompt_cache_write_observed", "response_cache_hit_observed", "no_provider_proof"].includes(item)))) throw new Error("Invalid cache observation");
      for (const [key, value] of Object.entries(measurement)) if (!["ok", "error", "challenge", "phase", "cacheObservations"].includes(key)) number(value);
    }
  }
}
