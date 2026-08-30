import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentId,
  ConversationRuntimeEvent,
  ConversationTranscriptPage,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  StudioEventEnvelope,
} from "@omp-studio/studio-protocol";

import { StudioBridgeClient } from "../src/bridge-client.js";
import { CommandLedger } from "../src/command-ledger.js";
import { StudioRuntimeSessionController } from "../src/runtime-session-controller.js";

const PARENT = "parent-session" as SessionId;
const CHILD = "child-session" as SessionId;
const AGENT = "agent-7" as AgentId;
const AT = "2026-08-28T10:00:00.000Z";

function page(sessionId: SessionId): ConversationTranscriptPage {
  return {
    runtimeEpoch: 1 as RuntimeEpoch,
    sessionId,
    branchLeafId: null,
    items: [],
    headCursor: "head" as never,
    hasMoreBefore: false,
  };
}

function envelope(eventSeq: number, event: ConversationRuntimeEvent): StudioEventEnvelope {
  return {
    type: "studio.event",
    runtimeEpoch: 1 as RuntimeEpoch,
    eventSeq: eventSeq as never,
    stateVersion: 1 as StateVersion,
    occurredAt: AT,
    event,
  };
}

function fakeBridge(options: {
  readTranscript?: () => Promise<ConversationTranscriptPage>;
  readAgentConversation?: (input: { readonly agentId: string }) => Promise<ConversationTranscriptPage>;
}) {
  let onEvent: ((event: StudioEventEnvelope) => void) | undefined;
  return {
    bridge: {
      onProjectionChanged: () => () => undefined,
      onEvent: (listener: (event: StudioEventEnvelope) => void) => {
        onEvent = listener;
        return () => undefined;
      },
      onResyncRequired: () => () => undefined,
      projectionSnapshot: () => ({ sessionId: PARENT, runtimeEpoch: 1 }),
      readTranscript: () => options.readTranscript?.() ?? Promise.resolve(page(PARENT)),
      readAgentConversation: (input: { readonly agentId: string }) =>
        options.readAgentConversation?.(input) ?? Promise.resolve(page(CHILD)),
    } as unknown as StudioBridgeClient,
    emit: (event: StudioEventEnvelope) => onEvent?.(event),
  };
}

test("conversation.open closes subscribe-before-open race with a target watermark", async () => {
  let harness: ReturnType<typeof fakeBridge>;
  harness = fakeBridge({
    readTranscript: async () => {
      harness.emit(envelope(80, {
        kind: "conversation.message.started",
        sessionId: PARENT,
        turnId: "turn-1",
        messageId: "message-1",
        role: "assistant",
        createdAt: AT,
      }));
      harness.emit(envelope(82, {
        kind: "conversation.message.delta",
        sessionId: PARENT,
        turnId: "turn-1",
        messageId: "message-1",
        blockId: "text-0",
        blockType: "text",
        delta: "streamed while the page was loading",
      }));
      return page(PARENT);
    },
  });
  const controller = new StudioRuntimeSessionController(harness.bridge, new CommandLedger());
  const subscribed: number[] = [];
  controller.onConversationEvent((event) => subscribed.push(event.streamSeq));
  try {
    const opened = await controller.openConversation({ target: { kind: "session", sessionId: PARENT } });
    assert.equal(opened.target.kind, "session");
    assert.equal(opened.live.status, "complete");
    assert.equal(opened.live.watermark, 2);
    assert.deepEqual(opened.live.events.map((event) => event.streamSeq), [1, 2]);
    assert.deepEqual(subscribed, [1, 2]);
  } finally {
    controller.dispose();
  }
});

test("conversation.open returns explicit agent and child-session identity", async () => {
  const harness = fakeBridge({
    readAgentConversation: async (input) => {
      assert.equal(input.agentId, AGENT);
      return page(CHILD);
    },
  });
  const controller = new StudioRuntimeSessionController(harness.bridge, new CommandLedger());
  try {
    const opened = await controller.openConversation({
      target: { kind: "agent", parentSessionId: PARENT, agentId: AGENT },
    });
    assert.deepEqual(opened.target, {
      kind: "agent",
      parentSessionId: PARENT,
      agentId: AGENT,
      conversationSessionId: CHILD,
    });
    assert.equal(opened.page.sessionId, CHILD);
  } finally {
    controller.dispose();
  }
});
