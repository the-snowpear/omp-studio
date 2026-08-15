import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialClientState,
  createInitialConversationState,
  reduceClientState,
  reduceConversationState,
  selectComposerReceipt,
  selectConversationViews,
} from "@omp-studio/client";
import { mapRemoteInteractionToClient } from "@omp-studio/host-client-api";
import { ConversationEventFanout } from "@omp-studio/studio-host";
import {
  CONVERSATION_LIMITS,
  ContractValidationError,
  parseConversationRuntimeEvent,
} from "@omp-studio/studio-protocol";

import {
  CONVERSATION_FIXTURE_IDS,
  conversationChangedEvent,
  conversationFaultEvents,
  conversationIdentities,
  conversationInteractions,
  conversationLiveClientEvents,
  conversationLiveSequence,
  conversationPages,
  conversationReceipts,
  conversationStudioEnvelope,
  conversationUnsafe,
} from "../src/conversation-fixtures.js";

function applyLive(
  state = createInitialConversationState(),
  event: ReturnType<typeof conversationChangedEvent>,
) {
  return reduceConversationState(state, { type: "live", event });
}

test("duplicate eventSeq is ignored; interleaved non-conversation seq still applies", () => {
  const state = applyLive(undefined, conversationChangedEvent(conversationFaultEvents.started, 1));
  const duplicate = applyLive(state, conversationChangedEvent(conversationFaultEvents.duplicateStarted, 1));
  assert.equal(duplicate, state);
  const gapped = applyLive(state, conversationChangedEvent(conversationFaultEvents.gapDelta, 3));
  assert.equal(gapped.resyncRequired, false);
  assert.equal(
    gapped.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId]?.blocks[CONVERSATION_FIXTURE_IDS.blockId]?.text,
    "gap",
  );
});

test("out-of-order late delta after completed is ignored", () => {
  let state = createInitialConversationState();
  for (const event of conversationLiveClientEvents) {
    state = applyLive(state, event);
  }
  const late = applyLive(
    state,
    conversationChangedEvent(conversationFaultEvents.lateDelta, conversationLiveClientEvents.length + 1),
  );
  const views = selectConversationViews(late);
  const assistant = views.find(
    (view) => view.kind === "item" && view.item.kind === "message" && view.item.role === "assistant",
  );
  assert.ok(assistant && assistant.kind === "item" && assistant.item.kind === "message");
  const text = assistant.item.content.find((block) => block.type === "text");
  assert.equal(text && text.type === "text" ? text.text : "", "正在完成");
});

test("epoch/session switch events are dropped and do not merge timelines", () => {
  const state = reduceConversationState(createInitialConversationState(), {
    type: "hydrate",
    generation: 0,
    page: conversationPages.userAssistant,
  });
  const switched = applyLive(
    state,
    conversationChangedEvent(conversationFaultEvents.otherEpochStarted, 1, {
      runtimeEpoch: conversationIdentities.other.runtimeEpoch,
    }),
  );
  assert.equal(switched, state);
  assert.equal(switched.identity?.sessionId, conversationIdentities.current.sessionId);
});

test("stale hydrate generation after clear is ignored (late query)", () => {
  let state = reduceConversationState(createInitialConversationState(), { type: "beginHydrate" });
  const generation = state.hydrateGeneration;
  state = reduceConversationState(state, { type: "clear" });
  state = reduceConversationState(state, {
    type: "hydrate",
    generation,
    page: conversationPages.userAssistant,
  });
  assert.equal(state.order.length, 0);
  assert.equal(state.hydrateStatus, "idle");
});

test("abort keeps received text; late delta after abort is dropped", () => {
  let state = applyLive(undefined, conversationChangedEvent(conversationLiveSequence[0]!, 1));
  state = applyLive(state, conversationChangedEvent(conversationLiveSequence[1]!, 2));
  const aborted = applyLive(state, conversationChangedEvent(conversationFaultEvents.aborted, 3));
  assert.equal(aborted.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId]?.aborted, true);
  assert.equal(
    aborted.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId]?.blocks[CONVERSATION_FIXTURE_IDS.blockId]?.text,
    "正在",
  );
  const late = applyLive(aborted, conversationChangedEvent(conversationFaultEvents.lateDelta, 4));
  assert.equal(
    late.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId]?.blocks[CONVERSATION_FIXTURE_IDS.blockId]?.text,
    "正在",
  );
});

test("four terminal receipts stay terminal and accepted is not a receipt", () => {
  const req = CONVERSATION_FIXTURE_IDS.requestId;
  function issued() {
    return reduceClientState(createInitialClientState(), {
      type: "command.issue",
      requestId: req,
      commandName: "core.prompt",
      idempotencyKey: "idem-receipt" as never,
      issuedAt: "2026-08-15T12:00:00.000Z",
    });
  }
  const accepted = reduceClientState(issued(), {
    type: "event",
    event: {
      kind: "command.accepted",
      authorityEpoch: CONVERSATION_FIXTURE_IDS.authorityEpoch,
      runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
      stateVersion: 41 as never,
      cursor: "c-acc" as never,
      occurredAt: "2026-08-15T12:00:00.000Z",
      accepted: {
        commandName: "core.prompt",
        requestId: req,
        status: "accepted",
        acceptedAt: "2026-08-15T12:00:00.000Z",
      },
    },
  });
  assert.equal(selectComposerReceipt(accepted.commands, req).phase, "accepted");
  for (const receiptEvent of Object.values(conversationReceipts)) {
    const next = reduceClientState(issued(), { type: "event", event: receiptEvent });
    const view = selectComposerReceipt(next.commands, req);
    assert.ok(
      view.phase === "completed" ||
        view.phase === "failed" ||
        view.phase === "rejected" ||
        view.phase === "outcome_unknown",
    );
    const afterCompleted = reduceClientState(next, { type: "event", event: conversationReceipts.completed });
    assert.equal(selectComposerReceipt(afterCompleted.commands, req).phase, view.phase);
  }
});

test("ConversationEventFanout isolates a throwing listener", () => {
  const fanout = new ConversationEventFanout();
  const seen: string[] = [];
  fanout.onEvent(() => {
    throw new Error("ui mapper boom");
  });
  fanout.onEvent((forward) => {
    seen.push(forward.envelope.event.kind);
  });
  const forwarded = fanout.forward(conversationStudioEnvelope(conversationLiveSequence[0]!, 1));
  assert.equal(forwarded, true);
  assert.deepEqual(seen, ["conversation.message.started"]);
});

test("oversized tool output is rejected by the contract validator", () => {
  const oversized = "x".repeat(CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES + 1);
  assert.throws(
    () =>
      parseConversationRuntimeEvent({
        kind: "conversation.tool.updated",
        sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
        turnId: CONVERSATION_FIXTURE_IDS.turnId,
        toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
        updateMode: "replace",
        output: oversized,
      }),
    ContractValidationError,
  );
});

test("cyclic and over-deep JSON arguments are rejected", () => {
  const cyclic: Record<string, unknown> = { path: "package.json" };
  cyclic.self = cyclic;
  assert.throws(
    () =>
      parseConversationRuntimeEvent({
        kind: "conversation.tool.started",
        sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
        turnId: CONVERSATION_FIXTURE_IDS.turnId,
        messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
        toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
        toolName: "Read",
        arguments: cyclic,
        startedAt: "2026-08-15T12:00:01.000Z",
      }),
    ContractValidationError,
  );
  let deep: unknown = "leaf";
  for (let i = 0; i < CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH + 2; i++) {
    deep = { nested: deep };
  }
  assert.throws(
    () =>
      parseConversationRuntimeEvent({
        kind: "conversation.tool.started",
        sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
        turnId: CONVERSATION_FIXTURE_IDS.turnId,
        messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
        toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
        toolName: "Read",
        arguments: deep,
        startedAt: "2026-08-15T12:00:01.000Z",
      }),
    ContractValidationError,
  );
});

test("interaction five kinds map; approval secrets are dropped", () => {
  for (const request of Object.values(conversationInteractions)) {
    const mapped = mapRemoteInteractionToClient(
      request,
      CONVERSATION_FIXTURE_IDS.sessionId,
      1,
      CONVERSATION_FIXTURE_IDS.requestId,
    );
    assert.equal(mapped?.kind, request.kind);
  }
  const dirty = mapRemoteInteractionToClient(
    {
      ...conversationInteractions.approval,
      kind: "approval",
      approvalType: "bash",
      details: conversationUnsafe.secretArguments,
    },
    CONVERSATION_FIXTURE_IDS.sessionId,
    1,
    CONVERSATION_FIXTURE_IDS.requestId,
  );
  assert.equal(dirty?.kind, "approval");
  if (dirty?.kind === "approval") {
    const json = JSON.stringify(dirty);
    assert.equal(json.includes("sk-live-secret"), false);
    assert.equal(json.includes("Bearer super-secret"), false);
  }
});

test("socket reconnect after a live gap is not covered by an in-process Desktop socket harness", {
  skip: "no in-process Desktop socket reconnect harness; eventSeq gap resync is covered above",
}, () => {});

test("real Runtime crash after prompt is not covered without spawning OMP", {
  skip: "would require killing a real omp.exe; outcome_unknown receipt is covered above",
}, () => {});

test("branch navigate with a stale cursor needs Runtime cursor signing", {
  skip: "CURSOR_STALE signing lives in plan 02 Runtime reader; Host mapping is covered by host-client-api tests",
}, () => {});

test("compaction-during-read isolation needs a real SessionManager reader", {
  skip: "requires OMP SessionManager; identity mismatch drop is covered above",
}, () => {});
