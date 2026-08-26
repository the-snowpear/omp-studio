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

test("terminal turn clears its replay state", () => {
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
  assert.deepEqual(replayed, []);
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
