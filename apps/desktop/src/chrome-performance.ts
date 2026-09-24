import { createMemorySampleGate, type MemorySample, type MemorySampleGateDecision } from "@omp-studio/studio-protocol";
import { CHROME_PERFORMANCE_CHANNEL, parseRendererPerformanceSample } from "./chrome-performance-shared.js";
import type { ChromeMetricsIpcMain, ChromeMetricsSender } from "./chrome-metrics.js";

let nextInstance = 0;
export function registerChromePerformanceIpc(options: { ipcMain: ChromeMetricsIpcMain;
  isTrustedSender: (sender: ChromeMetricsSender) => boolean; now?: () => number;
  emit: (sample: MemorySample, decision: MemorySampleGateDecision, instance: number) => void }) {
  const now = options.now ?? Date.now;
  const senders = new WeakMap<object, { at: number; instance: number; gate: ReturnType<typeof createMemorySampleGate> }>();
  options.ipcMain.handle(CHROME_PERFORMANCE_CHANNEL, ({ sender }, input) => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) return false;
    const previous = senders.get(sender);
    if (previous !== undefined && now() - previous.at < 60_000) return false;
    const sample = parseRendererPerformanceSample(input);
    if (sample === undefined) return false;
    const entry = previous ?? { at: now(), instance: ++nextInstance, gate: createMemorySampleGate({ now }) };
    entry.at = now(); senders.set(sender, entry);
    const decision = entry.gate.observe(sample);
    if (decision.log) { try { options.emit(sample, decision, entry.instance); } catch { /* Best effort local diagnostics. */ } }
    return true;
  });
  return { dispose: () => options.ipcMain.removeHandler(CHROME_PERFORMANCE_CHANNEL) };
}
