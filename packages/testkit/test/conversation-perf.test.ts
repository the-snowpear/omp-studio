import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createInitialConversationState,
  reduceConversationState,
  selectConversationViews,
} from "@omp-studio/client";
import type { OpaqueCursor, SessionId } from "@omp-studio/client-contract";

import {
  CONVERSATION_FIXTURE_IDS,
  conversationChangedEvent,
  conversationLiveSequence,
  conversationPages,
} from "../src/conversation-fixtures.js";

test("100 sequential tool updates stay on one tool row", () => {
  let state = reduceConversationState(createInitialConversationState(), {
    type: "hydrate",
    generation: 0,
    page: conversationPages.empty,
  });
  state = reduceConversationState(state, {
    type: "live",
    event: conversationChangedEvent(conversationLiveSequence[0]!, 1),
  });
  state = reduceConversationState(state, {
    type: "live",
    event: conversationChangedEvent(
      conversationLiveSequence.find((entry) => entry.kind === "conversation.tool.started")!,
      2,
    ),
  });
  let seq = 2;
  for (let i = 0; i < 100; i++) {
    seq += 1;
    state = reduceConversationState(state, {
      type: "live",
      event: conversationChangedEvent(
        {
          kind: "conversation.tool.updated",
          sessionId: CONVERSATION_FIXTURE_IDS.sessionId,
          turnId: CONVERSATION_FIXTURE_IDS.turnId,
          toolCallId: CONVERSATION_FIXTURE_IDS.toolCallId,
          updateMode: "append",
          output: ".",
        },
        seq,
      ),
    });
  }
  assert.equal(Object.keys(state.liveTools).length, 1);
  assert.equal(state.liveTools[CONVERSATION_FIXTURE_IDS.toolCallId]?.output?.length, 100);
  assert.equal(state.resyncRequired, false);
});

test("1000 persisted items paginated by 50 stay unique after 20 prepends", () => {
  const sessionId = CONVERSATION_FIXTURE_IDS.sessionId;
  const pages = [];
  for (let batch = 0; batch < 20; batch++) {
    const items = [];
    for (let i = 0; i < 50; i++) {
      const n = batch * 50 + i;
      items.push({
        kind: "message" as const,
        itemId: `msg-cap-${n}`,
        parentId: null,
        createdAt: `2026-08-15T12:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`,
        role: n % 2 === 0 ? ("user" as const) : ("assistant" as const),
        content: [{ type: "text" as const, text: `item ${n}` }],
      });
    }
    pages.push({
      runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
      sessionId,
      branchLeafId: "leaf-fixture",
      items,
      headCursor: `opaque-head-${batch}` as OpaqueCursor,
      olderCursor: `opaque-older-${batch}` as OpaqueCursor,
      hasMoreBefore: batch < 19,
    });
  }
  let state = reduceConversationState(createInitialConversationState(), { type: "beginHydrate", identity: { sessionId: CONVERSATION_FIXTURE_IDS.sessionId } });
  state = reduceConversationState(state, { type: "hydrate", generation: state.hydrateGeneration, page: pages[0]! });
  for (let i = 1; i < pages.length; i++) {
    state = reduceConversationState(state, { type: "prepend", generation: state.hydrateGeneration, page: pages[i]! });
  }
  assert.equal(state.order.length, 500);
  assert.equal(new Set(state.order).size, 500);
  const views = selectConversationViews(state);
  assert.equal(views.length, 500);
});

test("20 reload hydrates of the same page do not duplicate items", () => {
  let state = createInitialConversationState();
  for (let i = 0; i < 20; i++) {
    state = reduceConversationState(state, { type: "beginHydrate", identity: { sessionId: CONVERSATION_FIXTURE_IDS.sessionId } });
    state = reduceConversationState(state, {
      type: "hydrate",
      generation: state.hydrateGeneration,
      page: conversationPages.userAssistant,
    });
  }
  assert.equal(state.order.length, 2);
  assert.equal(new Set(state.order).size, 2);
});

test("10k-character small deltas coalesce onto one live block without quadratic item growth", () => {
  let state = reduceConversationState(createInitialConversationState(), {
    type: "hydrate",
    generation: 0,
    page: conversationPages.empty,
  });
  state = reduceConversationState(state, {
    type: "live",
    event: conversationChangedEvent(conversationLiveSequence[0]!, 1),
  });
  const chunk = "abcdefghij";
  const chunks = 1000;
  for (let i = 0; i < chunks; i++) {
    state = reduceConversationState(state, {
      type: "live",
      event: conversationChangedEvent(
        {
          kind: "conversation.message.delta",
          sessionId: CONVERSATION_FIXTURE_IDS.sessionId as SessionId,
          turnId: CONVERSATION_FIXTURE_IDS.turnId,
          messageId: CONVERSATION_FIXTURE_IDS.assistantItemId,
          blockId: CONVERSATION_FIXTURE_IDS.blockId,
          blockType: "text",
          delta: chunk,
        },
        i + 2,
      ),
    });
  }
  const live = state.liveMessages[CONVERSATION_FIXTURE_IDS.assistantItemId];
  assert.equal(Object.keys(state.liveMessages).length, 1);
  assert.equal(live?.blocks[CONVERSATION_FIXTURE_IDS.blockId]?.text.length, chunk.length * chunks);
  assert.equal(selectConversationViews(state).length, 1);
});
