import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCounterRegistry,
  createDiagnosticsSampler,
  createMemorySampleGate,
  formatMemorySampleLine,
  normalizeMemorySample,
  sanitizeCounters,
  selectCounters,
  type MemorySample,
} from "../src/performance-diagnostics.js";

const MiB = 1024 * 1024;

test("registry namespaces counters and rejects a duplicate provider name", () => {
  const registry = createCounterRegistry();
  registry.register("store", () => ({ items: 3, bytes: 1024 }));
  assert.throws(() => registry.register("store", () => ({ items: 9 })), /already registered/u);
  assert.deepEqual(registry.collect(), { "store.items": 3, "store.bytes": 1024 });
  assert.equal(registry.providerCount(), 1);
});

test("unregister is idempotent and never removes a later provider under the same name", () => {
  const registry = createCounterRegistry();
  const first = registry.register("engine", () => ({ live: 1 }));
  first();
  first();
  assert.equal(registry.providerCount(), 0);
  registry.register("engine", () => ({ live: 2 }));
  // The stale unregister must not tear down the replacement.
  first();
  assert.deepEqual(registry.collect(), { "engine.live": 2 });
  assert.equal(registry.providerCount(), 1);
});

test("a throwing provider only loses its own counters", () => {
  const registry = createCounterRegistry();
  registry.register("healthy", () => ({ ok: 1 }));
  registry.register("broken", () => {
    throw new Error("boom");
  });
  registry.register("alsoHealthy", () => ({ ok: 2 }));
  assert.deepEqual(registry.collect(), { "healthy.ok": 1, "alsoHealthy.ok": 2 });
});

test("invalid numbers and dynamic keys are dropped, not coerced", () => {
  assert.deepEqual(
    sanitizeCounters({
      fine: 4,
      zero: 0,
      negative: -1,
      nan: Number.NaN,
      infinite: Number.POSITIVE_INFINITY,
      text: "12",
      "C:\\Users\\someone\\session.jsonl": 1,
      "My session title": 2,
      "Upper": 3,
    }),
    { fine: 4, zero: 0 },
  );
  assert.deepEqual(sanitizeCounters(null), {});
  assert.deepEqual(sanitizeCounters([1, 2]), {});
  assert.throws(() => createCounterRegistry().register("Bad Name", () => ({})), /invalid diagnostics provider name/u);
});

test("selectCounters follows the allow-list and keeps missing values missing", () => {
  const selected = selectCounters({ "a.x": 1, "a.y": 2, "b.z": 3 }, ["a.x", "b.z", "c.missing"]);
  assert.deepEqual(selected, { "a.x": 1, "b.z": 3 });
  assert.equal("c.missing" in selected, false);
});

test("normalizeMemorySample drops invalid memory fields instead of zeroing them", () => {
  const sample = normalizeMemorySample({
    role: "renderer",
    rssBytes: -5,
    heapUsedBytes: 10 * MiB,
    externalBytes: Number.NaN,
    counters: { ok: 1, bad: -1 },
  });
  assert.deepEqual(sample, { role: "renderer", heapUsedBytes: 10 * MiB, counters: { ok: 1 } });
  assert.equal("rssBytes" in sample, false);
});

function gateWithClock(startMs = 0, overrides: Partial<Parameters<typeof createMemorySampleGate>[0]> = {}) {
  let now = startMs;
  const gate = createMemorySampleGate({ now: () => now, ...overrides });
  return { gate, advance: (ms: number) => { now += ms; } };
}

const base = (extra: Partial<MemorySample> = {}): MemorySample => ({
  role: "main-host",
  rssBytes: 200 * MiB,
  heapUsedBytes: 40 * MiB,
  heapTotalBytes: 60 * MiB,
  externalBytes: 8 * MiB,
  arrayBuffersBytes: 2 * MiB,
  counters: { "host.residents": 1, "host.listeners": 3 },
  ...extra,
});

test("a static sample logs once, then only on the heartbeat", () => {
  const { gate, advance } = gateWithClock(1_000, { heartbeatMs: 5 * 60_000 });
  assert.deepEqual(gate.observe(base()), { log: true, reason: "first", seq: 1 });
  for (let i = 0; i < 4; i += 1) {
    advance(60_000);
    assert.deepEqual(gate.observe(base()), { log: false, seq: 1 });
  }
  advance(60_000);
  assert.deepEqual(gate.observe(base()), { log: true, reason: "heartbeat", seq: 2 });
  advance(60_000);
  assert.deepEqual(gate.observe(base()), { log: false, seq: 2 });
});

test("heap uses the 5% threshold and native memory the 10% threshold", () => {
  const { gate } = gateWithClock();
  gate.observe(base());
  // 4% heap growth (1.6 MiB > 1 MiB floor) is below the 5% heap threshold.
  assert.equal(gate.observe(base({ heapUsedBytes: 41.6 * MiB })).log, false);
  // The baseline did not move, so 5% against the original 40 MiB now logs.
  assert.deepEqual(gate.observe(base({ heapUsedBytes: 42 * MiB })), { log: true, reason: "memory", seq: 2 });
  // 8% RSS growth is below the native threshold; 10% is not.
  assert.equal(gate.observe(base({ heapUsedBytes: 42 * MiB, rssBytes: 216 * MiB })).log, false);
  assert.deepEqual(gate.observe(base({ heapUsedBytes: 42 * MiB, rssBytes: 220 * MiB })), { log: true, reason: "memory", seq: 3 });
});

test("native memory growing on its own is reported even with a flat heap", () => {
  const { gate } = gateWithClock();
  gate.observe(base());
  const decision = gate.observe(base({ externalBytes: 20 * MiB }));
  assert.deepEqual(decision, { log: true, reason: "memory", seq: 2 });
  gate.observe(base({ externalBytes: 20 * MiB }));
  assert.equal(gate.observe(base({ externalBytes: 20 * MiB, arrayBuffersBytes: 6 * MiB })).log, true);
});

test("a zero or tiny baseline does not turn every sample into a log line", () => {
  const { gate } = gateWithClock();
  gate.observe(base({ externalBytes: 0, arrayBuffersBytes: 0 }));
  // 0 → 512 KiB is an infinite ratio but under the 1 MiB floor: noise.
  assert.equal(gate.observe(base({ externalBytes: 512 * 1024, arrayBuffersBytes: 0 })).log, false);
  assert.equal(gate.observe(base({ externalBytes: 900 * 1024, arrayBuffersBytes: 0 })).log, false);
  // Crossing the floor from a zero base is real growth.
  assert.equal(gate.observe(base({ externalBytes: 2 * MiB, arrayBuffersBytes: 0 })).log, true);
});

test("a memory field appearing or disappearing counts as a change", () => {
  const { gate } = gateWithClock();
  gate.observe({ role: "renderer", counters: {} });
  assert.deepEqual(gate.observe({ role: "renderer", heapUsedBytes: 5 * MiB, counters: {} }), { log: true, reason: "memory", seq: 2 });
  assert.deepEqual(gate.observe({ role: "renderer", counters: {} }), { log: true, reason: "memory", seq: 3 });
});

test("counters going down is a change worth logging", () => {
  const { gate } = gateWithClock();
  gate.observe(base());
  assert.deepEqual(gate.observe(base({ counters: { "host.residents": 1, "host.listeners": 2 } })), { log: true, reason: "counters", seq: 2 });
  // A counter vanishing (provider unregistered) also logs.
  assert.deepEqual(gate.observe(base({ counters: { "host.residents": 1 } })), { log: true, reason: "counters", seq: 3 });
  assert.equal(gate.observe(base({ counters: { "host.residents": 1 } })).log, false);
});

test("reset forgets the baseline", () => {
  const { gate } = gateWithClock();
  gate.observe(base());
  gate.reset();
  assert.deepEqual(gate.observe(base()), { log: true, reason: "first", seq: 2 });
});

test("formatMemorySampleLine renders present fields only and stays within the cap", () => {
  const line = formatMemorySampleLine(
    { role: "renderer", heapUsedBytes: 12_345_678.9, counters: { "store.items": 12, "store.ratio": 0.5 } },
    { prefix: { seq: 3, reason: "first", instance: "h1" } },
  );
  assert.equal(line, "role=renderer seq=3 reason=first instance=h1 heapUsedBytes=12345679 store.items=12 store.ratio=0.500");
  assert.equal(line.includes("rssBytes"), false);

  const many: Record<string, number> = {};
  for (let i = 0; i < 400; i += 1) many[`m.counter${i}`] = i;
  const bounded = formatMemorySampleLine({ role: "main-host", rssBytes: 1, counters: many }, { maxLength: 300 });
  assert.ok(bounded.length <= 300, `line is ${bounded.length} chars`);
  assert.match(bounded, / …\+\d+$/u);
  assert.ok(formatMemorySampleLine({ role: "runtime", counters: { "host.items": 1 } }, { maxLength: 5 }).length <= 5);
  // Default cap fits under HostLog's 2000-char detail limit.
  const wide = formatMemorySampleLine({ role: "main-host", counters: many });
  assert.ok(wide.length <= 1900);
});

test("formatMemorySampleLine ignores prefix values that look like content or paths", () => {
  const line = formatMemorySampleLine(
    { role: "runtime", counters: {} },
    { prefix: { title: "My chat about C:\\secret", path: "/home/me/x", ok: "abc-1" } },
  );
  assert.equal(line, "role=runtime ok=abc-1");
});

test("sampler never overlaps samples and stops after dispose", async () => {
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const emitted: string[] = [];
  let resolveSample: ((sample: MemorySample) => void) | undefined;
  let sampleCalls = 0;
  const { gate } = gateWithClock();
  const sampler = createDiagnosticsSampler({
    intervalMs: 60_000,
    gate,
    sample: () => {
      sampleCalls += 1;
      return new Promise<MemorySample>((resolve) => {
        resolveSample = resolve;
      });
    },
    emit: (_sample, decision) => emitted.push(decision.reason ?? "?"),
    setInterval: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (handle) => {
      timers.delete(handle as number);
    },
  });
  sampler.start();
  sampler.start();
  assert.equal(timers.size, 1);
  assert.equal(sampler.running, true);
  const fire = () => { for (const callback of [...timers.values()]) callback(); };

  fire();
  fire();
  fire();
  assert.equal(sampleCalls, 1, "a slow sample must not be re-entered");
  resolveSample!(base());
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(emitted, ["first"]);

  fire();
  assert.equal(sampleCalls, 2);
  sampler.dispose();
  assert.equal(timers.size, 0);
  assert.equal(sampler.running, false);
  // A sample that resolves after dispose is discarded.
  resolveSample!(base({ heapUsedBytes: 400 * MiB }));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(emitted, ["first"]);
  await sampler.tick();
  assert.equal(sampleCalls, 2, "tick after dispose must not sample");
  sampler.start();
  assert.equal(timers.size, 0, "a disposed sampler cannot be restarted");
});

test("sampler skips a failing sample and a failing sink without dying", async () => {
  const { gate } = gateWithClock();
  let calls = 0;
  const sampler = createDiagnosticsSampler({
    gate,
    sample: () => {
      calls += 1;
      if (calls === 1) throw new Error("no memory API");
      return base();
    },
    emit: () => {
      throw new Error("sink is broken");
    },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  await sampler.tick();
  await sampler.tick();
  await sampler.tick();
  assert.equal(calls, 3);
});
