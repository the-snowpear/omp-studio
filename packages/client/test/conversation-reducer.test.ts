import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AuthorityEpoch,
  ClientError,
  ClientEvent,
  ConversationTranscriptReadPage,
  ConversationTranscriptPage,
  EventCursor,
  OpaqueCursor,
  RuntimeEpoch,
  SessionId,
  StateVersion,
} from "@omp-studio/client-contract";

import {
  reduceConversationState,
  type ConversationAction,
} from "../src/conversation-reducer.js";
import {
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
  assert.deepEqual(state.order, ["m1"]);
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
