import { afterEach, expect, it, vi } from "vitest";
import { createSessionSwitchRecorder } from "./sessionSwitchPerformance";

afterEach(() => vi.useRealTimers());

it("disabled diagnostics collect nothing and allocate no timers", () => {
  vi.useFakeTimers();
  const resources = vi.fn(() => ({ documents: 1 }));
  const recorder = createSessionSwitchRecorder({ resources });
  recorder.span("query.history.list")();
  recorder.mark("switch.commit");
  expect(resources).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(recorder.snapshot().events).toEqual([]);
});

it("records switch timings, outcomes and numeric resources without operation payloads", () => {
  vi.useFakeTimers();
  let clock = 100;
  const recorder = createSessionSwitchRecorder({ now: () => clock, memory: () => ({ heapUsedBytes: 123456789 }) });
  const unregister = recorder.register(() => ({ documents: 3, views: 1 }));
  recorder.start(); recorder.start();
  const finish = recorder.span("switch.dispatch");
  clock += 125; finish(true); finish();
  recorder.mark("switch.commit");
  const result = recorder.snapshot();
  expect(result.events.filter(row => row.event === "switch.dispatch.end")).toEqual([
    { atMs: 125, event: "switch.dispatch.end", sequence: 1, values: { durationMs: 125, failed: 1 } },
  ]);
  expect(result.counters).toEqual({ heapUsedBytes: 123456789, documents: 3, views: 1 });
  expect(vi.getTimerCount()).toBe(1);
  unregister();
  expect(recorder.snapshot().counters).toEqual({ heapUsedBytes: 123456789 });
  recorder.stop(); recorder.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds retained samples and ignores completion from a stopped recording", () => {
  vi.useFakeTimers();
  const recorder = createSessionSwitchRecorder();
  recorder.start();
  const late = recorder.span("client.bootstrap");
  for (let index = 0; index < 900; index++) recorder.mark("switch.commit", { count: index });
  expect(recorder.snapshot().events).toHaveLength(600);
  expect(recorder.snapshot().dropped).toBeGreaterThan(0);
  recorder.stop(); recorder.start(); late();
  expect(recorder.snapshot().events.map(row => row.event)).toEqual(["sample"]);
  const snapshot = recorder.snapshot();
  snapshot.events.length = 0;
  expect(recorder.snapshot().events).toHaveLength(1);
  recorder.stop();
});
