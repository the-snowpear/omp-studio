import { createCounterRegistry, createDiagnosticsSampler, createMemorySampleGate, formatMemorySampleLine, type MemorySample, type MemorySampleGateDecision } from "@omp-studio/studio-protocol";
import type { StudioRuntimeSessionController } from "@omp-studio/studio-host";
import type { HostLog } from "./host-log.js";
import { ConversationViews } from "./conversation-views.js";

export const desktopConversationViews = new ConversationViews();

const controllers = new Set<StudioRuntimeSessionController>();
let sink: HostLog | undefined;
let nextInstance = 0;
export function registerPerformanceController(controller: StudioRuntimeSessionController): () => void {
  controllers.add(controller);
  const unregister = desktopConversationViews.registerController({ epoch: () => controller.publication()?.snapshot.runtimeEpoch,
    setVisibleSessions: (ids) => controller.setConversationVisibleSessions(ids) });
  const offPublication = controller.onPublication(() => desktopConversationViews.refresh());
  return () => { offPublication(); unregister(); controllers.delete(controller); };
}
export function collectHostPerformanceCounters(): Readonly<Record<string, number>> {
  const result: Record<string, number> = { residents: controllers.size };
  for (const controller of controllers) {
    for (const [key, value] of Object.entries(controller.getConversationDiagnostics())) result[key] = (result[key] ?? 0) + value;
  }
  return result;
}
export function logRendererPerformance(sample: MemorySample, decision: MemorySampleGateDecision, instance: number): void {
  sink?.write("info", "performance.sample", formatMemorySampleLine(sample, { prefix: { instance, seq: decision.seq, reason: decision.reason ?? "first" } }));
}
export function startHostPerformance(log: HostLog): () => void {
  sink = log;
  const instance = ++nextInstance;
  const registry = createCounterRegistry();
  const unregister = registry.register("host", collectHostPerformanceCounters);
  const sampler = createDiagnosticsSampler({
    gate: createMemorySampleGate({ now: Date.now }),
    sample: () => { const memory = process.memoryUsage(); return { role: "main-host", rssBytes: memory.rss, heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal, externalBytes: memory.external, arrayBuffersBytes: memory.arrayBuffers, counters: registry.collect() }; },
    emit: (sample, decision) => log.write("info", "performance.sample", formatMemorySampleLine(sample, { prefix: { instance, seq: decision.seq, reason: decision.reason ?? "first" } })),
    setInterval: (callback, ms) => setInterval(callback, ms), clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    onScheduled: (handle) => (handle as { unref?: () => void }).unref?.(),
  });
  sampler.start(); void sampler.tick();
  return () => { sampler.dispose(); unregister(); if (sink === log) sink = undefined; };
}
