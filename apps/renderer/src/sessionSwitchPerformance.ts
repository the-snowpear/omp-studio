/** Opt-in, local-only diagnostics. Never capture prompts, ids, paths, payloads or errors. */
import { collectRendererResources } from "./rendererResources";

type Counters = Readonly<Record<string, number>>;
type Reader = (deep: boolean) => Counters;
type Sample = { atMs: number; event: string; sequence: number; values: Counters };
const CAPACITY = 6000;
const STORAGE_KEY = "omp.sessionSwitchPerformance";
const noop = () => {};

export function createSessionSwitchRecorder(options: {
  now?: () => number;
  memory?: () => Counters;
  resources?: () => Counters;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const readers = new Set<Reader>();
  let events: Sample[] = [];
  let active = false, generation = 0, sequence = 0, dropped = 0, operation = 0;
  let startedAt = 0, lastSampleAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let observer: PerformanceObserver | undefined;
  const counters = (deep: boolean): Counters => {
    const result: Record<string, number> = { ...(options.memory?.() ?? {}), ...(options.resources?.() ?? {}) };
    for (const read of readers) {
      try { for (const [key, value] of Object.entries(read(deep))) result[key] = (result[key] ?? 0) + value; } catch { /* diagnostics are best effort */ }
    }
    return result;
  };
  const record = (event: string, values: Counters = {}, eventSequence = sequence) => {
    if (!active) return;
    if (events.length >= CAPACITY) { events.shift(); dropped++; }
    events.push({ atMs: now() - startedAt, event, sequence: eventSequence, values });
  };
  const api = {
    enabled: () => active,
    register(read: Reader) { readers.add(read); return () => { readers.delete(read); }; },
    mark: record,
    span(event: string) {
      if (!active) return noop;
      if (event === "switch.dispatch") sequence++;
      const token = generation, eventSequence = sequence, start = now(), operationId = ++operation;
      record(`${event}.start`, { operationId }, eventSequence);
      let ended = false;
      return (failed = false) => {
        if (ended || token !== generation) return;
        ended = true;
        record(`${event}.end`, { operationId, durationMs: now() - start, failed: Number(failed) }, eventSequence);
      };
    },
    start() {
      if (active) return;
      active = true; generation++; sequence = 0; operation = 0; dropped = 0; events = [];
      startedAt = now(); lastSampleAt = startedAt;
      record("sample", counters(false));
      timer = setInterval(() => {
        const stamp = now();
        record("sample", { ...counters(false), timerLagMs: Math.max(0, stamp - lastSampleAt - 1000) });
        lastSampleAt = stamp;
      }, 1000);
      if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
        observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) record("longtask", { durationMs: entry.duration, startMs: entry.startTime - startedAt });
        });
        observer.observe({ type: "longtask" });
      }
    },
    stop() {
      if (!active) return;
      record("stop", counters(false));
      active = false; generation++;
      clearInterval(timer); timer = undefined;
      observer?.disconnect(); observer = undefined;
    },
    snapshot(deep = false) {
      return { version: 1, enabled: active, build: import.meta.env.DEV ? "development" : "production", elapsedMs: active || events.length ? now() - startedAt : 0,
        dropped, capacity: CAPACITY, counters: counters(deep), events: events.map(row => ({ ...row, values: { ...row.values } })) };
    },
  };
  return api;
}

export const sessionSwitchPerformance = createSessionSwitchRecorder({
  resources: collectRendererResources,
  memory: () => {
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return heap ? { heapUsedBytes: heap.usedJSHeapSize, heapTotalBytes: heap.totalJSHeapSize } : {};
  },
});

/** Query names are protocol constants. Never pass the query input or exception here. */
export function measureSessionOperation<T>(event: string, run: () => Promise<T>): Promise<T> {
  if (!sessionSwitchPerformance.enabled()) return run();
  const finish = sessionSwitchPerformance.span(event);
  return run().then(result => { finish(); return result; }, error => { finish(true); throw error; });
}

const browserApi = {
  start() {
    try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* optional persistence */ }
    sessionSwitchPerformance.start();
  },
  stop() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* optional persistence */ }
    sessionSwitchPerformance.stop();
  },
  snapshot: (deep = false) => sessionSwitchPerformance.snapshot(deep),
  phase: (index: number) => sessionSwitchPerformance.mark("capture.phase", { index }),
  download() {
    const blob = new Blob([JSON.stringify(sessionSwitchPerformance.snapshot(true), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `omp-session-performance-${Date.now()}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
declare global { interface Window { ompSessionPerf: typeof browserApi } }
if (typeof window !== "undefined") {
  window.ompSessionPerf = browserApi;
  try {
    if (new URL(location.href).searchParams.get("sessionPerf") === "1" || localStorage.getItem(STORAGE_KEY) === "1") sessionSwitchPerformance.start();
  } catch { /* optional diagnostics must not block startup */ }
  window.addEventListener("pagehide", sessionSwitchPerformance.stop, { once: true });
  import.meta.hot?.dispose(() => {
    window.removeEventListener("pagehide", sessionSwitchPerformance.stop);
    sessionSwitchPerformance.stop();
  });
}
