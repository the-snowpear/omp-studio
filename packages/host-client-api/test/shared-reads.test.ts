import assert from "node:assert/strict";
import test from "node:test";
import { SharedArchiveTelemetry, SharedProjectReads } from "../src/shared-reads.js";

test("two views share project reads; invalidated in-flight results cannot repopulate the cache", async () => {
  const reads = new SharedProjectReads();
  let resolve!: (value: number) => void, calls = 0;
  const run = () => { calls++; return new Promise<number>(done => { resolve = done; }); };
  const a = reads.read("workspace:models", run), b = reads.read("workspace:models", run);
  await Promise.resolve();
  assert.equal(calls, 1);
  reads.invalidate(); resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  assert.equal(await reads.read("workspace:models", async () => 2), 2);
});

test("closing one view keeps another view's telemetry; last consumer cancels and serial cleanup completes before next probe", async () => {
  const reads = new SharedArchiveTelemetry<number>();
  const first = new AbortController(), second = new AbortController(), third = new AbortController();
  let calls = 0, cleaned = false;
  let finishCleanup!: () => void;
  const run = (signal: AbortSignal) => new Promise<number>(resolve => {
    calls++;
    signal.addEventListener("abort", () => { finishCleanup = () => { cleaned = true; resolve(1); }; });
  });
  const a = reads.read("a", first.signal, run), b = reads.read("a", second.signal, run);
  const aRejected = assert.rejects(a), bRejected = assert.rejects(b);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  first.abort(); await aRejected; assert.equal(typeof finishCleanup, "undefined");
  second.abort(); await bRejected;
  const c = reads.read("b", third.signal, async () => { assert.equal(cleaned, true); return 2; });
  finishCleanup(); assert.equal(await c, 2);
});

test("an abandoned queued telemetry read never starts; explicit refresh bypasses successful cache", async () => {
  const reads = new SharedArchiveTelemetry<number>();
  const active = new AbortController(), queued = new AbortController();
  let finish!: (n: number) => void, calls = 0;
  const a = reads.read("a", active.signal, () => new Promise<number>(resolve => { finish = resolve; }));
  const b = reads.read("b", queued.signal, async () => { calls++; return 4; });
  const rejected = assert.rejects(b); queued.abort(); await rejected;
  await new Promise(resolve => setImmediate(resolve)); finish(1); await a;
  assert.equal(await reads.read("a", active.signal, async () => 2), 1);
  assert.equal(await reads.read("a", active.signal, async () => 3, true), 3);
  assert.equal(calls, 0);
});
