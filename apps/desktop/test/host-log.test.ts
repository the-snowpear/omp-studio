import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHostFileLog } from "../src/host-log.js";

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
