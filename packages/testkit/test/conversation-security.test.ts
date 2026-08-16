import assert from "node:assert/strict";
import { test } from "node:test";

import { redactDetail, redactText } from "@omp-studio/host-client-api";
import {
  CONVERSATION_LIMITS,
  ContractValidationError,
  encodeFrame,
  parseConversationRuntimeEvent,
  parseConversationTranscriptPage,
} from "@omp-studio/studio-protocol";

import {
  CONVERSATION_FIXTURE_IDS,
  conversationPages,
  conversationUnsafe,
} from "../src/conversation-fixtures.js";
import { assertConversationPublicSafe, findConversationSafetyViolations } from "../src/conversation-safety.js";

test("canonical conversation fixtures contain no secrets, home paths, or HTML handlers", () => {
  for (const page of Object.values(conversationPages)) {
    assertConversationPublicSafe(page);
  }
});

test("unsafe secret arguments are flagged by the public-safety checker", () => {
  const violations = findConversationSafetyViolations({ arguments: conversationUnsafe.secretArguments });
  assert.ok(violations.some((item) => item.includes("apiKey") || item.includes("sk-live-secret")));
});

test("redactText and redactDetail strip home paths and token-like values", () => {
  assert.match(redactText("C:\\Users\\alice\\project"), /redacted/i);
  assert.match(redactText("/Users/alice/secret"), /redacted/i);
  const redacted = redactDetail({
    apiKey: "sk-live-secret-value-that-looks-like-a-token-32chars",
    path: "C:\\Users\\alice\\project",
    note: "ok",
  });
  assert.notEqual(String(redacted.apiKey), "sk-live-secret-value-that-looks-like-a-token-32chars");
  assert.notEqual(String(redacted.path), "C:\\Users\\alice\\project");
});

test("truncated tool result is accepted; oversize without truncation is rejected", () => {
  const ok = parseConversationTranscriptPage({
    ...conversationPages.thinkingTool,
    items: [
      {
        kind: "message",
        itemId: "msg-trunc-1",
        parentId: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        role: "assistant",
        content: [
          {
            type: "toolResult",
            toolCallId: "call-trunc",
            toolName: "Bash",
            output: "stdout truncated for display",
            isError: false,
            truncated: true,
          },
        ],
      },
    ],
  });
  const result = ok.items[0];
  assert.ok(result && result.kind === "message");
  assert.equal(result.content[0] && result.content[0].type === "toolResult" ? result.content[0].truncated : false, true);

  const huge = "x".repeat(CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES + 1);
  assert.throws(
    () =>
      parseConversationRuntimeEvent({
        kind: "conversation.tool.updated",
        sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
        turnId: CONVERSATION_FIXTURE_IDS.turnId,
        toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
        updateMode: "replace",
        output: huge,
      }),
    ContractValidationError,
  );
});

test("objects with a non-plain prototype are not JSON-safe conversation arguments", () => {
  const polluted = Object.assign(Object.create({ stolen: true }), { path: "package.json" });
  assert.throws(
    () =>
      parseConversationRuntimeEvent({
        kind: "conversation.tool.started",
        sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
        turnId: CONVERSATION_FIXTURE_IDS.turnId,
        messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
        toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
        toolName: "Read",
        arguments: polluted,
        startedAt: "2026-08-15T12:00:01.000Z",
      }),
    ContractValidationError,
  );
});

test("Bridge frames reject bodies above the control-frame budget", () => {
  assert.throws(() => encodeFrame("frame-oversize", 1 as never, "x".repeat(1024 * 1024)));
});
