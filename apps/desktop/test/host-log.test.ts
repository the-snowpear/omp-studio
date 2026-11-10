import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { formatMemorySampleLine, type MemorySample } from "@omp-studio/studio-protocol";
import { parseRendererPerformanceSample } from "../src/chrome-performance-shared.js";
import { logRendererPerformance, startHostPerformance } from "../src/desktop-performance.js";
import { createHostFileLog, performanceSampleNumericFields } from "../src/host-log.js";

/** Never written to — `append` is injected — but `createHostFileLog` still mkdirs it. */
const DIRECTORY = join(tmpdir(), "omp-studio-host-log-test");

/** Appends resolved on demand so the test can observe the in-flight window. */
function controlledAppend() {
  const lines: string[] = [];
  const waiting: (() => void)[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const append = (_path: string, line: string): Promise<void> => {
    lines.push(line);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    return new Promise<void>((resolve) => {
      waiting.push(() => {
        inFlight -= 1;
        resolve();
      });
    });
  };
  // No append may exist yet while the real mkdir is still awaiting disk I/O.
  const releaseAll = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!done() || waiting.length > 0 || inFlight > 0) {
      assert.ok(Date.now() < deadline, "expected log writes must finish");
      waiting.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { append, lines, releaseAll, maxInFlight: () => maxInFlight };
}

test("host log appends are serialized: one write is in flight at a time", async () => {
  const appender = controlledAppend();
  const log = createHostFileLog({ directory: DIRECTORY, append: appender.append });
  for (let index = 0; index < 50; index += 1) {
    log.write("info", "runtime.stderr", `line-${index}`);
  }
  await appender.releaseAll(() => appender.lines.length === 50);

  assert.equal(appender.maxInFlight(), 1);
  assert.equal(appender.lines.length, 50);
  assert.match(appender.lines[0] ?? "", /runtime\.stderr line-0\n$/u);
  assert.match(appender.lines[49] ?? "", /runtime\.stderr line-49\n$/u);
});

test("a chatty runtime is dropped at the backlog cap and accounted in one line", async () => {
  const appender = controlledAppend();
  const log = createHostFileLog({ directory: DIRECTORY, append: appender.append });
  const total = 3_000;
  for (let index = 0; index < total; index += 1) {
    log.write("info", "runtime.stderr", `line-${index}`);
  }
  await appender.releaseAll(() => appender.lines.some((line) => line.includes("host.log_dropped")));

  assert.ok(appender.lines.length < total, "the backlog must be bounded, not queued in full");
  const dropped = appender.lines.filter((line) => line.includes("host.log_dropped"));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0] ?? "", /host\.log_dropped lines=(\d+)\n$/u);
  const count = Number(/lines=(\d+)/u.exec(dropped[0] ?? "")?.[1]);
  // Every line is either written or counted exactly once (the summary itself is extra).
  assert.equal(appender.lines.length - 1 + count, total);
});

test("structured performance fields retain bytes and timings without exempting sensitive detail", async () => {
  const appender = controlledAppend();
  const log = createHostFileLog({ directory: DIRECTORY, append: appender.append });
  const sample: MemorySample = {
    role: "main-host", rssBytes: 234567890, heapUsedBytes: 123456789,
    counters: { "host.replayBytes": 34567890, "host.sampleMs": 12345, "host.pid": 54321 },
  };
  const detail = `${formatMemorySampleLine(sample, { prefix: { instance: 12345, seq: 67890, reason: "memory" } })} pid=12345 unknownId=123456789 token=sk-synthetic-log-secret path=C:\\Users\\alice\\project externalBytes=sk-synthetic-log-string`;
  log.write("info", "performance.sample", detail, performanceSampleNumericFields(sample));
  // Merely naming an event performance.sample does not opt arbitrary detail in.
  log.write("info", "performance.sample", detail);
  await appender.releaseAll(() => appender.lines.length === 2);

  const [numeric = "", generic = ""] = appender.lines;
  assert.match(numeric, /rssBytes=234567890 heapUsedBytes=123456789/u);
  assert.match(numeric, /host\.replayBytes=34567890 host\.sampleMs=12345/u);
  assert.match(numeric, /instance=12345 seq=67890/u);
  assert.match(numeric, /host\.pid=\[redacted\]/u);
  assert.match(numeric, / pid=\[redacted\] unknownId=\[redacted\]/u);
  assert.match(numeric, /token=\[redacted\]/u);
  assert.match(numeric, /externalBytes=\[redacted\]/u);
  assert.ok(!numeric.includes("C:\\Users\\alice\\project"));
  assert.doesNotMatch(numeric, /sk-synthetic/u);
  assert.match(generic, /heapUsedBytes=\[redacted\]/u);
  assert.match(generic, /host\.sampleMs=\[redacted\]/u);
});

test("Runtime numeric stderr preserves only the dedicated sampler fields", async () => {
  const appender = controlledAppend();
  const log = createHostFileLog({ directory: DIRECTORY, append: appender.append });
  const sample: MemorySample = {
    role: "runtime", rssBytes: 234567890, heapUsedBytes: 123456789,
    counters: { blockBytes: 87654321, workerGeneration: 12345 },
  };
  const detail = `[studio.performance] ${formatMemorySampleLine(sample, { prefix: { seq: 12345, reason: "heartbeat" } })} pid=12345 unknownBytes=123456789 credential=sk-synthetic-runtime-secret path=/home/alice/project heapTotalBytes=sk-synthetic-runtime-string`;
  log.write("info", "runtime.stderr", detail);
  log.write("info", "runtime.stderr", detail.replace("[studio.performance] ", ""));
  await appender.releaseAll(() => appender.lines.length === 2);

  const [numeric = "", ordinary = ""] = appender.lines;
  assert.match(numeric, /\[studio\.performance\] role=runtime seq=12345/u);
  assert.match(numeric, /rssBytes=234567890 heapUsedBytes=123456789/u);
  assert.match(numeric, /blockBytes=87654321 workerGeneration=12345/u);
  assert.match(numeric, / pid=\[redacted\] unknownBytes=\[redacted\]/u);
  assert.match(numeric, /credential=\[redacted\]/u);
  assert.match(numeric, /heapTotalBytes=\[redacted\]/u);
  assert.ok(!numeric.includes("/home/alice/project"));
  assert.doesNotMatch(numeric, /sk-synthetic/u);
  assert.match(ordinary, /heapUsedBytes=\[redacted\]/u);
  assert.match(ordinary, /blockBytes=\[redacted\]/u);
});

test("main-host and renderer performance samples survive the final file logger", async (context) => {
  const memory = { rss: 234567890, heapUsed: 123456789, heapTotal: 345678901, external: 12345678, arrayBuffers: 12345 };
  context.mock.method(process, "memoryUsage", Object.assign(() => memory, { rss: () => memory.rss }));
  const appender = controlledAppend();
  const log = createHostFileLog({ directory: DIRECTORY, append: appender.append });
  const stop = startHostPerformance(log);
  try {
    const renderer = parseRendererPerformanceSample({
      role: "renderer", heapUsedBytes: 456789012, heapTotalBytes: 567890123,
      counters: { "highlight.cacheBytes": 123456789, "conversation.engines.openBufferBytes": 12345 },
    });
    assert.ok(renderer);
    logRendererPerformance(renderer, { log: true, seq: 12345, reason: "memory" }, 54321);
    await appender.releaseAll(() => appender.lines.length === 2);

    const host = appender.lines.find((line) => line.includes("performance.sample role=main-host ")) ?? "";
    const rendererLog = appender.lines.find((line) => line.includes("performance.sample role=renderer ")) ?? "";
    assert.match(host, /rssBytes=234567890 heapUsedBytes=123456789 heapTotalBytes=345678901/u);
    assert.match(host, /externalBytes=12345678 arrayBuffersBytes=12345/u);
    assert.match(rendererLog, /instance=54321 seq=12345/u);
    assert.match(rendererLog, /heapUsedBytes=456789012 heapTotalBytes=567890123/u);
    assert.match(rendererLog, /highlight\.cacheBytes=123456789 conversation\.engines\.openBufferBytes=12345/u);
    assert.doesNotMatch(host + rendererLog, /\[redacted\]/u);
  } finally {
    stop();
  }
});
