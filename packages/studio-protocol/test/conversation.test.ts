import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONVERSATION_BRANCH_SUMMARY_MAPPING,
  CONVERSATION_CURSOR_DIRECTION,
  CONVERSATION_CURSOR_NAMESPACE,
  CONVERSATION_CURSOR_SCHEMA_VERSION,
  CONVERSATION_IGNORED_SESSION_ENTRY_TYPES,
  CONVERSATION_LIMITS,
  CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION,
  CONVERSATION_PUBLIC_ITEM_KINDS,
  CONVERSATION_REDACT_KEY_PATTERN,
  conversationRedactKey,
  ContractValidationError,
  DEFAULT_MAX_CONTROL_FRAME_BYTES,
  SESSION_TRANSCRIPT_READ_CAPABILITY,
  SESSION_TRANSCRIPT_READ_CONCURRENCY,
  SESSION_TRANSCRIPT_READ_KIND,
  parseConversationRuntimeEvent,
  parseConversationOpenResult,
  parseConversationTranscriptPage,
  parseFoundationStudioRequest,
  parseStudioEventEnvelope,
  parseStudioReceipt,
  parseStudioSnapshotResponse,
  publicConversationToolCallId,
  truncateUtf8,
} from "../src/index.js";

const fixture = (name: string) => fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));
const requestBase = { type: "studio.request", requestId: "req-transcript", runtimeEpoch: 1 };

function envelope(event: unknown, stateVersion = 0) {
  return {
    type: "studio.event",
    runtimeEpoch: 1,
    eventSeq: 1,
    stateVersion,
    occurredAt: "2026-08-15T12:00:00.000Z",
    event,
  };
}

test("conversation contract freezes capability, concurrency, cursor, and mapping", () => {
  assert.equal(SESSION_TRANSCRIPT_READ_KIND, "session.transcript.read");
  assert.equal(SESSION_TRANSCRIPT_READ_CAPABILITY, "session.history");
  assert.equal(SESSION_TRANSCRIPT_READ_CONCURRENCY, "read-concurrent");
  assert.equal(CONVERSATION_CURSOR_SCHEMA_VERSION, 1);
  assert.equal(CONVERSATION_CURSOR_DIRECTION, "older");
  assert.equal(CONVERSATION_CURSOR_NAMESPACE, "session.transcript.v1");
  assert.equal(CONVERSATION_BRANCH_SUMMARY_MAPPING, "ignore");
  assert.deepEqual(CONVERSATION_PUBLIC_ITEM_KINDS, ["message", "compaction", "resetBoundary"]);
  assert.ok(CONVERSATION_IGNORED_SESSION_ENTRY_TYPES.includes("branch_summary"));
  assert.equal(CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION, false);
  assert.ok(CONVERSATION_LIMITS.PAGE_MAX_BYTES < DEFAULT_MAX_CONTROL_FRAME_BYTES);
  assert.equal(DEFAULT_MAX_CONTROL_FRAME_BYTES, 1024 * 1024);
  assert.equal(CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT, 50);
  assert.equal(CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN, 1);
  assert.equal(CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX, 100);
  assert.equal(CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES, 256 * 1024);
  assert.equal(CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES, 256 * 1024);
  assert.equal(CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH, 12);
  assert.equal(CONVERSATION_LIMITS.PAGE_MAX_BYTES, 768 * 1024);
  assert.ok(CONVERSATION_REDACT_KEY_PATTERN.test("providerPayload"));
  assert.ok(CONVERSATION_REDACT_KEY_PATTERN.test("apiKey"));
  assert.ok(CONVERSATION_REDACT_KEY_PATTERN.test("authorization"));
  assert.equal(CONVERSATION_REDACT_KEY_PATTERN.test("toolName"), false);
  assert.equal(conversationRedactKey("token"), true);
  assert.equal(conversationRedactKey("apiKey"), true);
  assert.equal(conversationRedactKey("tokens"), false);
  assert.equal(conversationRedactKey("tokensBefore"), false);
  assert.equal(conversationRedactKey("contextTokens"), false);
});

test("session.transcript.read parses canonical fixture and optional cursor", async () => {
  const value: unknown = JSON.parse(await readFile(fixture("request.transcript.read.json"), "utf8"));
  const parsed = parseFoundationStudioRequest(value);
  assert.equal(parsed.operation.kind, "session.transcript.read");
  if (parsed.operation.kind === "session.transcript.read") {
    assert.equal(parsed.operation.limit, 50);
    assert.equal(parsed.operation.cursor, undefined);
  }
  assert.equal(
    parseFoundationStudioRequest({
      ...requestBase,
      operation: { kind: "session.transcript.read", cursor: "opaque-older", limit: 1 },
    }).operation.kind,
    "session.transcript.read",
  );
  assert.equal(
    parseFoundationStudioRequest({
      ...requestBase,
      operation: { kind: "session.transcript.read" },
    }).operation.kind,
    "session.transcript.read",
  );
});

test("session.transcript.read rejects illegal cursor, limit, and extra keys", () => {
  const invalid = [
    { kind: "session.transcript.read", cursor: "" },
    { kind: "session.transcript.read", cursor: "x".repeat(CONVERSATION_LIMITS.CURSOR_MAX_CHARS + 1) },
    { kind: "session.transcript.read", limit: 0 },
    { kind: "session.transcript.read", limit: -1 },
    { kind: "session.transcript.read", limit: 1.5 },
    { kind: "session.transcript.read", limit: 101 },
    { kind: "session.transcript.read", extra: true },
    { kind: "session.transcript.read", sessionId: "must-not-appear" },
  ];
  for (const operation of invalid) {
    assert.throws(() => parseFoundationStudioRequest({ ...requestBase, operation }), ContractValidationError);
  }
});

test("transcript page fixture accepts every public item and block kind", async () => {
  const value: unknown = JSON.parse(await readFile(fixture("conversation.page.json"), "utf8"));
  const page = parseConversationTranscriptPage(value);
  assert.equal(page.items.length, 4);
  assert.equal(page.items[0]?.kind, "resetBoundary");
  assert.equal(page.items[1]?.kind, "message");
  assert.equal(page.items[2]?.kind, "message");
  assert.equal(page.items[3]?.kind, "compaction");
  const assistant = page.items[2];
  if (assistant?.kind !== "message") throw new Error("expected assistant message");
  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["thinking", "toolCall", "toolResult", "text"],
  );
  assert.equal(page.hasMoreBefore, true);
  assert.equal(page.headCursor, "opaque-head-cursor");
});

test("conversation.open validates explicit child identity, watermark, and target-local sequence", () => {
  const page = {
    runtimeEpoch: 1,
    sessionId: "child-session-1",
    branchLeafId: null,
    items: [],
    headCursor: "head",
    hasMoreBefore: false,
  };
  const result = parseConversationOpenResult({
    target: {
      kind: "agent",
      parentSessionId: "parent-session-1",
      agentId: "agent-1",
      conversationSessionId: "child-session-1",
    },
    page,
    live: {
      status: "complete",
      watermark: 2,
      events: [
        {
          streamSeq: 2,
          eventSeq: 91,
          stateVersion: 0,
          occurredAt: "2026-08-15T12:00:00.000Z",
          update: {
            kind: "conversation.message.started",
            sessionId: "child-session-1",
            turnId: "turn-1",
            messageId: "message-1",
            role: "assistant",
            createdAt: "2026-08-15T12:00:00.000Z",
          },
        },
      ],
    },
  });
  assert.equal(result.target.kind, "agent");
  assert.equal(result.live.watermark, 2);
  assert.equal(result.live.events[0]?.streamSeq, 2);

  assert.throws(
    () => parseConversationOpenResult({ ...result, page: { ...page, sessionId: "other-child" } }),
    ContractValidationError,
  );
  assert.throws(
    () => parseConversationOpenResult({
      ...result,
      live: { ...result.live, watermark: 1 },
    }),
    ContractValidationError,
  );
  assert.throws(
    () => parseConversationOpenResult({
      ...result,
      live: { status: "resyncRequired", watermark: 2, events: result.live.events, reason: "overflow" },
    }),
    ContractValidationError,
  );
});

test("transcript page rejects missing fields, extra keys, non-JSON, and over-limit payloads", async () => {
  const valid = JSON.parse(await readFile(fixture("conversation.page.json"), "utf8")) as Record<string, unknown>;
  const { olderCursor: _older, ...withoutOlder } = valid;
  assert.equal(parseConversationTranscriptPage(withoutOlder).olderCursor, undefined);

  assert.throws(() => parseConversationTranscriptPage({ ...valid, hasMoreBefore: "yes" }), ContractValidationError);
  assert.throws(() => parseConversationTranscriptPage({ ...valid, extra: true }), ContractValidationError);
  assert.throws(
    () => parseConversationTranscriptPage({ ...valid, items: [{ kind: "branch_summary", itemId: "x" }] }),
    ContractValidationError,
  );
  assert.throws(
    () => parseConversationTranscriptPage({ ...valid, items: [{ kind: "message", itemId: "x" }] }),
    ContractValidationError,
  );

  const cyclic: Record<string, unknown> = { type: "toolCall", toolCallId: "c1", toolName: "Read" };
  cyclic.arguments = cyclic;
  assert.throws(
    () =>
      parseConversationTranscriptPage({
        ...valid,
        items: [
          {
            kind: "message",
            itemId: "msg-1",
            parentId: null,
            createdAt: "2026-08-15T00:00:00.000Z",
            role: "assistant",
            content: [cyclic],
          },
        ],
      }),
    ContractValidationError,
  );

  const tooMany = Array.from({ length: CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX + 1 }, (_, index) => ({
    kind: "resetBoundary",
    itemId: `reset-${index}`,
    parentId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
  }));
  assert.throws(() => parseConversationTranscriptPage({ ...valid, items: tooMany }), ContractValidationError);

  const hugeText = "x".repeat(CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES + 1);
  assert.throws(
    () =>
      parseConversationTranscriptPage({
        ...valid,
        items: [
          {
            kind: "message",
            itemId: "msg-huge",
            parentId: null,
            createdAt: "2026-08-15T00:00:00.000Z",
            role: "user",
            content: [{ type: "text", text: hugeText }],
          },
        ],
      }),
    ContractValidationError,
  );
});

test("content blocks reject wrong booleans, extra keys, and deep JSON", () => {
  const message = {
    kind: "message",
    itemId: "msg-1",
    parentId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    role: "assistant",
    content: [
      {
        type: "toolResult",
        toolCallId: "call-1",
        isError: "yes",
      },
    ],
  };
  assert.throws(
    () =>
      parseConversationTranscriptPage({
        runtimeEpoch: 1,
        sessionId: "session-1",
        branchLeafId: null,
        items: [message],
        headCursor: "head",
        hasMoreBefore: false,
      }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseConversationTranscriptPage({
        runtimeEpoch: 1,
        sessionId: "session-1",
        branchLeafId: null,
        items: [
          {
            ...message,
            content: [{ type: "text", text: "ok", providerPayload: { raw: true } }],
          },
        ],
        headCursor: "head",
        hasMoreBefore: false,
      }),
    ContractValidationError,
  );

  let deep: unknown = 1;
  for (let index = 0; index < CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH + 1; index += 1) {
    deep = { nested: deep };
  }
  assert.throws(
    () =>
      parseConversationTranscriptPage({
        runtimeEpoch: 1,
        sessionId: "session-1",
        branchLeafId: null,
        items: [
          {
            ...message,
            content: [{ type: "toolCall", toolCallId: "call-1", toolName: "Read", arguments: deep }],
          },
        ],
        headCursor: "head",
        hasMoreBefore: false,
      }),
    ContractValidationError,
  );
});

test("snapshot messagesCursor is an opaque head hint and does not carry bodies", async () => {
  const initial: unknown = JSON.parse(await readFile(fixture("snapshot.initial.json"), "utf8"));
  assert.equal(parseStudioSnapshotResponse(initial).messagesCursor, undefined);

  const withCursor: unknown = JSON.parse(await readFile(fixture("snapshot.messages-cursor.json"), "utf8"));
  const parsed = parseStudioSnapshotResponse(withCursor);
  assert.equal(parsed.messagesCursor, "opaque-head-cursor-session-1");
  assert.equal("items" in parsed, false);
  assert.throws(
    () => parseStudioSnapshotResponse({ ...(withCursor as object), messagesCursor: "" }),
    ContractValidationError,
  );
});

test("CURSOR_STALE is a protocol error distinct from STATE_VERSION_CONFLICT", () => {
  const receipt = {
    type: "studio.receipt",
    requestId: "req-transcript-stale",
    runtimeEpoch: 1,
    stateVersion: 3,
    status: "rejected",
    error: {
      code: "CURSOR_STALE",
      message: "Transcript cursor belongs to another branch",
      retryable: false,
    },
  };
  assert.equal(parseStudioReceipt(receipt).error?.code, "CURSOR_STALE");
  assert.throws(
    () => parseStudioReceipt({ ...receipt, error: { ...receipt.error, code: "NOT_A_CODE" } }),
    ContractValidationError,
  );
});

test("live conversation events parse every kind and reject inner occurredAt", () => {
  const started = {
    kind: "conversation.message.started",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "msg-1",
    role: "assistant",
    createdAt: "2026-08-15T12:00:00.000Z",
  };
  const events = [
    started,
    {
      kind: "conversation.message.delta",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "msg-1",
      blockId: "block-1",
      blockType: "text",
      delta: "Hello",
    },
    {
      kind: "conversation.message.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "msg-1",
      item: {
        kind: "message",
        itemId: "msg-1",
        parentId: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    },
    {
      kind: "conversation.tool.started",
      sessionId: "session-1",
      turnId: "turn-1",
      messageId: "msg-1",
      toolCallId: "call-1",
      toolName: "Read",
      arguments: { path: "package.json" },
      startedAt: "2026-08-15T12:00:01.000Z",
    },
    {
      kind: "conversation.tool.updated",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      updateMode: "append",
      output: "partial",
    },
    {
      kind: "conversation.tool.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      result: { type: "toolResult", toolCallId: "call-1", output: "done", isError: false },
      completedAt: "2026-08-15T12:00:02.000Z",
    },
    { kind: "conversation.turn.completed", sessionId: "session-1", turnId: "turn-1" },
    { kind: "conversation.turn.aborted", sessionId: "session-1", turnId: "turn-1" },
    { kind: "conversation.compaction.started", sessionId: "session-1", action: "auto" },
    {
      kind: "conversation.compaction.completed",
      sessionId: "session-1",
      aborted: false,
      item: {
        kind: "compaction",
        itemId: "compact-1",
        parentId: "msg-1",
        createdAt: "2026-08-15T12:00:03.000Z",
        summary: "Summarized",
      },
    },
    {
      kind: "conversation.notice",
      sessionId: "session-1",
      level: "warning",
      message: "tool output truncated",
      source: "sanitizer",
    },
  ];
  for (const event of events) {
    assert.equal(parseConversationRuntimeEvent(event).kind, event.kind);
    assert.equal((parseStudioEventEnvelope(envelope(event)).event as { kind: string }).kind, event.kind);
  }

  const withError = {
    kind: "conversation.message.completed",
    sessionId: "session-1",
    turnId: "turn-1",
    messageId: "msg-err",
    item: {
      kind: "message",
      itemId: "msg-err",
      parentId: null,
      createdAt: "2026-08-15T12:00:00.000Z",
      role: "assistant",
      content: [],
    },
    error: {
      message: "Model is not supported by composite groups",
      status: 400,
      provider: "sub2api-go",
      model: "mimo-v2.5",
    },
  };
  assert.deepEqual(parseConversationRuntimeEvent(withError), withError);
  assert.throws(
    () => parseConversationRuntimeEvent({ ...withError, error: { message: "" } }),
    ContractValidationError,
  );

  assert.throws(
    () => parseConversationRuntimeEvent({ ...started, occurredAt: "2026-08-15T12:00:00.000Z" }),
    ContractValidationError,
  );
  assert.throws(
    () =>
      parseConversationRuntimeEvent({
        kind: "conversation.message.completed",
        sessionId: "session-1",
        turnId: "turn-1",
        messageId: "live-1",
        item: {
          kind: "message",
          itemId: "persisted-2",
          parentId: null,
          createdAt: "2026-08-15T12:00:00.000Z",
          role: "assistant",
          content: [{ type: "text", text: "Hello" }],
        },
      }),
    ContractValidationError,
  );
  assert.throws(
    () => parseStudioEventEnvelope(envelope({ kind: "conversation.unknown", sessionId: "session-1" })),
    ContractValidationError,
  );
});

test("publicConversationToolCallId keeps distinct long ids unique", () => {
  const prefix = "x".repeat(CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS);
  const left = publicConversationToolCallId(`${prefix}a`, "fallback");
  const right = publicConversationToolCallId(`${prefix}b`, "fallback");
  assert.equal(left.truncated, true);
  assert.equal(right.truncated, true);
  assert.notEqual(left.id, right.id);
  assert.ok(left.id.length <= CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS);
  assert.equal(publicConversationToolCallId("", "tool:entry").id, "tool:entry");
});

test("truncateUtf8 does not split a multibyte codepoint", () => {
  const cut = truncateUtf8("é", 1);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, "");
  const ascii = truncateUtf8("ab", 1);
  assert.equal(ascii.text, "a");
});

test("truncateUtf8 keeps text whole under the 3-bytes-per-unit bound and still cuts by bytes above it", () => {
  // "字" 是 3 字节 1 个 UTF-16 单元：length*3 === maxBytes，走 O(1) 快路径，不做编码。
  const text = "字".repeat(1000);
  const kept = truncateUtf8(text, 3000);
  assert.equal(kept.truncated, false);
  assert.equal(kept.text, text);
  // 差一个字节就要真正按字节截断，且不能切断码点。
  const cut = truncateUtf8(text, 2999);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 999);
  // 纯 ASCII 时长度界过不了，仍然要靠编码判断，结果必须与原来一致。
  const ascii = "a".repeat(1000);
  assert.deepEqual(truncateUtf8(ascii, 1000), { text: ascii, truncated: false });
});
