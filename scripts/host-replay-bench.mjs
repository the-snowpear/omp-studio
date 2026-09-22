/**
 * Host 侧流式热路径的 Node 基准（W00 第 3 项）。
 *
 * 量的是每个 token 都会跑到的几条路径：
 *   - `ConversationEventFanout.forward()`：解析、分配 streamSeq、记入有界 replay、投递订阅者。
 *   - 文本 delta 的追加与 `snapshot()`。
 *   - 工具输出的 append / replace / snapshot。
 *   - `parseConversationRuntimeEvent()` 的首次与重复调用（W05 的复用路径）。
 *
 * 判定用中位数，同时记录最差值：Windows 上单次运行会被 GC 和调度噪声拉长，只看均值
 * 会把一次停顿当成回归。每个场景先预热两轮再正式跑 5 轮。
 *
 * 用法：
 *   node scripts/host-replay-bench.mjs
 *   PERF_BENCH_REPORT=outputs/perf/w04-after.json node scripts/host-replay-bench.mjs
 *   PERF_BENCH_RUNS=9 node scripts/host-replay-bench.mjs
 *
 * 报告写进 `outputs/perf/`（gitignored）。脚本只读构建产物，不改任何产品行为，
 * 也不读 backup/、用户真实对话或 zcode 运行数据。
 */
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConversationEventFanout } from "@omp-studio/studio-host";
import { parseConversationRuntimeEvent } from "@omp-studio/studio-protocol";

const root = fileURLToPath(new URL("..", import.meta.url));
const RUNS = Number(process.env.PERF_BENCH_RUNS ?? 5);
const reportPath = process.env.PERF_BENCH_REPORT ?? join(root, "outputs", "perf", "host-replay-bench.json");

const SESSION = "bench-session";
const TURN = "bench-turn";

function git(...args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** 基线身份：没有它，两份报告之间的差值没有意义。 */
function identity() {
  const status = git("status", "--porcelain");
  return {
    commit: git("rev-parse", "HEAD"),
    shortCommit: git("rev-parse", "--short", "HEAD"),
    branch: git("rev-parse", "--abbrev-ref", "HEAD"),
    dirty: status.length > 0,
    dirtyFiles: status.length === 0 ? [] : status.split(/\r?\n/).map((line) => line.slice(3)).slice(0, 40),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemBytes: totalmem(),
    runs: RUNS,
  };
}

function envelope(eventSeq, event) {
  return {
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq,
    stateVersion: 1,
    occurredAt: "2026-09-22T00:00:00.000Z",
    event,
  };
}

const textDelta = (delta) => ({
  kind: "conversation.message.delta",
  sessionId: SESSION,
  turnId: TURN,
  messageId: "message-1",
  blockId: "block-0",
  blockType: "text",
  delta,
});

const toolUpdate = (output, updateMode = "append") => ({
  kind: "conversation.tool.updated",
  sessionId: SESSION,
  turnId: TURN,
  toolCallId: "call-1",
  updateMode,
  output,
});

function startTool(fanout, seq) {
  fanout.forward(envelope(seq, {
    kind: "conversation.tool.started",
    sessionId: SESSION,
    turnId: TURN,
    messageId: "message-1",
    toolCallId: "call-1",
    toolName: "Bash",
    startedAt: "2026-09-22T00:00:00.000Z",
  }));
}

/** 一个场景：`prepare()` 建状态（不计时），`body()` 是被测的那段。 */
function measure(prepare, body) {
  const state = prepare();
  const started = process.hrtime.bigint();
  body(state);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function stats(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
  return {
    medianMs: Number(median.toFixed(4)),
    bestMs: Number((sorted[0] ?? 0).toFixed(4)),
    worstMs: Number((sorted.at(-1) ?? 0).toFixed(4)),
    samples: sorted.map((value) => Number(value.toFixed(4))),
  };
}

const SCENARIOS = [
  {
    name: "fanout-forward-text-delta",
    detail: "10,000 次文本 delta 经 forward()（解析 + streamSeq + 有界 replay + 投递）",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        fanout.onEvent(() => {});
        return fanout;
      },
      (fanout) => {
        for (let index = 0; index < 10_000; index += 1) {
          fanout.forward(envelope(index + 1, textDelta("token ")));
        }
      },
    ),
  },
  {
    name: "text-replay-append-then-snapshot",
    detail: "10,000 次文本 delta 后取一次 snapshot()",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        for (let index = 0; index < 10_000; index += 1) {
          fanout.forward(envelope(index + 1, textDelta("token ")));
        }
        return fanout;
      },
      (fanout) => { fanout.snapshot(SESSION); },
    ),
  },
  {
    name: "tool-replay-small-appends",
    detail: "5,000 次小块工具输出追加（每次 41B）——W04 的主目标路径",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        fanout.onEvent(() => {});
        startTool(fanout, 1);
        return fanout;
      },
      (fanout) => {
        const chunk = `${"x".repeat(40)}\n`;
        for (let index = 0; index < 5_000; index += 1) {
          fanout.forward(envelope(index + 2, toolUpdate(chunk)));
        }
      },
    ),
  },
  {
    name: "tool-replay-append-then-snapshot",
    detail: "5,000 次小块追加后取一次 snapshot()（物化 + 结构化克隆）",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        startTool(fanout, 1);
        const chunk = `${"x".repeat(40)}\n`;
        for (let index = 0; index < 5_000; index += 1) {
          fanout.forward(envelope(index + 2, toolUpdate(chunk)));
        }
        return fanout;
      },
      (fanout) => { fanout.snapshot(SESSION); },
    ),
  },
  {
    name: "tool-replay-snapshot-every-50-appends",
    detail: "5,000 次追加，每 50 次取一次 snapshot()——高频 snapshot 不得恶化超过 10%",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        startTool(fanout, 1);
        return fanout;
      },
      (fanout) => {
        const chunk = `${"x".repeat(40)}\n`;
        for (let index = 0; index < 5_000; index += 1) {
          fanout.forward(envelope(index + 2, toolUpdate(chunk)));
          if (index % 50 === 49) fanout.snapshot(SESSION);
        }
      },
    ),
  },
  {
    name: "tool-replay-large-replace",
    detail: "500 次 64KiB 整串 replace——单独报告，不承诺同等收益",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        startTool(fanout, 1);
        return fanout;
      },
      (fanout) => {
        const payload = "y".repeat(64 * 1024);
        for (let index = 0; index < 500; index += 1) {
          fanout.forward(envelope(index + 2, toolUpdate(payload, "replace")));
        }
      },
    ),
  },
  {
    name: "tool-replay-multibyte-appends",
    detail: "5,000 次中文 + emoji 小块追加（跨分片代理对）",
    run: () => measure(
      () => {
        const fanout = new ConversationEventFanout();
        startTool(fanout, 1);
        return fanout;
      },
      (fanout) => {
        const chunk = "编译中…🚀\n";
        for (let index = 0; index < 5_000; index += 1) {
          fanout.forward(envelope(index + 2, toolUpdate(chunk)));
        }
      },
    ),
  },
  {
    name: "parse-conversation-event-first",
    detail: "20,000 个各不相同的事件对象的首次完整解析",
    run: () => measure(
      () => Array.from({ length: 20_000 }, (_value, index) => toolUpdate(`chunk-${index}\n`)),
      (events) => { for (const event of events) parseConversationRuntimeEvent(event); },
    ),
  },
  {
    name: "parse-conversation-event-repeat",
    detail: "同一个已解析对象重复解析 20,000 次（W05 复用路径）",
    run: () => measure(
      () => parseConversationRuntimeEvent(toolUpdate("chunk\n")),
      (parsed) => { for (let index = 0; index < 20_000; index += 1) parseConversationRuntimeEvent(parsed); },
    ),
  },
];

const results = [];
for (const scenario of SCENARIOS) {
  scenario.run();
  scenario.run();
  const samples = [];
  for (let run = 0; run < RUNS; run += 1) samples.push(scenario.run());
  const summary = stats(samples);
  results.push({ name: scenario.name, detail: scenario.detail, ...summary });
  console.log(
    `${scenario.name.padEnd(38)} median ${summary.medianMs.toFixed(3).padStart(9)}ms  `
      + `best ${summary.bestMs.toFixed(3).padStart(9)}ms  worst ${summary.worstMs.toFixed(3).padStart(9)}ms`,
  );
}

const report = { generatedAt: new Date().toISOString(), identity: identity(), scenarios: results };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`host replay bench report: ${reportPath}`);
