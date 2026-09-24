import assert from "node:assert/strict";
import { test } from "node:test";
import { CONVERSATION_LIMITS, parseConversationRuntimeEvent, type ConversationRuntimeEvent, type SessionId, type StudioEventEnvelope } from "@omp-studio/studio-protocol";
import { ConversationEventFanout, type StudioConversationForward } from "../src/conversation-events.js";

const sessionId = "session" as SessionId;
function setup() {
  let now = 0;
  let nextTimer = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const fanout = new ConversationEventFanout({ incrementalToolReplay: true, backgroundCoalescing: true,
    timers: {
      setTimer: (callback, ms) => { const id = ++nextTimer; timers.set(id, { at: now + ms, callback }); return id; },
      clearTimer: (handle) => { timers.delete(handle as number); },
    },
  });
  const delivered: StudioConversationForward[] = [];
  fanout.onEvent((event) => delivered.push(event));
  const send = (event: ConversationRuntimeEvent, epoch = 1) => fanout.forward({ type: "studio.event", runtimeEpoch: epoch,
    stateVersion: 1, eventSeq: ++seq, occurredAt: "2026-09-23T00:00:00.000Z", event } as StudioEventEnvelope);
  return { fanout, delivered, timers, send, tick(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
  } };
}
const delta = (text: string, target = sessionId): ConversationRuntimeEvent => ({ kind: "conversation.message.delta", sessionId: target,
  turnId: "turn", messageId: "message", blockId: "block", blockType: "text", delta: text });
const text = (events: readonly StudioConversationForward[]) => events.map(({ envelope: { event } }) => event.kind === "conversation.message.delta" ? event.delta : "").join("");

test("legacy foreground, 249/250ms window and immediate catch-up on visibility", () => {
  const s = setup();
  s.send(delta("first"));
  assert.equal(s.delivered.length, 1);
  s.fanout.setVisibleSessions(new Set());
  for (let i = 0; i < 10; i++) s.send(delta("a"));
  s.tick(249);
  assert.equal(s.delivered.length, 1);
  s.tick(1);
  assert.equal(s.delivered.length, 2);
  assert.equal(text(s.delivered), "firstaaaaaaaaaa");
  s.send(delta("pending"));
  s.fanout.setVisibleSessions(new Set([sessionId]));
  assert.equal(text(s.delivered), "firstaaaaaaaaaapending");
  s.send(delta("foreground"));
  assert.equal(s.delivered.length, 4);
  assert.deepEqual(s.delivered.map((event) => event.streamSeq), [1, 2, 3, 4]);
  assert.equal(s.timers.size, 0);
});

test("10,000 deltas: item and byte overflow flush losslessly with continuous watermarks", () => {
  const s = setup();
  s.fanout.setVisibleSessions(new Set());
  for (let i = 0; i < 10000; i++) {
    s.send(delta("中🚀"));
    assert.ok(s.fanout.getDiagnostics().pendingItems! < 500);
    assert.ok(s.fanout.getDiagnostics().pendingBytes! <= 1024 * 1024);
  }
  const snapshot = s.fanout.snapshot(sessionId);
  assert.equal(snapshot.status, "complete");
  assert.equal(text(s.delivered), "中🚀".repeat(10000));
  assert.equal(snapshot.watermark, s.delivered.length);
  s.delivered.forEach((event, i) => {
    assert.equal(event.streamSeq, i + 1);
    parseConversationRuntimeEvent(event.envelope.event);
  });
  assert.ok(s.delivered.length < 100);
  const before = s.delivered.length;
  for (let i = 0; i < 40; i++) s.send(delta("x".repeat(CONVERSATION_LIMITS.DELTA_MAX_BYTES)));
  assert.ok(s.delivered.length > before, "byte cap flushes even below the item cap");
  s.fanout.dispose();
  assert.equal(s.timers.size, 0);
  assert.equal(s.fanout.getDiagnostics().pendingBytes, 0);
});

test("all structural events flush first and never wait for the background timer", () => {
  const events: ConversationRuntimeEvent[] = [
    { kind: "conversation.message.started", sessionId, turnId: "turn", messageId: "message", role: "assistant", createdAt: "now" },
    { kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "message", item: { kind: "message", itemId: "message", parentId: null, role: "assistant", createdAt: "now", content: [] } },
    { kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "message", toolCallId: "call", toolName: "bash", startedAt: "now" },
    { kind: "conversation.tool.completed", sessionId, turnId: "turn", toolCallId: "call", completedAt: "now", result: { type: "toolResult", toolCallId: "call", isError: true } },
    { kind: "conversation.turn.completed", sessionId, turnId: "turn" },
    { kind: "conversation.turn.aborted", sessionId, turnId: "turn" },
    { kind: "conversation.notice", sessionId, level: "error", message: "error" },
  ];
  for (const event of events) {
    const s = setup();
    s.fanout.setVisibleSessions(new Set());
    s.send(delta("pending"));
    assert.ok(s.send(event), event.kind);
    assert.equal(s.delivered.length, 2, event.kind);
    assert.equal(text(s.delivered), "pending");
    assert.equal(s.delivered[1]!.envelope.event.kind, event.kind);
    assert.equal(s.timers.size, 0);
  }
});

test("interleaved sessions stay separate, open flushes and stale epochs discard pending", () => {
  const s = setup();
  s.fanout.setVisibleSessions(new Set());
  s.send(delta("a"));
  s.send(delta("b", "child" as SessionId));
  s.send(delta("c"));
  s.fanout.snapshot(sessionId);
  s.tick(250);
  assert.equal(text(s.delivered.filter((e) => e.envelope.event.sessionId === sessionId)), "ac");
  assert.deepEqual(s.delivered.map((e) => e.streamSeq), [1, 2, 1]);
  s.send(delta("must-disappear"));
  s.send(delta("new-epoch"), 2);
  s.tick(250);
  assert.equal(text(s.delivered), "acbnew-epoch");
  s.fanout.setVisibleSessions(new Set());
  s.send(delta("disposed"), 2);
  s.fanout.dispose();
  s.tick(250);
  assert.equal(text(s.delivered), "acbnew-epoch");
});

test("a visible foreground sibling cannot force background deltas to flush every token", () => {
  const s = setup();
  s.fanout.setVisibleSessions(new Set([sessionId]));
  for (let i = 0; i < 50; i++) {
    s.send(delta("background", "child" as SessionId));
    s.send(delta("foreground"));
  }
  assert.equal(s.delivered.length, 50);
  assert.equal(s.fanout.getDiagnostics().pendingItems, 50);
  s.tick(250);
  assert.equal(text(s.delivered.filter((event) => event.envelope.event.sessionId === "child")), "background".repeat(50));
  assert.equal(s.fanout.getDiagnostics().pendingItems, 0);
});

test("append groups keep replace boundaries and truncated flags", () => {
  const s = setup();
  s.fanout.setVisibleSessions(new Set());
  const legacy = new ConversationEventFanout({ incrementalToolReplay: true });
  const operations = [
    { updateMode: "append", output: "a" }, { updateMode: "append", output: "b" },
    { updateMode: "replace", output: "new" }, { updateMode: "append", output: "c", truncated: true },
    { updateMode: "append", output: "d", truncated: true }, { updateMode: "append", output: "e" },
  ] as const;
  for (const operation of operations) {
    const event: ConversationRuntimeEvent = { kind: "conversation.tool.updated", sessionId, turnId: "turn", toolCallId: "call", ...operation };
    s.send(event);
    legacy.forward({ type: "studio.event", runtimeEpoch: 1, stateVersion: 1, eventSeq: 1, occurredAt: "now", event } as StudioEventEnvelope);
  }
  s.tick(250);
  const actual = s.fanout.snapshot(sessionId).events[0]?.envelope.event;
  assert.deepEqual(actual, legacy.snapshot(sessionId).events[0]?.envelope.event);
  assert.equal(s.delivered.length, 4);
  assert.equal(s.delivered[2]!.envelope.event.kind === "conversation.tool.updated" && s.delivered[2]!.envelope.event.truncated, true);
});
