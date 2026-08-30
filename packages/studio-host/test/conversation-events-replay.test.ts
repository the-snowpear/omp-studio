import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ConversationRuntimeEvent,
  type RuntimeEpoch,
  type SessionId,
  type StateVersion,
  type StudioEventEnvelope,
} from "@omp-studio/studio-protocol";

import {
  CONVERSATION_REPLAY_EVENT_LIMIT,
  CONVERSATION_REPLAY_MAX_BYTES,
  CONVERSATION_REPLAY_SESSION_LIMIT,
  ConversationEventFanout,
  type StudioConversationForward,
} from "../src/conversation-events.js";

const SESSION_ID = "session-live-replay" as SessionId;
const CREATED_AT = "2026-08-24T00:00:00.000Z";

function envelope(eventSeq: number, event: ConversationRuntimeEvent): StudioEventEnvelope {
  return {
    type: "studio.event",
    runtimeEpoch: 1 as RuntimeEpoch,
    eventSeq: eventSeq as never,
    stateVersion: 1 as StateVersion,
    occurredAt: CREATED_AT,
    event,
  };
}

test("replay reconstructs an open thinking message from bounded live state", () => {
  const fanout = new ConversationEventFanout();
  fanout.forward(envelope(1, {
    kind: "conversation.message.started",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: "message-1",
    role: "assistant",
    createdAt: CREATED_AT,
  }));
  fanout.forward(envelope(2, {
    kind: "conversation.message.delta",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: "message-1",
    blockId: "thinking-0",
    blockType: "thinking",
    delta: "正在",
  }));
  fanout.forward(envelope(3, {
    kind: "conversation.message.delta",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: "message-1",
    blockId: "thinking-0",
    blockType: "thinking",
    delta: "思考",
  }));

  const replayed: StudioConversationForward[] = [];
  fanout.replay(SESSION_ID, (event) => replayed.push(event));

  assert.deepEqual(replayed.map((item) => item.envelope.event.kind), [
    "conversation.message.started",
    "conversation.message.delta",
  ]);
  const delta = replayed[1]?.envelope.event;
  assert.equal(delta?.kind, "conversation.message.delta");
  if (delta?.kind === "conversation.message.delta") assert.equal(delta.delta, "正在思考");
});

test("terminal turn remains recoverable until the next turn starts", () => {
  const fanout = new ConversationEventFanout();
  fanout.forward(envelope(1, {
    kind: "conversation.message.started",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: "message-1",
    role: "assistant",
    createdAt: CREATED_AT,
  }));
  fanout.forward(envelope(2, {
    kind: "conversation.turn.completed",
    sessionId: SESSION_ID,
    turnId: "turn-1",
  }));

  const replayed: StudioConversationForward[] = [];
  fanout.replay(SESSION_ID, (event) => replayed.push(event));
  assert.deepEqual(replayed.map((item) => item.envelope.event.kind), [
    "conversation.message.started",
    "conversation.turn.completed",
  ]);
  assert.deepEqual(replayed.map((item) => item.streamSeq), [1, 2]);
});

test("target-local watermarks are independent of interleaved Runtime eventSeq", () => {
  const fanout = new ConversationEventFanout();
  fanout.forward(envelope(40, {
    kind: "conversation.message.started",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: "message-1",
    role: "assistant",
    createdAt: CREATED_AT,
  }));
  fanout.forward(envelope(41, {
    kind: "conversation.message.started",
    sessionId: "child-session" as SessionId,
    turnId: "turn-child",
    messageId: "message-child",
    role: "assistant",
    createdAt: CREATED_AT,
  }));
  fanout.forward(envelope(42, {
    kind: "conversation.message.delta",
    sessionId: SESSION_ID,
    turnId: "turn-1",
    messageId: "message-1",
    blockId: "text-0",
    blockType: "text",
    delta: "ok",
  }));

  assert.equal(fanout.snapshot(SESSION_ID).watermark, 2);
  assert.equal(fanout.snapshot("child-session" as SessionId).watermark, 1);
});

test("control notices inside the open race are retained through the watermark", () => {
  const fanout = new ConversationEventFanout();
  fanout.forward(envelope(1, {
    kind: "conversation.notice",
    sessionId: SESSION_ID,
    level: "warning",
    message: "provider is retrying",
  }));
  const snapshot = fanout.snapshot(SESSION_ID);
  assert.equal(snapshot.status, "complete");
  assert.equal(snapshot.watermark, 1);
  assert.equal(snapshot.events[0]?.envelope.event.kind, "conversation.notice");
});

test("byte overflow fails closed with an explicit resync result", () => {
  const fanout = new ConversationEventFanout();
  const chunk = "x".repeat(32 * 1024);
  let seq = 1;
  for (let block = 0; block < Math.ceil(CONVERSATION_REPLAY_MAX_BYTES / (256 * 1024)) + 2; block += 1) {
    for (let index = 0; index < 8; index += 1) {
      fanout.forward(envelope(seq, {
        kind: "conversation.message.delta",
        sessionId: SESSION_ID,
        turnId: "turn-byte-overflow",
        messageId: "message-1",
        blockId: `block-${block}`,
        blockType: "text",
        delta: chunk,
      }));
      seq += 1;
    }
  }
  const snapshot = fanout.snapshot(SESSION_ID);
  assert.equal(snapshot.status, "resyncRequired");
  assert.deepEqual(snapshot.events, []);
  assert.ok(snapshot.watermark > 0);
});

test("global LRU eviction bounds many child sessions and never returns a false empty replay", () => {
  const fanout = new ConversationEventFanout();
  for (let index = 0; index <= CONVERSATION_REPLAY_SESSION_LIMIT; index += 1) {
    fanout.forward(envelope(index + 1, {
      kind: "conversation.message.started",
      sessionId: `child-session-${index}` as SessionId,
      turnId: `turn-${index}`,
      messageId: `message-${index}`,
      role: "assistant",
      createdAt: CREATED_AT,
    }));
  }
  const evicted = fanout.snapshot("child-session-0" as SessionId);
  const newest = fanout.snapshot(`child-session-${CONVERSATION_REPLAY_SESSION_LIMIT}` as SessionId);
  assert.equal(evicted.status, "resyncRequired");
  assert.deepEqual(evicted.events, []);
  assert.equal(newest.status, "complete");
  assert.equal(newest.events.length, 1);
});

test("replay is session-scoped and fails closed when the bounded cache overflows", () => {
  const fanout = new ConversationEventFanout();
  for (let index = 0; index <= CONVERSATION_REPLAY_EVENT_LIMIT; index += 1) {
    fanout.forward(envelope(index + 1, {
      kind: "conversation.message.started",
      sessionId: SESSION_ID,
      turnId: "turn-overflow",
      messageId: `message-${index}`,
      role: "assistant",
      createdAt: CREATED_AT,
    }));
  }

  const replayed: StudioConversationForward[] = [];
  const resync: string[] = [];
  fanout.onResync((reason) => resync.push(reason));
  fanout.replay("another-session" as SessionId, (event) => replayed.push(event));
  assert.equal(replayed.length, 0);
  assert.equal(resync.length, 0);

  fanout.replay(SESSION_ID, (event) => replayed.push(event));
  assert.equal(replayed.length, 0);
  assert.equal(resync.length, 1);
});
