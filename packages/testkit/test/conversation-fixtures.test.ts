import assert from "node:assert/strict";
import { test } from "node:test";

import { mapRemoteInteractionToClient } from "@omp-studio/host-client-api";
import {
  parseConversationRuntimeEvent,
  parseConversationTranscriptPage,
} from "@omp-studio/studio-protocol";

import {
  CONVERSATION_FIXTURE_IDS,
  conversationFaultEvents,
  conversationIdentities,
  conversationInteractions,
  conversationLiveSequence,
  conversationPages,
  conversationReceipts,
  conversationUnsafe,
} from "../src/conversation-fixtures.js";
import {
  assertConversationPublicSafe,
  findConversationSafetyViolations,
} from "../src/conversation-safety.js";

test("canonical pages and live events pass the contract validator", () => {
  for (const [name, page] of Object.entries(conversationPages)) {
    const parsed = parseConversationTranscriptPage(page);
    assert.equal(parsed.sessionId, CONVERSATION_FIXTURE_IDS.sessionId, name);
    assertConversationPublicSafe(parsed);
  }
  for (const [index, event] of conversationLiveSequence.entries()) {
    const parsed = parseConversationRuntimeEvent(event);
    assert.equal(parsed.kind, event.kind, `live[${index}]`);
    assertConversationPublicSafe(parsed);
  }
});

test("fixture set covers identities, empty, user/assistant, thinking+tool, and compaction/reset", () => {
  assert.notEqual(conversationIdentities.current.sessionId, conversationIdentities.other.sessionId);
  assert.equal(conversationPages.empty.items.length, 0);
  assert.equal(conversationPages.empty.hasMoreBefore, false);
  const roles = conversationPages.userAssistant.items.map((item) =>
    item.kind === "message" ? item.role : item.kind,
  );
  assert.deepEqual(roles, ["user", "assistant"]);
  const toolPage = conversationPages.thinkingTool.items.find((item) => item.kind === "message" && item.role === "assistant");
  assert.ok(toolPage && toolPage.kind === "message");
  const types = toolPage.content.map((block) => block.type);
  assert.deepEqual(types, ["thinking", "toolCall", "toolResult", "text"]);
  const kinds = conversationPages.compactionReset.items.map((item) => item.kind);
  assert.deepEqual(kinds, ["resetBoundary", "message", "message", "compaction"]);
});

test("live sequence is the MVP-B projector order", () => {
  assert.deepEqual(
    conversationLiveSequence.map((event) => event.kind),
    [
      "conversation.message.started",
      "conversation.message.delta",
      "conversation.message.delta",
      "conversation.message.completed",
      "conversation.tool.started",
      "conversation.tool.updated",
      "conversation.tool.completed",
      "conversation.turn.completed",
    ],
  );
  const completed = conversationLiveSequence.find((event) => event.kind === "conversation.message.completed");
  assert.ok(completed && completed.kind === "conversation.message.completed");
  assert.equal(completed.item.itemId, completed.messageId);
});

test("fault, receipt, and interaction fixtures are complete", () => {
  assert.equal(conversationFaultEvents.started.kind, "conversation.message.started");
  assert.equal(conversationFaultEvents.duplicateStarted.kind, "conversation.message.started");
  assert.equal(conversationFaultEvents.lateDelta.kind, "conversation.message.delta");
  assert.equal(conversationFaultEvents.gapDelta.kind, "conversation.message.delta");
  assert.equal(conversationFaultEvents.otherEpochStarted.sessionId, conversationIdentities.other.sessionId);
  assert.equal(conversationFaultEvents.aborted.kind, "conversation.turn.aborted");
  const receiptStatuses = Object.values(conversationReceipts).map((event) => {
    assert.equal(event.kind, "command.receipt");
    return event.kind === "command.receipt" ? event.receipt.status : "missing";
  });
  assert.deepEqual(receiptStatuses, ["completed", "failed", "rejected", "outcome_unknown"]);
  assert.deepEqual(Object.keys(conversationInteractions), ["confirm", "select", "input", "editor", "approval"]);
  for (const request of Object.values(conversationInteractions)) {
    const mapped = mapRemoteInteractionToClient(
      request,
      CONVERSATION_FIXTURE_IDS.sessionId,
      1,
      CONVERSATION_FIXTURE_IDS.requestId,
    );
    assert.ok(mapped, request.kind);
    assert.equal(mapped?.kind, request.kind);
    assert.equal("title" in (mapped ?? {}), true);
    assert.equal(mapped?.title, request.title);
  }
});

test("unsafe payloads are detected and must not be used as public fixtures", () => {
  const violations = findConversationSafetyViolations({ arguments: conversationUnsafe.secretArguments });
  assert.ok(violations.length > 0);
  assert.throws(() => assertConversationPublicSafe({ arguments: conversationUnsafe.secretArguments }));
});
