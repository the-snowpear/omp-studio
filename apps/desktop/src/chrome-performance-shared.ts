import type { MemorySample } from "@omp-studio/studio-protocol";
export const CHROME_PERFORMANCE_CHANNEL = "omp-studio:chrome:report-performance-sample";
export const RENDERER_COUNTERS = [
  "conversation.engines.active", "conversation.engines.rows", "conversation.engines.listeners", "conversation.engines.openBufferEvents", "conversation.engines.openBufferBytes",
  "conversation.stores.active", "conversation.stores.rows", "conversation.stores.rowCache", "conversation.stores.listeners", "conversation.stores.published",
  "highlight.workers", "highlight.started", "highlight.running", "highlight.queued", "highlight.queueBytes", "highlight.cacheEntries", "highlight.cacheBytes", "highlight.timeouts", "highlight.crashes", "highlight.slotListeners",
  "mermaid.cacheEntries", "mermaid.cacheBytes", "mermaid.queued", "mermaid.running", "mermaid.slotListeners",
] as const;
const allowed = new Set<string>(RENDERER_COUNTERS);
const numeric = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export function parseRendererPerformanceSample(value: unknown): MemorySample | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.role !== "renderer" || Object.keys(raw).some((key) => !["role", "heapUsedBytes", "heapTotalBytes", "counters"].includes(key))) return undefined;
  if (raw.counters === null || typeof raw.counters !== "object" || Array.isArray(raw.counters)) return undefined;
  const counters = Object.entries(raw.counters);
  if (counters.length > RENDERER_COUNTERS.length || counters.some(([key, number]) => !allowed.has(key) || !numeric(number))) return undefined;
  const sample: MemorySample = { role: "renderer", counters: Object.fromEntries(counters) };
  for (const key of ["heapUsedBytes", "heapTotalBytes"] as const) {
    if (raw[key] !== undefined) { if (!numeric(raw[key])) return undefined; sample[key] = raw[key]; }
  }
  if (JSON.stringify(sample).length > 4096) return undefined;
  return sample;
}
