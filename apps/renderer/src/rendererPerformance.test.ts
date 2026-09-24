import { afterEach, expect, it, vi } from "vitest";
import { createRendererPerformanceReporter } from "./rendererPerformance";
import { collectRendererResources } from "./rendererResources";
import { createConversationEngine } from "./conversation/conversationEngine";
import { createSubagentConversationEngine } from "./conversation/subagentConversationEngine";

afterEach(() => vi.useRealTimers());
it("older preload starts no timer, missing heap is omitted and disposal stops the reporter", async () => {
  vi.useFakeTimers();
  const old = createRendererPerformanceReporter({}); expect(vi.getTimerCount()).toBe(0); old();
  const reportPerformanceSample = vi.fn(async (_sample: unknown) => true);
  const stop = createRendererPerformanceReporter({ reportPerformanceSample }, () => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(reportPerformanceSample).toHaveBeenCalledTimes(1);
  expect(reportPerformanceSample.mock.calls[0]?.[0]).not.toHaveProperty("heapUsedBytes");
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(reportPerformanceSample).toHaveBeenCalledTimes(1);
  stop(); stop(); expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(300000); expect(reportPerformanceSample).toHaveBeenCalledTimes(1);
});
it("50 main/child view lifecycles return resource providers to baseline even while disposed engines are retained", () => {
  const baseline = collectRendererResources();
  const retained = [];
  for (let i = 0; i < 50; i++) {
    const main = createConversationEngine({ preview: false, client: null, identity: null, canRead: false, runtimeConnected: false, previewItems: [] });
    const child = createSubagentConversationEngine({ preview: false, client: null, target: null, runtimeConnected: false, previewItems: [] });
    main.start(); child.start();
    expect(collectRendererResources()["engines.active"]).toBe((baseline["engines.active"] ?? 0) + 2);
    main.dispose(); child.dispose(); main.dispose(); child.dispose(); retained.push(main, child);
  }
  expect(collectRendererResources()).toEqual(baseline);
  expect(retained.every((engine) => engine.getSnapshot().rows.length === 0)).toBe(true);
});
