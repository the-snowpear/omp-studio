import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRendererPerformanceSample, CHROME_PERFORMANCE_CHANNEL } from "../src/chrome-performance-shared.js";
import { registerChromePerformanceIpc } from "../src/chrome-performance.js";
import type { ChromeMetricsSender } from "../src/chrome-metrics.js";

test("numeric report IPC rejects untrusted senders, unknown fields and invalid counters and rate-limits valid reports", () => {
  const handlers = new Map<string, (event: { sender: ChromeMetricsSender }, value?: unknown) => unknown>();
  let now = 0, logs = 0, trusted = true;
  const ipc = registerChromePerformanceIpc({ ipcMain: { handle: (name, callback) => { handlers.set(name, callback); }, removeHandler: (name) => { handlers.delete(name); } },
    isTrustedSender: () => trusted, now: () => now, emit: () => { logs++; } });
  const sender = { isDestroyed: () => false, getURL: () => "https://app.invalid/" };
  const report = { role: "renderer", counters: { "conversation.engines.active": 1 } };
  const receive = handlers.get(CHROME_PERFORMANCE_CHANNEL)!;
  for (const payload of [null, { ...report, path: "private" }, { ...report, rssBytes: 12 },
    { ...report, counters: { secret: 1 } }, { ...report, counters: { "conversation.engines.active": -1 } },
    { ...report, heapUsedBytes: NaN }, { ...report, heapUsedBytes: Number.POSITIVE_INFINITY }]) {
    assert.equal(parseRendererPerformanceSample(payload), undefined);
    assert.equal(receive({ sender }, payload), false);
  }
  trusted = false; assert.equal(receive({ sender }, report), false);
  trusted = true; assert.equal(receive({ sender }, report), true); assert.equal(logs, 1);
  assert.equal(receive({ sender }, report), false);
  now = 60000; assert.equal(receive({ sender }, report), true); assert.equal(logs, 1);
  now = 120000; assert.equal(receive({ sender }, { ...report, counters: { "conversation.engines.active": 0 } }), true); assert.equal(logs, 2);
  ipc.dispose(); ipc.dispose(); assert.equal(handlers.size, 0);
});
