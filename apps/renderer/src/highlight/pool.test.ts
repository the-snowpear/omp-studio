import { afterEach, describe, expect, it, vi } from "vitest";
import { HighlightPool, type HighlightWorkerPort } from "./pool";
import { type HighlightRequest, validateTokens } from "./protocol";

class FakeWorker implements HighlightWorkerPort {
  onmessage: HighlightWorkerPort["onmessage"] = null;
  onerror: HighlightWorkerPort["onerror"] = null;
  onmessageerror: HighlightWorkerPort["onmessageerror"] = null;
  requests: HighlightRequest[] = [];
  terminated = false;
  postMessage(request: HighlightRequest) { this.requests.push(request); }
  terminate() { this.terminated = true; }
  reply(request = this.requests.at(-1)!, tokens = [{ type: "text" as const, value: request.code }]) {
    this.onmessage?.({ data: { version: 1, jobId: request.jobId, ok: true, tokens } } as MessageEvent);
  }
}
const pools: HighlightPool[] = [];
function setup(cores = 8) {
  const workers: FakeWorker[] = [];
  const pool = new HighlightPool({ cores, createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
  pools.push(pool);
  return { pool, workers };
}
afterEach(() => { for (const pool of pools.splice(0)) pool.dispose(); vi.useRealTimers(); });

describe("bounded highlight workers", () => {
  it("starts lazily, deduplicates full content and reuses cached tokens on remount", async () => {
    const { pool, workers } = setup(); const result = vi.fn();
    expect(workers).toHaveLength(0);
    const a = pool.request("js", "const a = 1", { priority: () => "visible", result });
    pool.request("js", "const a = 1", { priority: () => "overscan", result });
    expect(workers).toHaveLength(1); expect(workers[0]!.requests).toHaveLength(1);
    a.cancel(); workers[0]!.reply(); expect(result).toHaveBeenCalledTimes(1);
    pool.request("js", "const a = 1", { priority: () => "visible", result }); await Promise.resolve();
    expect(result).toHaveBeenCalledTimes(2); expect(workers[0]!.requests).toHaveLength(1);
    pool.request("js", "const b = 1", { priority: () => "visible", result });
    expect(workers[0]!.requests).toHaveLength(2);
  });
  it("ignores out-of-order and duplicate replies, without delivering cancelled work", () => {
    const { pool, workers } = setup(); const a = vi.fn(), b = vi.fn();
    const handle = pool.request("js", "a", { priority: () => "visible", result: a });
    pool.request("js", "b", { priority: () => "visible", result: b });
    const wa = workers[0]!, wb = workers[1]!;
    wa.reply(wb.requests[0]!); expect(a).not.toHaveBeenCalled();
    handle.cancel(); wb.reply(); wa.reply(); wb.reply();
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1);
    expect(pool.getDiagnostics().running).toBe(0);
  });
  it("bounds queue count and bytes, schedules visible before overscan and cancels waiting", () => {
    const { pool, workers } = setup(2); const result = vi.fn();
    pool.request("js", "running", { priority: () => "visible", result });
    const cancel = pool.request("js", "cancel", { priority: () => "overscan", result });
    pool.request("js", "overscan", { priority: () => "overscan", result });
    pool.request("js", "visible", { priority: () => "visible", result });
    cancel.cancel();
    workers[0]!.reply();
    expect(workers[0]!.requests.at(-1)?.code).toBe("visible");
    for (let i = 0; i < 50; i++) pool.request("js", `queued${i}`, { priority: () => "visible", result });
    expect(pool.getDiagnostics().queued).toBe(32);
    expect(workers).toHaveLength(1);
    pool.dispose();
    const large = setup(1);
    for (let i = 0; i < 40; i++) large.pool.request("js", `${i}${"中".repeat(32000)}`, { priority: () => "visible", result });
    expect(large.pool.getDiagnostics().queueBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(large.pool.getDiagnostics().queued).toBeLessThan(32);
  });
  it("starts the five-second timeout at dispatch, terminates stuck work and never retries it on the main thread", () => {
    vi.useFakeTimers(); const { pool, workers } = setup(1); const a = vi.fn(), b = vi.fn();
    pool.request("js", "a", { priority: () => "visible", result: a });
    pool.request("js", "b", { priority: () => "visible", result: b });
    vi.advanceTimersByTime(4999); expect(a).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(a).toHaveBeenCalledWith({ ok: false, reason: "timeout" }); expect(workers[0]!.terminated).toBe(true);
    expect(b).not.toHaveBeenCalled(); expect(workers).toHaveLength(2);
    workers[1]!.reply(); expect(b).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(29999); expect(pool.getDiagnostics().workers).toBe(1);
    vi.advanceTimersByTime(1); expect(pool.getDiagnostics().workers).toBe(0);
  });
  it("retries one crash once and disables automatic restart after another crash", () => {
    const { pool, workers } = setup(1); const result = vi.fn();
    pool.request("js", "crash", { priority: () => "visible", result });
    const original = workers[0]!.requests[0]!.jobId;
    workers[0]!.onerror?.(new ErrorEvent("error"));
    expect(workers).toHaveLength(2); expect(workers[1]!.requests[0]!.jobId).not.toBe(original);
    workers[1]!.onerror?.(new ErrorEvent("error"));
    expect(result).toHaveBeenCalledTimes(1);
    expect(pool.request("js", "later", { priority: () => "visible", result }).status).toBe("rejected");
    expect(pool.getDiagnostics().workers).toBe(0);
  });
  it("rejects unsafe, mismatched, deep and oversized token trees before rendering", () => {
    expect(validateTokens([{ type: "script", value: "x" }], "x")).toBe(false);
    expect(validateTokens([{ type: "span", classes: ["evil"], children: [] }], "")).toBe(false);
    expect(validateTokens([{ type: "text", value: "x", onclick: "evil" }], "x")).toBe(false);
    expect(validateTokens([{ type: "text", value: "different" }], "x")).toBe(false);
    let deep: unknown = [{ type: "text", value: "x" }];
    for (let i = 0; i < 65; i++) deep = [{ type: "span", classes: ["hljs-keyword"], children: deep }];
    expect(validateTokens(deep, "x")).toBe(false);
    expect(validateTokens(Array.from({ length: 40001 }, () => ({ type: "text", value: "" })), "")).toBe(false);
    const { pool, workers } = setup(1); const result = vi.fn();
    pool.request("js", "x", { priority: () => "visible", result }); workers[0]!.reply(undefined, [{ type: "text", value: "wrong" }]);
    expect(result).toHaveBeenCalledWith({ ok: false, reason: "worker-result-rejected" });
  });
  it("enforces LRU entry/byte budgets and releases workers, subscriptions and queued source on dispose", () => {
    vi.useFakeTimers(); const { pool, workers } = setup(1);
    for (let i = 0; i < 160; i++) { pool.request("js", `${i}${"x".repeat(90000)}`, { priority: () => "visible", result: vi.fn() }); workers[0]!.reply(); }
    expect(pool.getDiagnostics().cacheEntries).toBeLessThanOrEqual(128);
    expect(pool.getDiagnostics().cacheBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const before = workers[0]!.requests.length;
    pool.request("js", `159${"x".repeat(90000)}`, { priority: () => "visible", result: vi.fn() });
    expect(workers[0]!.requests.length).toBe(before);
    pool.onSlot(vi.fn()); pool.dispose(); pool.dispose();
    expect(pool.getDiagnostics()).toMatchObject({ workers: 0, running: 0, queued: 0, queueBytes: 0, cacheEntries: 0, cacheBytes: 0, slotListeners: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
