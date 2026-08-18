import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONVERSATION_LIMITS,
  type AuthorityEpoch,
  type ClientError,
  type ClientEvent,
  type ConversationTranscriptReadPage,
  type ConversationTranscriptPage,
  type EventCursor,
  type OpaqueCursor,
  type RuntimeEpoch,
  type SessionId,
  type StateVersion,
} from "@omp-studio/client-contract";

import {
  reduceConversationState,
  type ConversationAction,
} from "../src/conversation-reducer.js";
import {
  CONVERSATION_STATE_LIVE_TOOLS_CAP,
  createInitialConversationState,
  selectConversationHydrate,
  selectConversationViews,
} from "../src/conversation-state.js";

const EPOCH = 1 as RuntimeEpoch;
const SESSION = "session-1" as SessionId;
const OTHER = "session-2" as SessionId;

function page(
  items: ConversationTranscriptPage["items"],
  extra: { readonly sessionId?: SessionId; readonly hasMoreBefore?: boolean } = {},
): ConversationTranscriptPage {
  return {
    runtimeEpoch: EPOCH,
    sessionId: extra.sessionId ?? SESSION,
    branchLeafId: "leaf-1",
    items,
    headCursor: "head-1" as OpaqueCursor,
    hasMoreBefore: extra.hasMoreBefore ?? true,
    olderCursor: "older-1" as OpaqueCursor,
  };
}

function archivePage(
  revision: string,
  items: ConversationTranscriptReadPage["items"],
  sessionId: SessionId = SESSION,
): ConversationTranscriptReadPage {
  return {
    sessionId,
    transcriptRevision: revision,
    branchLeafId: "leaf-1",
    items,
    headCursor: `head-${revision}` as OpaqueCursor,
    olderCursor: `older-${revision}` as OpaqueCursor,
    hasMoreBefore: true,
  };
}

function message(itemId: string, text: string, createdAt: string) {
  return {
    kind: "message" as const,
    itemId,
    parentId: null,
    createdAt,
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  };
}

function liveEvent(
  update: Extract<ClientEvent, { kind: "conversation.changed" }>["update"],
  eventSeq: number,
): Extract<ClientEvent, { kind: "conversation.changed" }> {
  return {
    kind: "conversation.changed",
    authorityEpoch: 1 as AuthorityEpoch,
    runtimeEpoch: EPOCH,
    stateVersion: 4 as StateVersion,
    cursor: String(100 + eventSeq) as EventCursor,
    occurredAt: "2026-08-15T13:00:00.000Z",
    sessionId: update.sessionId,
    eventSeq,
    update,
  };
}

function apply(state = createInitialConversationState(), action: ConversationAction) {
  return reduceConversationState(state, action);
}

test("hydrate sets identity and the latest page; prepend dedupes and keeps order", () => {
  let state = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([message("m2", "newer", "2026-08-15T00:00:02.000Z"), message("m3", "newest", "2026-08-15T00:00:03.000Z")]),
  });
  assert.equal(state.hydrateStatus, "ready");
  assert.deepEqual(state.order, ["m2", "m3"]);
  state = apply(state, {
    type: "prepend",
    generation: 0,
    page: page(
      [message("m1", "older", "2026-08-15T00:00:01.000Z"), message("m2", "newer-dup", "2026-08-15T00:00:02.000Z")],
      { hasMoreBefore: false },
    ),
  });
  assert.deepEqual(state.order, ["m1", "m2", "m3"]);
  assert.equal(state.itemsById.m2?.kind === "message" ? state.itemsById.m2.content[0]?.type === "text" && state.itemsById.m2.content[0].text : "", "newer");
  assert.equal(state.hasMoreBefore, false);
});

test("page identity mismatch is rejected", () => {
  const hydrated = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([message("m1", "a", "2026-08-15T00:00:01.000Z")]),
  });
  const next = apply(hydrated, {
    type: "hydrate",
    generation: 0,
    page: page([message("m9", "other", "2026-08-15T00:00:01.000Z")], { sessionId: OTHER }),
  });
  assert.equal(next, hydrated);
});

test("begin hydrate switches the target identity so an inactive archive session can load", () => {
  let state = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([message("a1", "active", "2026-08-15T00:00:01.000Z")]),
  });
  state = apply(state, { type: "beginHydrate", identity: { sessionId: OTHER } });
  const generation = state.hydrateGeneration;
  assert.deepEqual(state.identity, { sessionId: OTHER });
  assert.equal(state.hydrateStatus, "loading");
  assert.deepEqual(state.order, []);

  state = apply(state, {
    type: "hydrateArchive",
    generation,
    page: archivePage("revision-b", [message("b1", "history", "2026-08-15T00:00:02.000Z")], OTHER),
  });
  assert.equal(state.hydrateStatus, "ready");
  assert.deepEqual(state.identity, { sessionId: OTHER, transcriptRevision: "revision-b" });
  assert.deepEqual(state.order, ["b1"]);
});

test("begin hydrate preserves visible items when refreshing the same session", () => {
  const hydrated = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([message("m1", "visible", "2026-08-15T00:00:01.000Z")]),
  });
  const loading = apply(hydrated, {
    type: "beginHydrate",
    identity: { runtimeEpoch: EPOCH, sessionId: SESSION },
  });
  assert.equal(loading.hydrateStatus, "loading");
  assert.deepEqual(loading.order, ["m1"]);
  assert.equal(loading.itemsById.m1, hydrated.itemsById.m1);
});

test("rapid target switches reject a late archive page from the previous session", () => {
  let state = apply(undefined, { type: "beginHydrate", identity: { sessionId: SESSION } });
  const oldGeneration = state.hydrateGeneration;
  state = apply(state, { type: "beginHydrate", identity: { sessionId: OTHER } });
  const currentGeneration = state.hydrateGeneration;
  const beforeLatePage = state;
  state = apply(state, {
    type: "hydrateArchive",
    generation: oldGeneration,
    page: archivePage("revision-a", [message("a1", "late", "2026-08-15T00:00:01.000Z")]),
  });
  assert.equal(state, beforeLatePage);
  state = apply(state, {
    type: "hydrateArchive",
    generation: currentGeneration,
    page: archivePage("revision-b", [message("b1", "current", "2026-08-15T00:00:02.000Z")], OTHER),
  });
  assert.deepEqual(state.order, ["b1"]);
});

test("latest archive hydrate accepts a new transcript revision but stale prepend does not", () => {
  let state = apply(undefined, { type: "beginHydrate", identity: { sessionId: SESSION } });
  state = apply(state, {
    type: "hydrateArchive",
    generation: state.hydrateGeneration,
    page: archivePage("revision-1", [message("m1", "old", "2026-08-15T00:00:01.000Z")]),
  });
  state = apply(state, { type: "beginHydrate", identity: { sessionId: SESSION } });
  state = apply(state, {
    type: "hydrateArchive",
    generation: state.hydrateGeneration,
    page: archivePage("revision-2", [message("m2", "new", "2026-08-15T00:00:02.000Z")]),
  });
  assert.equal(state.hydrateStatus, "ready");
  assert.equal(state.transcriptRevision, "revision-2");
  assert.deepEqual(state.order, ["m2"]);
  const beforePrepend = state;
  state = apply(state, {
    type: "prependArchive",
    generation: state.hydrateGeneration,
    page: archivePage("revision-1", [message("m0", "stale", "2026-08-15T00:00:00.000Z")]),
  });
  assert.equal(state, beforePrepend);
});

test("stale hydrate generation is ignored after session switch", () => {
  let state = apply(undefined, { type: "beginHydrate", identity: { runtimeEpoch: EPOCH, sessionId: SESSION } });
  const generation = state.hydrateGeneration;
  state = apply(state, { type: "clear" });
  state = apply(state, {
    type: "hydrate",
    generation,
    page: page([message("m-old", "stale", "2026-08-15T00:00:01.000Z")]),
  });
  assert.equal(state.hydrateStatus, "idle");
  assert.equal(state.order.length, 0);
});

test("start/delta/completed converge on one node; late delta after completed is ignored", () => {
  let state = createInitialConversationState();
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: "Hel",
      },
      2,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: "lo",
      },
      3,
    ),
  });
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.text, "Hello");
  const item = {
    kind: "message" as const,
    itemId: "msg-1",
    parentId: null,
    createdAt: "2026-08-15T12:00:00.000Z",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Hello" }],
  };
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        item,
      },
      4,
    ),
  });
  const dup = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        item,
      },
      5,
    ),
  });
  assert.equal(dup.itemsById["msg-1"]?.kind, "message");
  assert.equal(dup.liveMessages["msg-1"], undefined);
  const late = apply(dup, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: " extra",
      },
      6,
    ),
  });
  const completed = late.itemsById["msg-1"];
  assert.ok(completed && completed.kind === "message");
  assert.equal(completed.content[0]?.type === "text" ? completed.content[0].text : "", "Hello");
});

test("tool start/update/end track the same toolCallId", () => {
  let state = createInitialConversationState();
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "Read",
        startedAt: "2026-08-15T12:00:00.000Z",
        arguments: { path: "package.json" },
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.updated",
        sessionId: SESSION,
        turnId: "t1",
        toolCallId: "call-1",
        updateMode: "append",
        output: "{",
      },
      2,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.completed",
        sessionId: SESSION,
        turnId: "t1",
        toolCallId: "call-1",
        completedAt: "2026-08-15T12:00:01.000Z",
        result: {
          type: "toolResult",
          toolCallId: "call-1",
          toolName: "Read",
          output: "{ \"ok\": true }",
          data: { totalLines: 4 },
          isError: false,
        },
      },
      3,
    ),
  });
  assert.equal(state.liveTools["call-1"]?.status, "completed");
  assert.equal(state.liveTools["call-1"]?.isError, false);
  assert.equal(state.liveTools["call-1"]?.output, "{ \"ok\": true }");
  assert.deepEqual(state.liveTools["call-1"]?.result?.data, { totalLines: 4 });
});

test("tool events after message.completed stay attached to the persisted assistant item", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        item: {
          kind: "message",
          itemId: "msg-1",
          parentId: null,
          createdAt: "2026-08-15T12:00:00.000Z",
          role: "assistant",
          content: [{ type: "text", text: "working" }],
        },
      },
      2,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "Read",
        startedAt: "2026-08-15T12:00:01.000Z",
      },
      3,
    ),
  });
  assert.equal(state.itemsById["msg-1"]?.kind, "message");
  assert.equal(state.liveTools["call-1"]?.status, "started");
  const views = selectConversationViews(state);
  const assistant = views.find((view) => view.kind === "item" && view.item.itemId === "msg-1");
  assert.ok(assistant && assistant.kind === "item");
  assert.equal(assistant.tools[0]?.toolCallId, "call-1");
});

test("a tool result whose start event was lost still attaches to its persisted item", () => {
  // Completion can arrive without conversation.tool.started; recover the owner
  // from the persisted item that declared the call.
  let state = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([
      {
        kind: "message",
        itemId: "msg-1",
        parentId: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash" }],
      },
    ]),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.completed",
        sessionId: SESSION,
        turnId: "t1",
        toolCallId: "call-1",
        completedAt: "2026-08-15T12:00:01.000Z",
        result: { type: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, data: { exitCode: 0 } },
      },
      1,
    ),
  });
  assert.equal(state.liveTools["call-1"]?.messageId, "msg-1");
  const view = selectConversationViews(state).find((entry) => entry.kind === "item");
  assert.ok(view && view.kind === "item");
  assert.equal(view.tools[0]?.result?.data !== undefined, true);
});

test("an item stays turnOpen until its turn reports completed", () => {
  const item = {
    kind: "message" as const,
    itemId: "msg-1",
    parentId: null,
    createdAt: "2026-08-15T12:00:00.000Z",
    role: "assistant" as const,
    content: [
      { type: "toolCall" as const, toolCallId: "call-1", toolName: "read" },
      { type: "toolCall" as const, toolCallId: "call-2", toolName: "read" },
    ],
  };
  // The runtime persists the assistant item before any tool starts.
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      { kind: "conversation.message.completed", sessionId: SESSION, turnId: "t1", messageId: "msg-1", item },
      1,
    ),
  });
  const open = selectConversationViews(state).find((view) => view.kind === "item");
  assert.ok(open && open.kind === "item");
  assert.equal(open.turnOpen, true);

  state = apply(state, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.completed", sessionId: SESSION, turnId: "t1" }, 2),
  });
  const closed = selectConversationViews(state).find((view) => view.kind === "item");
  assert.ok(closed && closed.kind === "item");
  assert.equal(closed.turnOpen, false);
});

test("turn abort closes the turn so its unstarted tools stop reading as pending", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        item: {
          kind: "message",
          itemId: "msg-1",
          parentId: null,
          createdAt: "2026-08-15T12:00:00.000Z",
          role: "assistant",
          content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash" }],
        },
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 2),
  });
  const view = selectConversationViews(state).find((entry) => entry.kind === "item");
  assert.ok(view && view.kind === "item");
  assert.equal(view.turnOpen, false);
});

const PROVIDER_ERROR = {
  message: "Upstream service temporarily unavailable",
  status: 502,
  provider: "sub2api-go",
  model: "mimo-v2.5",
} as const;

function assistantCompleted(
  messageId: string,
  extra: {
    readonly error?: typeof PROVIDER_ERROR;
    readonly text?: string;
    readonly seq?: number;
  } = {},
) {
  return liveEvent(
    {
      kind: "conversation.message.completed",
      sessionId: SESSION,
      turnId: "t1",
      messageId,
      item: {
        kind: "message",
        itemId: messageId,
        parentId: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        role: "assistant",
        content: extra.text === undefined ? [] : [{ type: "text", text: extra.text }],
      },
      ...(extra.error === undefined ? {} : { error: extra.error }),
    },
    extra.seq ?? 1,
  );
}

test("provider error stays through hydrate, abort, and session switch until the next successful assistant return", () => {
  let state = apply(undefined, {
    type: "live",
    event: assistantCompleted("msg-1", { error: PROVIDER_ERROR }),
  });
  assert.deepEqual(state.itemErrors["msg-1"], PROVIDER_ERROR);
  assert.deepEqual(state.stickyProviderErrors[SESSION]?.error, PROVIDER_ERROR);
  const item = state.itemsById["msg-1"];
  assert.ok(item && item.kind === "message");
  assert.equal("error" in item, false);

  state = apply(state, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 2),
  });
  assert.deepEqual(state.itemErrors["msg-1"], PROVIDER_ERROR);

  state = apply(state, {
    type: "hydrate",
    generation: 0,
    page: page([
      {
        kind: "message",
        itemId: "msg-1",
        parentId: null,
        createdAt: "2026-08-15T12:00:00.000Z",
        role: "assistant",
        content: [],
      },
    ]),
  });
  assert.deepEqual(state.itemErrors["msg-1"], PROVIDER_ERROR);

  state = apply(state, {
    type: "beginHydrate",
    identity: { runtimeEpoch: EPOCH, sessionId: OTHER },
  });
  assert.deepEqual(state.itemErrors, {});
  assert.deepEqual(state.stickyProviderErrors[SESSION]?.error, PROVIDER_ERROR);

  state = apply(state, {
    type: "beginHydrate",
    identity: { runtimeEpoch: EPOCH, sessionId: SESSION },
  });
  state = apply(state, {
    type: "hydrate",
    generation: state.hydrateGeneration,
    page: page([message("u1", "hello", "2026-08-15T11:00:00.000Z")]),
  });
  assert.deepEqual(state.itemErrors["msg-1"], PROVIDER_ERROR);

  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t-user",
        messageId: "u2",
        item: {
          kind: "message",
          itemId: "u2",
          parentId: null,
          createdAt: "2026-08-15T12:01:00.000Z",
          role: "user",
          content: [{ type: "text", text: "retry" }],
        },
      },
      3,
    ),
  });
  assert.deepEqual(state.itemErrors["msg-1"], PROVIDER_ERROR);

  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t2",
        messageId: "msg-2",
        item: {
          kind: "message",
          itemId: "msg-2",
          parentId: null,
          createdAt: "2026-08-15T12:02:00.000Z",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      },
      4,
    ),
  });
  assert.deepEqual(state.itemErrors, {});
  assert.equal(state.stickyProviderErrors[SESSION], undefined);
});

test("aborted provider error keeps the 502 copy instead of dropping it", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 1),
  });
  state = apply(state, {
    type: "live",
    event: assistantCompleted("msg-1", { error: PROVIDER_ERROR, seq: 2 }),
  });
  assert.equal(state.liveMessages["msg-1"]?.aborted, true);
  assert.deepEqual(state.itemErrors["msg-1"], PROVIDER_ERROR);
  assert.deepEqual(state.stickyProviderErrors[SESSION]?.error, PROVIDER_ERROR);
});

test("session/epoch live events for a different identity are dropped", () => {
  let state = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([message("m1", "a", "2026-08-15T00:00:01.000Z")]),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: OTHER,
        turnId: "t1",
        messageId: "msg-x",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  assert.equal(state.liveMessages["msg-x"], undefined);
  assert.deepEqual(state.order, ["m1"]);
});

test("eventSeq skips from interleaved non-conversation events do not resync", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      10,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: "after-state-changed",
      },
      12,
    ),
  });
  assert.equal(state.resyncRequired, false);
  assert.equal(state.lastEventSeq, 12);
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.text, "after-state-changed");
});

test("rehydrate after a resync clears the flag and does not keep the old eventSeq", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, { type: "resync" });
  assert.equal(state.resyncRequired, true);
  state = apply(state, { type: "beginHydrate", identity: { runtimeEpoch: EPOCH, sessionId: SESSION } });
  state = apply(state, {
    type: "hydrate",
    generation: state.hydrateGeneration,
    page: page([message("m1", "user", "2026-08-15T00:00:01.000Z")]),
  });
  assert.equal(state.resyncRequired, false);
  assert.equal(state.lastEventSeq, undefined);
  assert.deepEqual(state.order, ["m1", "msg-1"]);
  assert.equal(state.liveMessages["msg-1"]?.role, "assistant");
});

test("selectConversationViews prefers completed items over live nodes", () => {
  let state = apply(undefined, {
    type: "hydrate",
    generation: 0,
    page: page([message("m1", "user", "2026-08-15T00:00:01.000Z")]),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  const views = selectConversationViews(state);
  assert.equal(views[0]?.kind, "item");
  assert.equal(views[1]?.kind, "live");
});

test("hydrate error is recorded only for the current generation", () => {
  let state = apply(undefined, { type: "beginHydrate", identity: { runtimeEpoch: EPOCH, sessionId: SESSION } });
  const error: ClientError = { code: "UNAVAILABLE", message: "runtime down" };
  state = apply(state, { type: "error", generation: state.hydrateGeneration, error });
  assert.equal(state.hydrateStatus, "error");
  assert.equal(state.error?.code, "UNAVAILABLE");
  const hydrate = selectConversationHydrate(state);
  assert.equal(hydrate.status, "error");
  assert.equal(hydrate.error?.code, "UNAVAILABLE");
  assert.equal(hydrate.error?.message, "runtime down");
});

test("selectConversationHydrate omits error while loading", () => {
  const state = apply(undefined, { type: "beginHydrate", identity: { runtimeEpoch: EPOCH, sessionId: SESSION } });
  const hydrate = selectConversationHydrate(state);
  assert.equal(hydrate.status, "loading");
  assert.equal("error" in hydrate, false);
});

test("turn abort keeps received text, is idempotent, and drops late deltas", () => {
  let state = createInitialConversationState();
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: "partial",
      },
      2,
    ),
  });
  const aborted = apply(state, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 3),
  });
  assert.equal(aborted.liveMessages["msg-1"]?.aborted, true);
  assert.equal(aborted.liveMessages["msg-1"]?.blocks.b1?.text, "partial");
  assert.equal(aborted.abortedTurns.t1, true);
  const views = selectConversationViews(aborted);
  assert.equal(views[0]?.kind, "live");
  if (views[0]?.kind === "live") {
    assert.equal(views[0].message.aborted, true);
    assert.equal(views[0].message.blocks.b1?.text, "partial");
  }

  const duplicate = apply(aborted, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 4),
  });
  assert.equal(duplicate.liveMessages["msg-1"]?.aborted, true);
  assert.equal(duplicate.liveMessages["msg-1"]?.blocks.b1?.text, "partial");
  assert.equal(duplicate.abortedTurns.t1, true);

  const late = apply(duplicate, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: " after-abort",
      },
      5,
    ),
  });
  assert.equal(late.liveMessages["msg-1"]?.blocks.b1?.text, "partial");
  assert.equal(late.liveMessages["msg-1"]?.aborted, true);
});

test("message.completed after abort converges text but keeps the aborted view", () => {
  let state = createInitialConversationState();
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: "partial",
      },
      2,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 3),
  });
  const item = {
    kind: "message" as const,
    itemId: "msg-1",
    parentId: null,
    createdAt: "2026-08-15T12:00:00.000Z",
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "partial answer" }],
  };
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.completed",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        item,
      },
      4,
    ),
  });
  assert.equal(state.liveMessages["msg-1"]?.aborted, true);
  assert.equal(state.abortedTurns.t1, true);
  const liveText = Object.values(state.liveMessages["msg-1"]?.blocks ?? {})
    .filter((block) => block.blockType === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(liveText, "partial answer");
  const views = selectConversationViews(state);
  assert.equal(views[0]?.kind, "live");
  if (views[0]?.kind === "live") {
    assert.equal(views[0].message.aborted, true);
    assert.equal(
      Object.values(views[0].message.blocks)
        .filter((block) => block.blockType === "text")
        .map((block) => block.text)
        .join(""),
      "partial answer",
    );
  }

  const late = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: " after-complete",
      },
      5,
    ),
  });
  const lateText = Object.values(late.liveMessages["msg-1"]?.blocks ?? {})
    .filter((block) => block.blockType === "text")
    .map((block) => block.text)
    .join("");
  assert.equal(late.liveMessages["msg-1"]?.aborted, true);
  assert.equal(lateText, "partial answer");
});

test("turn.aborted marks running tools aborted; a late completion still overrides", () => {
  let state = createInitialConversationState();
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "bash",
        startedAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent({ kind: "conversation.turn.aborted", sessionId: SESSION, turnId: "t1" }, 2),
  });
  assert.equal(state.liveTools["call-1"]?.status, "aborted");

  // A start replay cannot resurrect an aborted tool into a running spinner.
  const replayed = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "bash",
        startedAt: "2026-08-15T12:00:02.000Z",
      },
      3,
    ),
  });
  assert.equal(replayed.liveTools["call-1"]?.status, "aborted");

  // The authoritative result, when the runtime did emit one, still lands.
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.completed",
        sessionId: SESSION,
        turnId: "t1",
        toolCallId: "call-1",
        result: { type: "toolResult", toolCallId: "call-1", isError: true, output: "aborted by user" },
        completedAt: "2026-08-15T12:00:03.000Z",
      },
      3,
    ),
  });
  assert.equal(state.liveTools["call-1"]?.status, "completed");
  assert.equal(state.liveTools["call-1"]?.isError, true);
});

test("live block accumulation is capped and later deltas for the block are dropped", () => {
  const cap = CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES;
  const chunk = "x".repeat(200_000);
  let state = createInitialConversationState();
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  const delta = (seq: number): ConversationAction => ({
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.delta",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        blockId: "b1",
        blockType: "text",
        delta: chunk,
      },
      seq,
    ),
  });
  state = apply(state, delta(2));
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.text.length, 200_000);
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.truncated, undefined);
  state = apply(state, delta(3));
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.text.length, cap);
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.truncated, true);
  state = apply(state, delta(4));
  assert.equal(state.liveMessages["msg-1"]?.blocks.b1?.text.length, cap);
});

test("appended live tool output is capped so a broken append stream cannot grow past the text block budget", () => {
  const cap = CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES;
  const chunk = "x".repeat(200_000);
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "bash",
        startedAt: "2026-08-15T12:00:01.000Z",
      },
      2,
    ),
  });
  const append = (seq: number): ConversationAction => ({
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.updated",
        sessionId: SESSION,
        turnId: "t1",
        toolCallId: "call-1",
        updateMode: "append",
        output: chunk,
      },
      seq,
    ),
  });
  state = apply(state, append(3));
  assert.equal(state.liveTools["call-1"]?.output?.length, 200_000);
  assert.equal(state.liveTools["call-1"]?.truncated, undefined);
  state = apply(state, append(4));
  assert.equal(state.liveTools["call-1"]?.output?.length, cap);
  assert.equal(state.liveTools["call-1"]?.truncated, true);
  state = apply(state, append(5));
  assert.equal(state.liveTools["call-1"]?.output?.length, cap);
});

test("startTool keeps output that arrived before the start event", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.updated",
        sessionId: SESSION,
        turnId: "t1",
        toolCallId: "call-1",
        updateMode: "replace",
        output: "partial-stdout",
      },
      2,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "bash",
        startedAt: "2026-08-15T12:00:01.000Z",
      },
      3,
    ),
  });
  assert.equal(state.liveTools["call-1"]?.output, "partial-stdout");
  assert.equal(state.liveTools["call-1"]?.messageId, "msg-1");
});

test("rehydrate after a resync keeps in-flight live tools", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.tool.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        toolCallId: "call-1",
        toolName: "bash",
        startedAt: "2026-08-15T12:00:01.000Z",
      },
      2,
    ),
  });
  state = apply(state, { type: "resync" });
  state = apply(state, { type: "beginHydrate", identity: { runtimeEpoch: EPOCH, sessionId: SESSION } });
  state = apply(state, {
    type: "hydrate",
    generation: state.hydrateGeneration,
    page: page([message("m1", "hello", "2026-08-15T00:00:01.000Z")]),
  });
  assert.equal(state.resyncRequired, false);
  assert.equal(state.liveTools["call-1"]?.status, "started");
  assert.equal(state.liveMessages["msg-1"]?.role, "assistant");
});

test("settled live tools are capped without dropping running ones", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.message.started",
        sessionId: SESSION,
        turnId: "t1",
        messageId: "msg-1",
        role: "assistant",
        createdAt: "2026-08-15T12:00:00.000Z",
      },
      1,
    ),
  });
  let seq = 2;
  for (let index = 0; index < CONVERSATION_STATE_LIVE_TOOLS_CAP + 1; index += 1) {
    state = apply(state, {
      type: "live",
      event: liveEvent(
        {
          kind: "conversation.tool.completed",
          sessionId: SESSION,
          turnId: "t1",
          toolCallId: `call-${index}`,
          completedAt: "2026-08-15T12:00:01.000Z",
          result: { type: "toolResult", toolCallId: `call-${index}`, isError: false, output: "ok" },
        },
        seq,
      ),
    });
    seq += 1;
  }
  assert.equal(Object.keys(state.liveTools).length, CONVERSATION_STATE_LIVE_TOOLS_CAP);
  assert.equal(state.liveTools["call-0"], undefined);
  assert.equal(state.liveTools[`call-${CONVERSATION_STATE_LIVE_TOOLS_CAP}`]?.status, "completed");
});

test("compaction.started exposes a compacting view that completed replaces with the summary item", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.compaction.started",
        sessionId: SESSION,
        action: "context-full",
      },
      1,
    ),
  });
  assert.deepEqual(state.compacting, { action: "context-full" });
  const pending = selectConversationViews(state);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, "compacting");
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.compaction.completed",
        sessionId: SESSION,
        aborted: false,
        item: {
          kind: "compaction",
          itemId: "cp-1",
          parentId: null,
          createdAt: "2026-08-19T00:00:00.000Z",
          summary: "Earlier turns were summarized.",
        },
      },
      2,
    ),
  });
  assert.equal(state.compacting, undefined);
  const views = selectConversationViews(state);
  assert.equal(views.length, 1);
  assert.equal(views[0]?.kind, "item");
  assert.equal(views[0]?.kind === "item" ? views[0].item.itemId : "", "cp-1");
});

test("aborted compaction clears compacting and does not invent a summary item", () => {
  let state = apply(undefined, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.compaction.started",
        sessionId: SESSION,
        action: "manual",
      },
      1,
    ),
  });
  state = apply(state, {
    type: "live",
    event: liveEvent(
      {
        kind: "conversation.compaction.completed",
        sessionId: SESSION,
        aborted: true,
      },
      2,
    ),
  });
  assert.equal(state.compacting, undefined);
  assert.equal(selectConversationViews(state).length, 0);
  assert.equal(state.notices.at(-1)?.message, "上下文压缩已中止");
});
