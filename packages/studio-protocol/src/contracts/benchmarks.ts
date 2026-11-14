export interface BenchmarkSpec {
  models: string[]; profile: "chat" | "prefill" | "generation" | "mix" | "cache" | "detailed";
  runs: number; concurrency: number; maxTokens?: number; prompt?: string;
  prefillBytes?: number; cachePrefixBytes?: number;
}
export interface BenchmarkMetric { mean: number; min: number; p50: number; p95: number; max: number }
export interface BenchmarkStats {
  ttftMs: BenchmarkMetric; durationMs: BenchmarkMetric; tokensPerSecond: BenchmarkMetric; generationTps: BenchmarkMetric; prefillTps: BenchmarkMetric;
  inputTokens: number; outputTokens: number; cost: number;
}
export interface BenchmarkMeasurement {
  transport?: "http" | "websocket";
  workloadPhase?: "single" | "parallel" | "prefill";
  ok: boolean; challenge?: "chat" | "prefill" | "generation"; error?: string;
  phase?: "cold" | "warm" | "single" | "parallel" | "prefill"; cacheReadTokens?: number; cacheWriteTokens?: number;
  cacheObservations?: Array<"prompt_cache_read_observed" | "prompt_cache_write_observed" | "response_cache_hit_observed" | "no_provider_proof">;
  ttftMs?: number; durationMs?: number; generationMs?: number; inputTokens?: number; outputTokens?: number;
  tokensPerSecond?: number; generationTps?: number; prefillTps?: number; cost?: number;
}
export interface BenchmarkModelResult {
  phases?: Partial<Record<"single" | "parallel" | "prefill", { concurrency: number; runs: number; wallMs: number; aggregateTps: number; stats: BenchmarkStats | null }>>;
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
