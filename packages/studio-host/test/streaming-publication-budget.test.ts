/**
 * 流式发布预算：单个 token 不得再深拷贝未变化的快照与整本账本。
 *
 * 这三组断言守的是同一个回归：`conversation.message.delta` 会推进 `eventSeq`
 * 但不碰 operator 快照（契约里的 `CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION`
 * 就是这个意思），而旧实现在每个 "applied" 事件上都无条件 `snapshot()` +
 * `#publishProjection()` → `ledger.snapshot()`，于是每 token 要深拷贝一份完整快照
 * 再加一份永不淘汰的账本。长对话里单 token 成本随对话时长线性增长。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CommandId,
  CommandLedgerEntry,
  OperatorStateSnapshot,
  RequestId,
  RuntimeEpoch,
  RuntimeId,
  StateVersion,
  StudioReceipt,
  StudioRequest,
} from "@omp-studio/studio-protocol";
import { COMMAND_LEDGER_TERMINAL_CAP, CommandLedger, RuntimePublicationStore } from "../src/index.js";
import type { CommandLedgerStore } from "../src/command-ledger-store.js";

const RUNTIME = "runtime-1" as RuntimeId;
const EPOCH = 1 as RuntimeEpoch;

function request(requestId: string): StudioRequest {
  return {
    type: "studio.request",
    requestId: requestId as RequestId,
    runtimeEpoch: EPOCH,
    idempotencyKey: requestId as StudioRequest["idempotencyKey"],
    operation: { kind: "runtime.pause" },
  } as StudioRequest;
}

function receipt(requestId: string, commandId: string): StudioReceipt {
  return {
    type: "studio.receipt",
    requestId: requestId as RequestId,
    commandId: commandId as CommandId,
    runtimeEpoch: EPOCH,
    stateVersion: 1 as StateVersion,
    status: "completed",
  } as StudioReceipt;
}

/** 走一遍 requested → accepted → completed，落成终态。 */
function settle(ledger: CommandLedger, index: number): void {
  const id = `cmd-${index}` as CommandId;
  ledger.request(id, request(`req-${index}`), RUNTIME);
  ledger.transition(id, "accepted");
  ledger.transition(id, "completed");
}

test("账本容量只淘汰终态条目，在飞条目永不被淘汰", () => {
  const ledger = new CommandLedger(() => "2026-08-31T00:00:00.000Z", undefined, 4);
  // 一条一直挂着的在飞命令，插在最前面：它是最老的条目，但绝不能被淘汰。
  const inflight = "cmd-inflight" as CommandId;
  ledger.request(inflight, request("req-inflight"), RUNTIME);
  for (let index = 0; index < 6; index += 1) settle(ledger, index);

  assert.equal(ledger.terminalSnapshot().length, 4, "终态条目被压到容量上限");
  assert.equal(ledger.get(inflight)?.status, "requested", "在飞条目仍在");
  assert.equal(ledger.getByRequestId("req-inflight")?.commandId, inflight);
  assert.equal(ledger.get("cmd-0" as CommandId), undefined, "最早落定的终态条目先走");
  assert.equal(ledger.get("cmd-5" as CommandId)?.status, "completed", "最新落定的终态条目留下");
});

test("刚落成终态的条目不会在同一次 transition 里被自己挤掉", () => {
  const ledger = new CommandLedger(() => "2026-08-31T00:00:00.000Z", undefined, 2);
  for (let index = 0; index < 5; index += 1) {
    settle(ledger, index);
    const newest = ledger.get(`cmd-${index}` as CommandId);
    // 终态 outcome 必须活到能被发布出去为止，否则渲染端永远收不到这条命令的结果。
    assert.equal(newest?.status, "completed", `cmd-${index} 落定后仍可读`);
  }
  assert.equal(ledger.terminalSnapshot().length, 2);
});

test("被淘汰条目的回执不再抛错，但从未见过的 requestId 仍然 fail closed", () => {
  const ledger = new CommandLedger(() => "2026-08-31T00:00:00.000Z", undefined, 2);
  for (let index = 0; index < 5; index += 1) settle(ledger, index);
  assert.equal(ledger.getByRequestId("req-0"), undefined, "前置条件：req-0 已被淘汰");

  // 旧实现在这里抛 `Unknown request id`，而调用点在 Bridge socket 处理器里，
  // 一个意外抛出会把 socket destroy 掉。
  assert.equal(ledger.reconcileReceipt(receipt("req-0", "cmd-0")), undefined);
  assert.throws(
    () => ledger.reconcileReceipt(receipt("req-never-seen", "cmd-never-seen")),
    /Unknown request id/u,
  );
});

test("从持久化恢复时也套用容量上限", () => {
  const rows: CommandLedgerEntry[] = [];
  for (let index = 0; index < 6; index += 1) {
    rows.push({
      commandId: `cmd-${index}` as CommandId,
      requestId: `req-${index}` as RequestId,
      runtimeId: RUNTIME,
      runtimeEpoch: EPOCH,
      operationKind: "runtime.pause",
      requestedAt: "2026-08-31T00:00:00.000Z",
      terminalAt: "2026-08-31T00:00:01.000Z",
      status: "completed",
    } as CommandLedgerEntry);
  }
  const store: CommandLedgerStore = { load: () => rows, append: () => undefined };
  const ledger = new CommandLedger(() => "2026-08-31T00:00:00.000Z", store, 3);
  assert.equal(ledger.terminalSnapshot().length, 3);
});

test("terminalSnapshot 先过滤再克隆，且返回的是拷贝", () => {
  const ledger = new CommandLedger(() => "2026-08-31T00:00:00.000Z");
  ledger.request("cmd-open" as CommandId, request("req-open"), RUNTIME);
  settle(ledger, 1);

  const rows = ledger.terminalSnapshot();
  assert.equal(rows.length, 1, "在飞条目不出现在终态快照里");
  assert.equal(rows[0]?.commandId, "cmd-1");
  (rows[0] as { status: string }).status = "failed";
  assert.equal(ledger.get("cmd-1" as CommandId)?.status, "completed", "改返回值不影响内部状态");
});

test("默认容量高于 Renderer 的终态上限", () => {
  // Renderer 的 COMMAND_STATE_TERMINAL_CAP 是 100；Host 必须比它更能记事，
  // 否则会出现"渲染端还在显示、Host 已经忘了"的空洞。
  assert.ok(COMMAND_LEDGER_TERMINAL_CAP > 100);
});

function snapshot(stateVersion: number): OperatorStateSnapshot {
  return {
    runtimeId: RUNTIME,
    runtimeEpoch: EPOCH,
    stateVersion: stateVersion as StateVersion,
    sessionId: "session-1" as OperatorStateSnapshot["sessionId"],
    isStreaming: false,
    isCompacting: false,
    activeMode: "normal",
    approvalMode: "yolo",
    pendingMessages: 0,
    activeCommandIds: [],
    agentsRevision: 0,
    jobsRevision: 0,
    agents: [],
    jobs: [],
  } as OperatorStateSnapshot;
}

test("publish 与 current 交出同一个对象，不再逐次深拷贝", () => {
  const store = new RuntimePublicationStore(() => "2026-08-31T00:00:02.000Z");
  const published = store.publish(snapshot(1), []);
  assert.equal(store.current(), published, "current 直接返回已提交的读模型");
  assert.equal(store.current(), store.current(), "两次 current 引用相等");

  const next = store.publish(snapshot(2), []);
  assert.notEqual(next, published);
  assert.equal(store.current(), next);
  assert.equal(published.commitSeq, 1);
  assert.equal(next.commitSeq, 2);
});

test("publish 只保留终态条目", () => {
  const store = new RuntimePublicationStore(() => "2026-08-31T00:00:02.000Z");
  const ledger = new CommandLedger(() => "2026-08-31T00:00:00.000Z");
  ledger.request("cmd-open" as CommandId, request("req-open"), RUNTIME);
  settle(ledger, 1);

  const published = store.publish(snapshot(1), ledger.snapshot());
  assert.equal(published.terminalOutcomes.length, 1);
  assert.equal(published.terminalOutcomes[0]?.commandId, "cmd-1");
});
