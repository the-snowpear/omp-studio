import type { BenchmarkSnapshot, BenchmarkStats, BenchmarkSpec } from "@omp-studio/studio-protocol";
const metric = (value: number) => ({ mean: value, min: value * 0.8, p50: value, p95: value * 1.2, max: value * 1.2 });
const stats = (ttft: number, tps: number): BenchmarkStats => ({ ttftMs: metric(ttft), durationMs: metric(1800), tokensPerSecond: metric(tps), generationTps: metric(tps * 1.2), prefillTps: metric(4000), inputTokens: 600, outputTokens: 180, cost: 0.002 });
export function previewBenchmark(spec: BenchmarkSpec): BenchmarkSnapshot {
 const result=structuredClone(PREVIEW_BENCHMARK);result.run={...result.run,id:"demo-"+crypto.randomUUID(),spec};
 if(spec.profile === "detailed") result.models=result.models.map(row=>({...row,total:2*spec.runs+spec.concurrency*Math.ceil(spec.runs/spec.concurrency),completed:2*spec.runs+spec.concurrency*Math.ceil(spec.runs/spec.concurrency),phases:{single:{concurrency:1,runs:spec.runs,wallMs:3000,aggregateTps:120,stats:row.stats},parallel:{concurrency:spec.concurrency,runs:spec.concurrency*Math.ceil(spec.runs/spec.concurrency),wallMs:2000,aggregateTps:180,stats:row.stats},prefill:{concurrency:1,runs:spec.runs,wallMs:2000,aggregateTps:90,stats:row.stats}}}));
 return result;
}
export const PREVIEW_BENCHMARK: BenchmarkSnapshot = {
  run: { id: "demo-bench", sessionId: "preview", createdAt: 1, finishedAt: 3001, state: "completed", spec: { models: ["demo/swift", "demo/reason"], profile: "chat", runs: 3, concurrency: 1 } },
  models: [
    { selector: "demo/swift", model: "demo/swift", state: "done", total: 3, completed: 3, failed: 0, inFlight: 0, stats: stats(240, 120), byChallenge: { chat: stats(240, 120) }, measurements: [] },
    { selector: "demo/reason", model: "demo/reason", state: "done", total: 3, completed: 3, failed: 0, inFlight: 0, stats: stats(580, 75), byChallenge: { chat: stats(580, 75) }, measurements: [] },
  ],
};
