import { createCounterRegistry, createDiagnosticsSampler, createMemorySampleGate, type MemorySample } from "@omp-studio/studio-protocol";
import { collectRendererResources } from "./rendererResources";
import { highlightPool } from "./highlight/service";
import { mermaidQueue } from "./conversation/LazyMermaid";

type Reporter = { reportPerformanceSample?: (sample: MemorySample) => Promise<boolean> };
export function createRendererPerformanceReporter(chrome: Reporter | undefined, memory = () =>
  (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory): () => void {
  if (chrome?.reportPerformanceSample === undefined) return () => {};
  const registry = createCounterRegistry();
  const unregister = [registry.register("conversation", collectRendererResources),
    registry.register("highlight", () => highlightPool.getDiagnostics()), registry.register("mermaid", () => mermaidQueue.getDiagnostics())];
  const sampler = createDiagnosticsSampler({
    gate: createMemorySampleGate({ now: Date.now }),
    sample: () => {
      const heap = memory();
      return { role: "renderer", ...(heap === undefined ? {} : { heapUsedBytes: heap.usedJSHeapSize, heapTotalBytes: heap.totalJSHeapSize }), counters: registry.collect() };
    },
    emit: (sample) => { void chrome.reportPerformanceSample!(sample).catch(() => {}); },
    setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  });
  void sampler.tick().finally(() => sampler.start());
  return () => { sampler.dispose(); for (const off of unregister) off(); };
}
