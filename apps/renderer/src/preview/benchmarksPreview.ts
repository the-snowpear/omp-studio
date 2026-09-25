import type { BenchmarkSnapshot, BenchmarkStats } from "@omp-studio/studio-protocol";
const metric = (value: number) => ({ mean: value, min: value * 0.8, p50: value, p95: value * 1.2, max: value * 1.2 });
const stats = (ttft: number, tps: number): BenchmarkStats => ({ ttftMs: metric(ttft), durationMs: metric(1800), tokensPerSecond: metric(tps), generationTps: metric(tps * 1.2), prefillTps: metric(4000), inputTokens: 600, outputTokens: 180, cost: 0.002 });
export const PREVIEW_BENCHMARK: BenchmarkSnapshot = {
  run: { id: "demo-bench", sessionId: "preview", createdAt: 1, finishedAt: 3001, state: "completed", spec: { models: ["demo/swift", "demo/reason"], profile: "chat", runs: 3, concurrency: 1 } },
  models: [
    { selector: "demo/swift", model: "demo/swift", state: "done", total: 3, completed: 3, failed: 0, inFlight: 0, stats: stats(240, 120), byChallenge: { chat: stats(240, 120) }, measurements: [] },
    { selector: "demo/reason", model: "demo/reason", state: "done", total: 3, completed: 3, failed: 0, inFlight: 0, stats: stats(580, 75), byChallenge: { chat: stats(580, 75) }, measurements: [] },
  ],
};
