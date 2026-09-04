/**
 * 进程内存投影：不外传 pid / 路径，按工作集降序。
 *
 * 这是「3GB 涨到没人拦」那次排查的直接产物 —— 面板本身不修性能问题，但没有它
 * 连「涨的是哪个进程」都答不出来。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseChromeMetricsPayload, projectProcessMemory } from "../src/chrome-metrics-shared.js";
import { registerChromeMetricsIpc, type ChromeMetricsSender } from "../src/chrome-metrics.js";

const AT = "2026-08-31T00:00:00.000Z";

function sender(overrides: Partial<ChromeMetricsSender> = {}): ChromeMetricsSender {
  return { isDestroyed: () => false, getURL: () => "app://renderer/index.html", ...overrides };
}

test("投影只保留进程类型与工作集，pid 与路径不外传", () => {
  const sample = projectProcessMemory(
    [
      { type: "Browser", pid: 1234, name: "main", memory: { workingSetSize: 120_000, peakWorkingSetSize: 130_000 } },
      { type: "Tab", pid: 5678, memory: { workingSetSize: 900_000 } },
    ] as never,
    AT,
  );
  assert.equal(sample.capturedAt, AT);
  assert.equal(sample.totalWorkingSetKb, 1_020_000);
  // 降序：一眼看出谁在涨。
  assert.deepEqual(sample.rows.map((row) => row.kind), ["Tab", "Browser"]);
  const serialized = JSON.stringify(sample);
  assert.ok(!serialized.includes("1234") && !serialized.includes("5678"), "pid 不得出现在投影里");
  assert.ok(!serialized.includes("main"), "进程名不得出现在投影里");
  assert.equal(sample.rows[1]?.peakWorkingSetKb, 130_000);
  assert.equal(sample.rows[0]?.peakWorkingSetKb, undefined);
});

test("同类型多进程用序号区分，未知类型归到 Unknown", () => {
  const sample = projectProcessMemory(
    [
      { type: "Tab", memory: { workingSetSize: 300 } },
      { type: "Tab", memory: { workingSetSize: 200 } },
      { type: "Something else", memory: { workingSetSize: 100 } },
    ] as never,
    AT,
  );
  assert.deepEqual(
    sample.rows.map((row) => [row.kind, row.ordinal, row.workingSetKb]),
    [["Tab", 1, 300], ["Tab", 2, 200], ["Unknown", 1, 100]],
  );
});

test("缺失或畸形的 memory 记为 0，不抛", () => {
  const sample = projectProcessMemory(
    [{ type: "Tab" }, { type: "GPU", memory: { workingSetSize: "nope" } }] as never,
    AT,
  );
  assert.equal(sample.totalWorkingSetKb, 0);
  assert.equal(sample.rows.length, 2);
});

test("载荷校验：只接受空对象或 undefined", () => {
  assert.equal(parseChromeMetricsPayload(undefined), true);
  assert.equal(parseChromeMetricsPayload({}), true);
  assert.equal(parseChromeMetricsPayload({ pid: 1 }), false);
  assert.equal(parseChromeMetricsPayload([]), false);
  assert.equal(parseChromeMetricsPayload(null), false);
});

test("不受信任的调用方、畸形载荷与采样异常都返回 null 而不抛", () => {
  const handlers = new Map<string, (event: { sender: ChromeMetricsSender }, payload?: unknown) => unknown>();
  const ipcMain = {
    handle(channel: string, listener: (event: { sender: ChromeMetricsSender }, payload?: unknown) => unknown) {
      handlers.set(channel, listener);
    },
    removeHandler(channel: string) {
      handlers.delete(channel);
    },
  };
  let trusted = true;
  let throwOnSample = false;
  const handle = registerChromeMetricsIpc({
    ipcMain,
    isTrustedSender: () => trusted,
    actions: {
      appMetrics: () => {
        if (throwOnSample) throw new Error("boom");
        return [{ type: "Browser", memory: { workingSetSize: 10 } }];
      },
      now: () => new Date(AT),
    },
  });
  const [listener] = [...handlers.values()];
  assert.ok(listener !== undefined);

  assert.equal((listener({ sender: sender() }, {}) as { totalWorkingSetKb: number }).totalWorkingSetKb, 10);
  assert.equal(listener({ sender: sender() }, { pid: 1 }), null, "畸形载荷");
  assert.equal(listener({ sender: sender({ isDestroyed: () => true }) }, {}), null, "已销毁的 sender");
  trusted = false;
  assert.equal(listener({ sender: sender() }, {}), null, "不受信任的 sender");
  trusted = true;
  throwOnSample = true;
  assert.equal(listener({ sender: sender() }, {}), null, "采样抛错时不外泄");

  handle.dispose();
  assert.equal(handlers.size, 0);
});
