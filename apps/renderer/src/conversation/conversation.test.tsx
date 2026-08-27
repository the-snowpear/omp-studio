import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";

const { mermaidRenderMock } = vi.hoisted(() => ({ mermaidRenderMock: vi.fn() }));
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: mermaidRenderMock,
  },
}));
import {
  createInitialConversationState,
  reduceConversationState,
  selectConversationHydrate,
  selectConversationViews,
} from "@omp-studio/client";
import type {
  AuthorityEpoch,
  ClientError,
  ClientEvent,
  ConversationItem,
  ConversationRuntimeEvent,
  ConversationTranscriptReadPage,
  ConversationTranscriptPage,
  EventCursor,
  JsonValue,
  OpaqueCursor,
  QueryInput,
  QueryName,
  QueryResult,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  SubscriptionScope,
  Unsubscribe,
} from "@omp-studio/client-contract";
import { createConversationEngine } from "./conversationEngine";
import {
  ARCHIVE_TRANSCRIPT_QUERY_NAME,
  TRANSCRIPT_QUERY_NAME,
  type ConversationClient,
  type ConversationIdentity,
} from "./conversationHost";
import { ConversationItemView } from "./ConversationItemView";
import { serializedCopyFromHost } from "./UserMessageBody";
import { ConversationPane, parseXdevMountNotice } from "./ConversationPane";
import { ConvoTranscript, turnChangeBinds } from "./ConvoTranscript";
import { PlanReviewDeck } from "../deck/PlanCard";
import { ToolBody } from "./ToolBody";
import { batchSummary, collectLatestTodos, collectTurnFileChanges, groupTodosByPhase, isTodoPhaseComplete, sessionTaskProgress, todoPhaseHeadersVisible, todoPhaseOpenByDefault, todoStepProgress, toolDiffStats, toolKind, SESSION_CHANGE_LAST_ID } from "./toolMeta";
import { conversationFollowKey, distanceFromBottom, shouldFollow } from "./useConversationScroll";
import {
  absorbPendingDisplays,
  applyLiveEvent,
  buildTimeline,
  emptyConversationState,
  failPending,
  hydratePage,
  resetConversation,
  rowsFromConversationViews,
  segmentsFromContent,
  trackPending,
  withCompactingRow,
  type TimelineRow,
  type ToolView,
} from "./conversationViewModel";
import { PREVIEW_CONVO_IDENTITY, PREVIEW_CONVO_ITEMS, previewConversationRows, previewGalleryItems } from "../preview/conversationFixtures";
import { createMemoryThumbStore } from "./userMessageThumbs";

afterEach(cleanup);

const epoch = 1 as RuntimeEpoch;
const session = "session-a" as SessionId;
const identity: ConversationIdentity = { runtimeEpoch: epoch, sessionId: session };
const other: ConversationIdentity = { runtimeEpoch: 2 as RuntimeEpoch, sessionId: "session-b" as SessionId };

function page(partial: Partial<ConversationTranscriptPage> & { items: readonly ConversationItem[] }): ConversationTranscriptPage {
  return {
    runtimeEpoch: partial.runtimeEpoch ?? epoch,
    sessionId: session,
    branchLeafId: "leaf-1",
    headCursor: "head-1" as OpaqueCursor,
    hasMoreBefore: false,
    ...partial,
  };
}

function archivePage(
  sessionId: SessionId,
  items: readonly ConversationItem[],
): ConversationTranscriptReadPage {
  return {
    sessionId,
    transcriptRevision: `revision-${sessionId}`,
    branchLeafId: "leaf-archive",
    headCursor: "head-archive" as OpaqueCursor,
    hasMoreBefore: false,
    items,
  };
}

function userItem(id: string, text: string): ConversationItem {
  return {
    kind: "message",
    itemId: id,
    parentId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    role: "user",
    content: [{ type: "text", text }],
  };
}

function assistantItem(id: string, text: string): Extract<ConversationItem, { kind: "message" }> {
  return {
    kind: "message",
    itemId: id,
    parentId: null,
    createdAt: "2026-08-15T00:00:01.000Z",
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

function envelope(): Pick<ClientEvent, "authorityEpoch" | "runtimeEpoch" | "stateVersion" | "cursor" | "occurredAt"> {
  return {
    authorityEpoch: 1 as AuthorityEpoch,
    runtimeEpoch: epoch,
    stateVersion: 1 as StateVersion,
    cursor: "10" as EventCursor,
    occurredAt: "2026-08-15T00:00:00.000Z",
  };
}

class FakeClient implements ConversationClient {
  conversation = createInitialConversationState();
  commands: ReturnType<ConversationClient["getState"]>["commands"] = {};
  reads: Array<{ name: string; input: { cursor?: OpaqueCursor; limit?: number } }> = [];
  hydrateCalls: Array<{ mode: "hydrate" | "prepend"; generation: number }> = [];
  begins = 0;
  beginIdentities: ConversationIdentity[] = [];
  runtimeListeners = new Set<(event: ClientEvent) => void>();
  stateListeners = new Set<(state: ReturnType<ConversationClient["getState"]>) => void>();
  queue: Array<{
    resolve: (page: ConversationTranscriptPage | ConversationTranscriptReadPage) => void;
    reject: (error: unknown) => void;
  }> = [];
  auto?: ConversationTranscriptPage | ConversationTranscriptReadPage | { error: { code: string; message: string } };

  getState() {
    return { conversation: this.conversation, commands: this.commands };
  }

  onState(listener: (state: ReturnType<ConversationClient["getState"]>) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  beginTranscriptHydrate(targetIdentity: ConversationIdentity): number {
    this.begins += 1;
    this.beginIdentities.push(targetIdentity);
    this.conversation = reduceConversationState(this.conversation, {
      type: "beginHydrate",
      identity: targetIdentity,
    });
    this.emitState();
    return this.conversation.hydrateGeneration;
  }

  hydrateTranscript(next: ConversationTranscriptPage, generation: number): void {
    this.hydrateCalls.push({ mode: "hydrate", generation });
    this.conversation = reduceConversationState(this.conversation, { type: "hydrate", page: next, generation });
    this.emitState();
  }

  prependTranscript(next: ConversationTranscriptPage, generation: number): void {
    this.hydrateCalls.push({ mode: "prepend", generation });
    this.conversation = reduceConversationState(this.conversation, { type: "prepend", page: next, generation });
    this.emitState();
  }

  hydrateArchiveTranscript(next: ConversationTranscriptReadPage, generation: number): void {
    this.hydrateCalls.push({ mode: "hydrate", generation });
    this.conversation = reduceConversationState(this.conversation, { type: "hydrateArchive", page: next, generation });
    this.emitState();
  }

  prependArchiveTranscript(next: ConversationTranscriptReadPage, generation: number): void {
    this.hydrateCalls.push({ mode: "prepend", generation });
    this.conversation = reduceConversationState(this.conversation, { type: "prependArchive", page: next, generation });
    this.emitState();
  }

  failTranscriptHydrate(error: ClientError, generation: number): void {
    this.conversation = reduceConversationState(this.conversation, { type: "error", error, generation });
    this.emitState();
  }

  async query<TName extends QueryName>(name: TName, input: QueryInput<TName>): Promise<QueryResult<TName>> {
    this.reads.push({ name, input: input as { cursor?: OpaqueCursor; limit?: number } });
    if (name !== TRANSCRIPT_QUERY_NAME && name !== ARCHIVE_TRANSCRIPT_QUERY_NAME) {
      throw { code: "UNAVAILABLE", message: `unexpected query ${name}` };
    }
    if (this.auto && "error" in this.auto) throw this.auto.error;
    if (this.auto && !("error" in this.auto)) return this.auto as QueryResult<TName>;
    const next = await new Promise<ConversationTranscriptPage | ConversationTranscriptReadPage>((resolve, reject) => {
      this.queue.push({ resolve, reject });
    });
    return next as QueryResult<TName>;
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (scope.scope !== "runtime") return () => {};
    this.runtimeListeners.add(listener);
    return () => {
      this.runtimeListeners.delete(listener);
    };
  }

  emit(event: ClientEvent) {
    for (const listener of this.runtimeListeners) listener(event);
  }

  pushLive(update: ConversationRuntimeEvent, eventSeq: number) {
    const event: Extract<ClientEvent, { kind: "conversation.changed" }> = {
      ...envelope(),
      kind: "conversation.changed",
      sessionId: update.sessionId,
      eventSeq,
      update,
    };
    this.conversation = reduceConversationState(this.conversation, { type: "live", event });
    this.emitState();
  }

  emitState() {
    const snapshot = this.getState();
    for (const listener of this.stateListeners) listener(snapshot);
  }

  resolveNext(value: ConversationTranscriptPage | ConversationTranscriptReadPage) {
    const pending = this.queue.shift();
    if (!pending) throw new Error("no pending transcript read");
    pending.resolve(value);
  }

  rejectNext(error: unknown) {
    const pending = this.queue.shift();
    if (!pending) throw new Error("no pending transcript read");
    pending.reject(error);
  }
}

async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function engineOf(client: ConversationClient | null, overrides: Partial<Parameters<typeof createConversationEngine>[0]> = {}) {
  return createConversationEngine({
    preview: false,
    client,
    identity,
    canRead: true,
    runtimeConnected: true,
    previewItems: PREVIEW_CONVO_ITEMS,
    ...overrides,
  });
}

describe("preview vs real isolation", () => {
  it("preview hydrates typed fixtures and never queries transcript", async () => {
    const client = new FakeClient();
    const engine = engineOf(client, { preview: true, identity: PREVIEW_CONVO_IDENTITY });
    engine.start();
    await tick();
    expect(client.reads).toEqual([]);
    expect(client.begins).toBe(0);
    expect(client.runtimeListeners.size).toBe(0);
    const snap = engine.getSnapshot();
    expect(snap.demo).toBe(true);
    expect(snap.rows.some((row) => row.type === "user")).toBe(true);
    expect(snap.state.items.map((item) => item.itemId)).toEqual(PREVIEW_CONVO_ITEMS.map((item) => item.itemId));
  });

  it("real unavailable states do not fall back to preview fixtures", () => {
    const client = new FakeClient();
    const disconnected = engineOf(client, { runtimeConnected: false, identity: null });
    disconnected.start();
    expect(disconnected.getSnapshot().state.hydrateStatus).toBe("unavailable");
    expect(disconnected.getSnapshot().rows).toEqual([]);
    expect(disconnected.getSnapshot().state.items).toEqual([]);

    const noCap = engineOf(client, { canRead: false });
    noCap.start();
    expect(noCap.getSnapshot().state.unavailableReason).toMatch(/session\.history/);
    expect(noCap.getSnapshot().state.items).toEqual([]);
    expect(client.reads).toEqual([]);
    expect(client.begins).toBe(0);
  });

  it("missing ConversationClient stays an honest empty shell", () => {
    const engine = engineOf(null);
    engine.start();
    expect(engine.getSnapshot().state.hydrateStatus).toBe("unavailable");
    expect(engine.getSnapshot().state.unavailableReason).toMatch(/hydrate/);
    expect(engine.getSnapshot().rows).toEqual([]);
  });

  it("missing or throwing getState stays an honest empty shell", () => {
    const missing = new FakeClient();
    missing.getState = () => undefined as never;
    const missingEngine = engineOf(missing);
    expect(missingEngine.getSnapshot().state.hydrateStatus).toBe("unavailable");
    expect(missingEngine.getSnapshot().state.unavailableReason).toMatch(/hydrate/);
    expect(missingEngine.getSnapshot().rows).toEqual([]);

    const throwing = new FakeClient();
    throwing.getState = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'state')");
    };
    const throwingEngine = engineOf(throwing);
    expect(throwingEngine.getSnapshot().state.hydrateStatus).toBe("unavailable");
    expect(throwingEngine.getSnapshot().rows).toEqual([]);
    expect(throwingEngine.getSnapshot().state.items).toEqual([]);
  });
});

describe("hydrate", () => {
  it("loads the latest page via beginHydrate + session.transcript.read + hydrateTranscript", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    expect(engine.getSnapshot().state.hydrateStatus).toBe("loading");
    client.resolveNext(page({ items: [] }));
    await tick();
    const snap = engine.getSnapshot();
    expect(snap.state.hydrateStatus).toBe("ready");
    expect(snap.rows).toEqual([]);
    expect(snap.state.items).toEqual([]);
    expect(client.begins).toBe(1);
    expect(client.reads[0]?.name).toBe("session.transcript.read");
    expect(client.reads[0]?.input).toEqual({ limit: 50 });
    expect(client.hydrateCalls).toEqual([{ mode: "hydrate", generation: 1 }]);
    expect(selectConversationViews(client.conversation)).toEqual([]);
  });

  it("binds hydrate to an inactive archive identity before the page returns", async () => {
    const client = new FakeClient();
    client.conversation = reduceConversationState(client.conversation, {
      type: "hydrate",
      generation: 0,
      page: page({ items: [userItem("a1", "active session")] }),
    });
    const archiveIdentity: ConversationIdentity = { sessionId: other.sessionId };
    const engine = engineOf(client, { identity: archiveIdentity });
    engine.start();

    expect(client.beginIdentities).toEqual([archiveIdentity]);
    expect(client.conversation.identity).toEqual(archiveIdentity);
    expect(client.conversation.hydrateStatus).toBe("loading");
    client.resolveNext(archivePage(other.sessionId, [userItem("b1", "historical session")]));
    await tick();

    expect(engine.getSnapshot().state.hydrateStatus).toBe("ready");
    expect(engine.getSnapshot().state.items.map((item) => item.itemId)).toEqual(["b1"]);
    expect(client.reads[0]?.name).toBe(ARCHIVE_TRANSCRIPT_QUERY_NAME);
  });

  it("hydrate UNAVAILABLE goes through failTranscriptHydrate and selectConversationHydrate", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.rejectNext({ code: "UNAVAILABLE", message: "bridge down" });
    await tick();
    const hydrate = selectConversationHydrate(client.conversation);
    expect(hydrate.status).toBe("error");
    expect(hydrate.error).toEqual({ code: "UNAVAILABLE", message: "bridge down" });
    const snap = engine.getSnapshot();
    expect(snap.state.hydrateStatus).toBe("error");
    expect(snap.state.error).toEqual(hydrate.error);
    expect(snap.state.items).toEqual([]);
    expect(snap.rows).toEqual([]);
    expect(snap.demo).toBe(false);
    expect(snap.state.items.map((item) => item.itemId)).not.toEqual(PREVIEW_CONVO_ITEMS.map((item) => item.itemId));
  });

  it("discards a late query from a previous hydrate generation", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    engine.start();
    client.resolveNext(page({ items: [userItem("old", "stale")], sessionId: session }));
    await tick();
    expect(engine.getSnapshot().state.items).toEqual([]);
    client.resolveNext(
      page({
        runtimeEpoch: epoch,
        sessionId: session,
        items: [userItem("new", "fresh")],
        hasMoreBefore: false,
      }),
    );
    await tick();
    expect(engine.getSnapshot().state.items.map((item) => item.itemId)).toEqual(["new"]);
    expect(client.hydrateCalls.map((entry) => entry.generation)).toEqual([1, 2]);
  });

  it("prepends older pages with the current generation and does not beginHydrate again", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [userItem("u2", "later")], olderCursor: "older-2" as OpaqueCursor, hasMoreBefore: true }));
    await tick();
    const generation = client.conversation.hydrateGeneration;
    expect(generation).toBe(1);
    const older = engine.loadOlder();
    client.resolveNext(page({ items: [userItem("u1", "earlier"), userItem("u2", "later")], hasMoreBefore: false }));
    await older;
    expect(client.begins).toBe(1);
    expect(client.reads[1]?.input.cursor).toBe("older-2");
    expect(client.hydrateCalls[1]).toEqual({ mode: "prepend", generation });
    expect(engine.getSnapshot().state.items.map((item) => item.itemId)).toEqual(["u1", "u2"]);
  });
});

describe("live merge", () => {
  it("start then delta then completed stays one assistant node", () => {
    let state = resetConversation(1, identity, "ready");
    state = applyLiveEvent(state, {
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, identity, 1);
    state = applyLiveEvent(state, {
      kind: "conversation.message.delta",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      blockId: "b1",
      blockType: "text",
      delta: "Hel",
    }, identity, 2);
    state = applyLiveEvent(state, {
      kind: "conversation.message.delta",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      blockId: "b1",
      blockType: "text",
      delta: "lo",
    }, identity, 3);
    const liveRows = buildTimeline(state).filter((row) => row.type === "assistant");
    expect(liveRows).toHaveLength(1);
    expect(liveRows[0]).toMatchObject({ itemId: "m1", status: "streaming" });
    const completed: ConversationRuntimeEvent = {
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      item: assistantItem("m1", "Hello"),
    };
    state = applyLiveEvent(state, completed, identity, 4);
    state = applyLiveEvent(state, {
      kind: "conversation.message.delta",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      blockId: "b1",
      blockType: "text",
      delta: " ignored",
    }, identity, 5);
    const rows = buildTimeline(state).filter((row) => row.type === "assistant");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "m1", status: "completed" });
    if (rows[0]?.type === "assistant") {
      expect(rows[0].segments.some((segment) => segment.type === "text" && segment.text === "Hello")).toBe(true);
      expect(rows[0].segments.some((segment) => segment.type === "text" && segment.text.includes("ignored"))).toBe(false);
    }
  });

  it("tool start/update/end stay one tool row and completed result wins", () => {
    let state = resetConversation(1, identity, "ready");
    state = applyLiveEvent(state, {
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, identity, 1);
    state = applyLiveEvent(state, {
      kind: "conversation.tool.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "Read",
      arguments: { path: "package.json" },
      startedAt: "2026-08-15T00:00:01.000Z",
    }, identity, 2);
    state = applyLiveEvent(state, {
      kind: "conversation.tool.updated",
      sessionId: session,
      turnId: "t1",
      toolCallId: "c1",
      updateMode: "append",
      output: "par",
    }, identity, 3);
    state = applyLiveEvent(state, {
      kind: "conversation.tool.updated",
      sessionId: session,
      turnId: "t1",
      toolCallId: "c1",
      updateMode: "append",
      output: "tial",
    }, identity, 4);
    const before = buildTimeline(state);
    const liveBatch = before.flatMap((row) => (row.type === "assistant" ? row.segments : [])).find((segment) => segment.type === "batch");
    expect(liveBatch?.type === "batch" ? liveBatch.tools : []).toHaveLength(1);
    expect(liveBatch?.type === "batch" ? liveBatch.tools[0]?.output : undefined).toBe("partial");
    state = applyLiveEvent(state, {
      kind: "conversation.tool.completed",
      sessionId: session,
      turnId: "t1",
      toolCallId: "c1",
      result: { type: "toolResult", toolCallId: "c1", toolName: "Read", output: "AUTHORITATIVE", isError: false },
      completedAt: "2026-08-15T00:00:02.000Z",
    }, identity, 5);
    const after = buildTimeline(state).flatMap((row) => (row.type === "assistant" ? row.segments : [])).find((segment) => segment.type === "batch");
    expect(after?.type === "batch" ? after.tools : []).toHaveLength(1);
    expect(after?.type === "batch" ? after.tools[0]?.output : undefined).toBe("AUTHORITATIVE");
    expect(after?.type === "batch" ? after.tools[0]?.status : undefined).toBe("succeeded");
  });

  it("attaches a completed tool to its persisted owner when start was missed", () => {
    let state = resetConversation(1, identity, "ready");
    state = {
      ...state,
      items: [
        {
          kind: "message",
          itemId: "m1",
          parentId: null,
          createdAt: "2026-08-15T00:00:00.000Z",
          role: "assistant",
          content: [{ type: "toolCall", toolCallId: "c1", toolName: "Bash" }],
        },
      ],
    };
    state = applyLiveEvent(
      state,
      {
        kind: "conversation.tool.completed",
        sessionId: session,
        turnId: "t1",
        toolCallId: "c1",
        result: { type: "toolResult", toolCallId: "c1", toolName: "Bash", output: "ok", isError: false },
        completedAt: "2026-08-15T00:00:02.000Z",
      },
      identity,
      1,
    );
    expect(state.liveTools.c1?.messageId).toBe("m1");
    const batch = buildTimeline(state)
      .flatMap((row) => (row.type === "assistant" ? row.segments : []))
      .find((segment) => segment.type === "batch");
    expect(batch?.type === "batch" ? batch.tools[0]?.status : undefined).toBe("succeeded");
    expect(batch?.type === "batch" ? batch.tools[0]?.output : undefined).toBe("ok");
  });

  it("ignores a completed item whose itemId does not equal messageId", () => {
    let state = resetConversation(1, identity, "ready");
    state = applyLiveEvent(state, {
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, identity);
    state = applyLiveEvent(state, {
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      item: assistantItem("other", "nope"),
    }, identity);
    expect(state.items).toEqual([]);
    expect(state.liveMessages.m1).toBeDefined();
  });

  it("real engine projects client live state without a second local merge", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [] }));
    await tick();
    client.pushLive({
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, 1);
    client.pushLive({
      kind: "conversation.tool.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "Read",
      arguments: { path: "a.ts" },
      startedAt: "2026-08-15T00:00:00.100Z",
    }, 2);
    client.pushLive({
      kind: "conversation.tool.completed",
      sessionId: session,
      turnId: "t1",
      toolCallId: "c1",
      completedAt: "2026-08-15T00:00:00.200Z",
      result: {
        type: "toolResult",
        toolCallId: "c1",
        toolName: "Read",
        isError: false,
        data: { totalLines: 7 },
      },
    }, 3);
    const rows = engine.getSnapshot().rows.filter((row) => row.type === "assistant");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "m1", status: "streaming", presentation: "process" });
    const batch = rows[0]?.type === "assistant"
      ? rows[0].segments.find((segment) => segment.type === "batch")
      : undefined;
    expect(batch?.type === "batch" ? batch.tools[0]?.result?.data : undefined).toEqual({ totalLines: 7 });
    expect(client.reads).toHaveLength(1);
  });

  it("keeps persisted-then-started tools pending in the real event order", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [] }));
    await tick();
    const toolsOf = () => {
      const row = engine.getSnapshot().rows.find((entry) => entry.type === "assistant");
      const batch = row?.type === "assistant" ? row.segments.find((segment) => segment.type === "batch") : undefined;
      return batch?.type === "batch" ? batch.tools : [];
    };
    const rowStatus = () => {
      const row = engine.getSnapshot().rows.find((entry) => entry.type === "assistant");
      return row?.type === "assistant" ? row.status : undefined;
    };
    client.pushLive({
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, 1);
    // The agent loop ends the message before it starts the first tool, so the
    // item is persisted with tool calls that have neither start nor result yet.
    client.pushLive({
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      item: {
        kind: "message",
        itemId: "m1",
        parentId: null,
        createdAt: "2026-08-15T00:00:00.000Z",
        role: "assistant",
        content: [
          { type: "text", text: "read both files" },
          { type: "toolCall", toolCallId: "c1", toolName: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", toolCallId: "c2", toolName: "read", arguments: { path: "b.ts" } },
        ],
      },
    }, 2);
    expect(toolsOf().map((tool) => tool.status)).toEqual(["queued", "queued"]);
    expect(rowStatus()).toBe("streaming");

    client.pushLive({
      kind: "conversation.tool.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      toolCallId: "c1",
      toolName: "read",
      arguments: { path: "a.ts" },
      startedAt: "2026-08-15T00:00:00.100Z",
    }, 3);
    expect(toolsOf().map((tool) => tool.status)).toEqual(["running", "queued"]);
    expect(rowStatus()).toBe("streaming");

    for (const [seq, toolCallId] of [[4, "c1"], [5, "c2"]] as const) {
      client.pushLive({
        kind: "conversation.tool.completed",
        sessionId: session,
        turnId: "t1",
        toolCallId,
        completedAt: "2026-08-15T00:00:00.300Z",
        result: { type: "toolResult", toolCallId, toolName: "read", isError: false, data: { totalLines: 3 } },
      }, seq);
    }
    client.pushLive({ kind: "conversation.turn.completed", sessionId: session, turnId: "t1" }, 6);
    expect(toolsOf().map((tool) => tool.status)).toEqual(["succeeded", "succeeded"]);
    expect(rowStatus()).toBe("completed");
  });

  it("marks a resultless tool missing once its turn is closed", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [] }));
    await tick();
    client.pushLive({
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      item: {
        kind: "message",
        itemId: "m1",
        parentId: null,
        createdAt: "2026-08-15T00:00:00.000Z",
        role: "assistant",
        content: [{ type: "toolCall", toolCallId: "c1", toolName: "bash", arguments: { cmd: "ls" } }],
      },
    }, 1);
    client.pushLive({ kind: "conversation.turn.completed", sessionId: session, turnId: "t1" }, 2);
    const row = engine.getSnapshot().rows.find((entry) => entry.type === "assistant");
    const batch = row?.type === "assistant" ? row.segments.find((segment) => segment.type === "batch") : undefined;
    expect(batch?.type === "batch" ? batch.tools[0]?.status : undefined).toBe("missing");
    expect(row?.type === "assistant" ? row.status : undefined).toBe("completed");
  });

  it("real path abort keeps the same message text and marks it aborted", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [] }));
    await tick();
    client.pushLive({
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, 1);
    client.pushLive({
      kind: "conversation.message.delta",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      blockId: "b1",
      blockType: "text",
      delta: "partial",
    }, 2);
    client.pushLive({
      kind: "conversation.turn.aborted",
      sessionId: session,
      turnId: "t1",
    }, 3);
    const rows = engine.getSnapshot().rows.filter((row) => row.type === "assistant");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "m1", status: "aborted" });
    if (rows[0]?.type === "assistant") {
      expect(rows[0].segments.some((segment) => segment.type === "text" && segment.text === "partial")).toBe(true);
    }
    expect(client.conversation.liveMessages.m1?.aborted).toBe(true);
    expect(client.conversation.liveMessages.m1?.blocks.b1?.text).toBe("partial");
    expect(client.reads).toHaveLength(1);
    render(<ConversationItemView row={rows[0]!} />);
    expect(screen.getByText("已中止")).toBeTruthy();
    expect(screen.getByText("partial")).toBeTruthy();
  });

  it("real path abort marks a hard-killed running tool as aborted instead of running forever", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [] }));
    await tick();
    client.pushLive({
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, 1);
    client.pushLive({
      kind: "conversation.tool.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      toolCallId: "call-1",
      toolName: "bash",
      startedAt: "2026-08-15T00:00:01.000Z",
    }, 2);
    // No tool.completed ever arrives: the runtime was hard-killed mid-tool.
    client.pushLive({
      kind: "conversation.turn.aborted",
      sessionId: session,
      turnId: "t1",
    }, 3);
    const rows = engine.getSnapshot().rows.filter((row) => row.type === "assistant");
    expect(rows).toHaveLength(1);
    const batch = rows[0]?.type === "assistant"
      ? rows[0].segments.find((segment) => segment.type === "batch")
      : undefined;
    expect(batch?.type === "batch" ? batch.tools[0]?.status : undefined).toBe("aborted");
    expect(rows[0]?.type === "assistant" ? rows[0].status : undefined).toBe("aborted");
  });

  it("client live message aborted:true projects to an aborted view and DOM chip", () => {
    const views = selectConversationViews({
      ...createInitialConversationState(),
      order: ["m1"],
      liveMessages: {
        m1: {
          messageId: "m1",
          turnId: "t1",
          role: "assistant",
          createdAt: "2026-08-15T00:00:00.000Z",
          blocks: { b1: { blockId: "b1", blockType: "text", text: "partial" } },
          completed: false,
          aborted: true,
        },
      },
    });
    const rows = rowsFromConversationViews(views);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: "m1", status: "aborted" });
    if (rows[0]?.type === "assistant") {
      expect(rows[0].segments.some((segment) => segment.type === "text" && segment.text === "partial")).toBe(true);
    }
    render(<ConversationItemView row={rows[0]!} />);
    expect(screen.getByText("已中止")).toBeTruthy();
    expect(screen.getByText("partial")).toBeTruthy();
  });

  it("provider error on an empty assistant item stays visible with status, provider, model, and message", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [] }));
    await tick();
    const error = {
      message: "Upstream service temporarily unavailable",
      status: 502,
      provider: "sub2api-go",
      model: "mimo-v2.5",
    };
    client.pushLive({
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, 1);
    client.pushLive({
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      item: {
        kind: "message",
        itemId: "m1",
        parentId: null,
        createdAt: "2026-08-15T00:00:00.000Z",
        role: "assistant",
        content: [],
      },
      error,
    }, 2);
    client.pushLive({ kind: "conversation.turn.aborted", sessionId: session, turnId: "t1" }, 3);
    const afterAbort = engine.getSnapshot().rows.filter((row) => row.type === "assistant");
    expect(afterAbort).toHaveLength(1);
    expect(afterAbort[0]).toMatchObject({
      itemId: "m1",
      status: "error",
      presentation: "reply",
      error,
    });
    expect(client.conversation.itemErrors.m1?.status).toBe(502);
    render(<ConversationItemView row={afterAbort[0]!} />);
    expect(screen.getByText("出错")).toBeTruthy();
    expect(screen.getByText("502 · sub2api-go · mimo-v2.5")).toBeTruthy();
    expect(screen.getByText("Upstream service temporarily unavailable")).toBeTruthy();

    const generation = client.beginTranscriptHydrate(identity);
    client.hydrateTranscript(page({ items: [] }), generation);
    const afterLeave = engine.getSnapshot().rows.filter((row) => row.type === "assistant");
    expect(afterLeave).toHaveLength(1);
    expect(afterLeave[0]).toMatchObject({ itemId: "m1", status: "error", error });

    client.pushLive({
      kind: "conversation.message.completed",
      sessionId: session,
      turnId: "t2",
      messageId: "m2",
      item: {
        kind: "message",
        itemId: "m2",
        parentId: null,
        createdAt: "2026-08-15T00:01:00.000Z",
        role: "assistant",
        content: [{ type: "text", text: "recovered" }],
      },
    }, 4);
    const afterSuccess = engine.getSnapshot().rows.filter((row) => row.type === "assistant");
    expect(afterSuccess.some((row) => row.type === "assistant" && row.error !== undefined)).toBe(false);
    expect(client.conversation.itemErrors).toEqual({});
  });
});

describe("pagination and grouping", () => {
  it("prepends an older page without duplicating item ids", () => {
    let state = resetConversation(1, identity, "ready");
    state = hydratePage(state, page({ items: [userItem("u2", "later")], olderCursor: "older-2" as OpaqueCursor, hasMoreBefore: true }), 1, "replace");
    state = hydratePage(
      state,
      page({
        items: [userItem("u1", "earlier"), userItem("u2", "later")],
        olderCursor: "older-3" as OpaqueCursor,
        hasMoreBefore: false,
      }),
      1,
      "prepend",
    );
    expect(state.items.map((item) => item.itemId)).toEqual(["u1", "u2"]);
    expect(state.hasMoreBefore).toBe(false);
  });

  it("groups consecutive tool calls in one assistant message into a batch", () => {
    const segments = segmentsFromContent(
      [
        { type: "thinking", text: "plan" },
        { type: "toolCall", toolCallId: "c1", toolName: "Read", arguments: { path: "a.ts" } },
        { type: "toolResult", toolCallId: "c1", toolName: "Read", output: "a", isError: false },
        { type: "toolCall", toolCallId: "c2", toolName: "Read", arguments: { path: "b.ts" } },
        { type: "toolResult", toolCallId: "c2", toolName: "Read", output: "b", isError: false },
        { type: "text", text: "done" },
      ],
      {},
    );
    expect(segments.map((segment) => segment.type)).toEqual(["thinking", "batch", "text"]);
    expect(segments[1]?.type === "batch" ? segments[1].tools.map((tool) => tool.toolCallId) : []).toEqual(["c1", "c2"]);
  });

  it("merges consecutive process messages and shows one OMP header only on the final reply", () => {
    const processOne: ConversationItem = {
      ...assistantItem("process-1", ""),
      content: [
        { type: "toolCall", toolCallId: "read-1", toolName: "Read", arguments: { path: "a.ts" } },
        { type: "toolResult", toolCallId: "read-1", toolName: "Read", output: "a", isError: false },
      ],
    };
    const processTwo: ConversationItem = {
      ...assistantItem("process-2", ""),
      content: [
        { type: "toolCall", toolCallId: "read-2", toolName: "Read", arguments: { path: "b.ts" } },
        { type: "toolResult", toolCallId: "read-2", toolName: "Read", output: "b", isError: false },
      ],
    };
    const progress = assistantItem("progress", "我先检查一下。");
    const finalReply = assistantItem("final", "检查完成，这是最终结论。");
    const items = [userItem("u1", "检查"), progress, processOne, processTwo, finalReply];
    const itemsById = Object.fromEntries(items.map((item) => [item.itemId, item]));
    const rows = rowsFromConversationViews(selectConversationViews({
      ...createInitialConversationState(),
      order: items.map((item) => item.itemId),
      itemsById,
    }));

    const assistants = rows.filter((row) => row.type === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants.map((row) => row.type === "assistant" ? row.presentation : undefined)).toEqual([
      "process",
      "process",
      "reply",
    ]);
    const process = assistants[1];
    const batches = process?.type === "assistant"
      ? process.segments.filter((segment) => segment.type === "batch")
      : [];
    expect(batches).toHaveLength(1);
    expect(batches[0]?.type === "batch" ? batches[0].tools.map((tool) => tool.toolCallId) : []).toEqual([
      "read-1",
      "read-2",
    ]);

    const { container } = render(<ConvoTranscript rows={rows} />);
    expect(container.querySelectorAll(".ev-head .role-badge.a")).toHaveLength(1);
    expect(container.querySelectorAll(".ev-process .ev-batch")).toHaveLength(1);
    expect(screen.getByText("检查完成，这是最终结论。")).toBeTruthy();
  });

  it("keeps the identity header on the last text-bearing row when later items are tools only", () => {
    const reply = assistantItem("reply", "先改这一处。");
    const tools: ConversationItem = {
      ...assistantItem("tools", ""),
      content: [
        { type: "toolCall", toolCallId: "bash-1", toolName: "Bash", arguments: { command: "npm test" } },
        { type: "toolResult", toolCallId: "bash-1", toolName: "Bash", output: "ok", isError: false },
      ],
    };
    const items = [userItem("u1", "改一下"), reply, tools];
    const itemsById = Object.fromEntries(items.map((item) => [item.itemId, item]));
    const rows = rowsFromConversationViews(selectConversationViews({
      ...createInitialConversationState(),
      order: items.map((item) => item.itemId),
      itemsById,
    }));
    const assistants = rows.filter((row) => row.type === "assistant");
    expect(assistants.map((row) => (row.type === "assistant" ? row.presentation : undefined))).toEqual([
      "reply",
      "process",
    ]);
  });

  it("ignores dot fillers and keeps following tools in the preceding mixed process chain", () => {
    const command: ConversationItem = {
      ...assistantItem("command", ""),
      content: [
        { type: "text", text: "明白了，我先修改并检查。" },
        { type: "toolCall", toolCallId: "bash-1", toolName: "Bash", arguments: { command: "npm test" } },
        { type: "toolResult", toolCallId: "bash-1", toolName: "Bash", output: "ok", isError: false },
      ],
    };
    const edit: ConversationItem = {
      ...assistantItem("edit", ""),
      content: [
        { type: "text", text: "." },
        { type: "toolCall", toolCallId: "edit-1", toolName: "Edit", arguments: { path: "tokens.css" } },
        { type: "toolResult", toolCallId: "edit-1", toolName: "Edit", output: "done", isError: false },
      ],
    };
    const read: ConversationItem = {
      ...assistantItem("read", ""),
      content: [
        { type: "text", text: "\n\n" },
        { type: "toolCall", toolCallId: "read-1", toolName: "Read", arguments: { path: "index.html" } },
        { type: "toolResult", toolCallId: "read-1", toolName: "Read", output: "body", isError: false },
      ],
    };
    const finalReply = assistantItem("final-after-tools", "修改完成。");
    const items = [userItem("u-tool-chain", "调整颜色"), command, edit, read, finalReply];
    const rows = rowsFromConversationViews(selectConversationViews({
      ...createInitialConversationState(),
      order: items.map((item) => item.itemId),
      itemsById: Object.fromEntries(items.map((item) => [item.itemId, item])),
    }));

    const assistants = rows.filter((row) => row.type === "assistant");
    expect(assistants).toHaveLength(2);
    const process = assistants[0];
    expect(process?.type === "assistant"
      ? process.segments.filter((segment) => segment.type === "text").map((segment) => segment.text)
      : []).toEqual(["明白了，我先修改并检查。"]);
    expect(process?.type === "assistant"
      ? process.segments.flatMap((segment) => segment.type === "batch" ? segment.tools.map((tool) => tool.toolCallId) : [])
      : []).toEqual(["bash-1", "edit-1", "read-1"]);

    const { container } = render(<ConvoTranscript rows={rows} />);
    expect(container.querySelectorAll(".ev-process .ev-batch")).toHaveLength(1);
    expect(container.textContent).not.toContain("\n.\n");
    expect(screen.getByText("修改完成。")).toBeTruthy();
  });

  it("does not render empty persisted assistants or spin for a missing historical result", () => {
    const items: ConversationItem[] = [
      {
        ...assistantItem("tool-owner", ""),
        content: [{ type: "toolCall", toolCallId: "missing-result", toolName: "Read", arguments: { path: "a.ts" } }],
      },
      {
        ...assistantItem("empty-assistant", ""),
        content: [],
      },
    ];
    const rows = buildTimeline({
      ...emptyConversationState(1),
      identity,
      items,
      hydrateStatus: "ready",
    });
    const assistants = rows.filter((row) => row.type === "assistant");
    expect(assistants).toHaveLength(1);
    if (assistants[0]?.type === "assistant") {
      const batch = assistants[0].segments.find((segment) => segment.type === "batch");
      expect(batch?.type === "batch" ? batch.tools[0]?.status : undefined).toBe("missing");
    }
  });
});

describe("scroll follow", () => {
  it("follows near the bottom and stops after scrolling up", () => {
    expect(shouldFollow(distanceFromBottom({ scrollHeight: 1000, scrollTop: 940, clientHeight: 80 }))).toBe(true);
    expect(shouldFollow(distanceFromBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 80 }))).toBe(false);
  });

  it("follow key changes when live bash output grows without a new row", () => {
    const before = conversationFollowKey({
      liveTools: { b1: { output: "a" } },
      liveMessages: {},
    });
    const after = conversationFollowKey({
      liveTools: { b1: { output: "abc" } },
      liveMessages: {},
    });
    expect(before).not.toBe(after);
  });
});

describe("composer pending semantics", () => {
  it("keeps pending as pending after local accept and restores draft on terminal failure", () => {
    let state = emptyConversationState(1);
    state = trackPending(state, {
      requestId: "req-1",
      text: "hello",
      draft: "hello",
      status: "pending",
      knownItemIds: [],
    });
    const pendingRow = buildTimeline(state).find((row) => row.type === "user");
    expect(pendingRow).toMatchObject({ pending: "pending", text: "hello" });
    state = failPending(state, "req-1", "rejected by runtime");
    const failed = buildTimeline(state).find((row) => row.type === "user");
    expect(failed).toMatchObject({ pending: "failed", error: "rejected by runtime" });
    expect(state.pendingUsers[0]?.draft).toBe("hello");
  });

  it("reconciles pending when a new matching user item arrives", () => {
    let state = resetConversation(1, identity, "ready");
    state = trackPending(state, {
      requestId: "req-1",
      text: "hello",
      draft: "hello",
      status: "pending",
      knownItemIds: [],
    });
    state = hydratePage(state, page({ items: [userItem("u1", "hello")], hasMoreBefore: false }), 1, "replace");
    expect(state.pendingUsers).toEqual([]);
    expect(buildTimeline(state).filter((row) => row.type === "user")).toHaveLength(1);
  });

  it("transfers the composer doc onto the persisted user row so capsules survive send", () => {
    const doc = {
      nodes: [
        { type: "text" as const, value: "看 " },
        {
          type: "chip" as const,
          chip: { id: "c1", kind: "file" as const, label: "app.ts", path: "src/app.ts" },
        },
      ],
    };
    let state = resetConversation(1, identity, "ready");
    state = trackPending(state, {
      requestId: "req-1",
      text: "看 @src/app.ts",
      draft: "看 @src/app.ts",
      status: "pending",
      knownItemIds: [],
      doc,
    });
    expect(buildTimeline(state).find((row) => row.type === "user")).toMatchObject({ doc });
    state = hydratePage(state, page({ items: [userItem("u1", "看 @src/app.ts")], hasMoreBefore: false }), 1, "replace");
    expect(state.pendingUsers).toEqual([]);
    expect(state.userDisplays.u1).toEqual(doc);
    expect(buildTimeline(state).find((row) => row.type === "user")).toMatchObject({
      itemId: "u1",
      text: "看 @src/app.ts",
      doc,
    });
  });

  it("keeps image thumbs on the persisted row after the pending doc is absorbed", () => {
    const png = { type: "image" as const, mimeType: "image/png" as const, data: "aaa" };
    const doc = {
      nodes: [
        { type: "text" as const, value: "看 " },
        {
          type: "chip" as const,
          chip: { id: "c1", kind: "image" as const, label: "图1", image: png },
        },
      ],
    };
    let state = resetConversation(1, identity, "ready");
    state = trackPending(state, {
      requestId: "req-img",
      text: "看 [图1]",
      draft: "看 [图1]",
      status: "pending",
      knownItemIds: [],
      doc,
    });
    state = hydratePage(state, page({ items: [userItem("u-img", "看 [图1]")], hasMoreBefore: false }), 1, "replace");
    expect(state.userThumbs["u-img"]).toEqual([{ label: "图1", image: png }]);
    expect(buildTimeline(state).find((row) => row.type === "user")).toMatchObject({
      itemId: "u-img",
      thumbs: [{ label: "图1", image: png }],
    });
  });

  it("absorbPendingDisplays keeps failed pending and only maps matched items", () => {
    const doc = { nodes: [{ type: "text" as const, value: "hello" }] };
    const absorbed = absorbPendingDisplays(
      [
        {
          requestId: "ok",
          text: "hello",
          draft: "hello",
          status: "pending",
          knownItemIds: [],
          doc,
        },
        {
          requestId: "fail",
          text: "nope",
          draft: "nope",
          status: "failed",
          knownItemIds: [],
        },
      ],
      [userItem("u1", "hello")],
    );
    expect(absorbed.pending).toHaveLength(1);
    expect(absorbed.pending[0]?.requestId).toBe("fail");
    expect(absorbed.displays.u1).toEqual(doc);
  });

  it("persists thumbs locally and reloads them onto a new engine without the composer doc", async () => {
    const png = { type: "image" as const, mimeType: "image/png" as const, data: "aaa" };
    const doc = {
      nodes: [
        { type: "text" as const, value: "看 " },
        {
          type: "chip" as const,
          chip: { id: "c1", kind: "image" as const, label: "图1", image: png },
        },
      ],
    };
    const store = createMemoryThumbStore();
    const client = new FakeClient();
    client.auto = page({ items: [userItem("u-img", "看 [图1]")], hasMoreBefore: false });
    const writer = engineOf(client, { thumbStore: store });
    writer.start();
    writer.trackPending({
      requestId: "req-img",
      text: "看 [图1]",
      draft: "看 [图1]",
      status: "pending",
      knownItemIds: [],
      doc,
    });
    await tick();
    expect(await store.load(session)).toEqual({ "u-img": [{ label: "图1", image: png }] });
    writer.dispose();

    const reader = engineOf(client, { thumbStore: store });
    reader.start();
    await tick();
    const row = reader.getSnapshot().rows.find((entry) => entry.type === "user");
    expect(row).toMatchObject({
      itemId: "u-img",
      text: "看 [图1]",
      thumbs: [{ label: "图1", image: png }],
    });
    reader.dispose();
  });
});

describe("runtime identity and XSS", () => {
  it("does not merge a page from another session", () => {
    let state = resetConversation(1, identity, "ready");
    state = hydratePage(
      state,
      page({ runtimeEpoch: other.runtimeEpoch ?? epoch, sessionId: other.sessionId, items: [userItem("x", "nope")] }),
      1,
      "replace",
    );
    expect(state.items).toEqual([]);
  });

  it("renders host text as text, not HTML", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "evil",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: '<script>alert(1)</script><img src=x onerror="alert(1)">',
        }}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });

  it("does not put a streaming chip on the assistant header", () => {
    render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "live",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "streaming",
          segments: [{ type: "text", key: "t1", text: "正在写", streaming: true }],
        }}
      />,
    );
    expect(screen.queryByText("流式输出中")).toBeNull();
    expect(screen.getByText("正在写")).toBeTruthy();
  });

  it("renders markdown emphasis and lists in assistant text", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{ type: "text", key: "t1", text: "先看 **browser** 协议，再写 `xd://browser`。\n\n- 步骤一\n- 步骤二" }],
        }}
      />,
    );
    expect(container.querySelector("strong")?.textContent).toBe("browser");
    expect(container.querySelector(".chip-code")?.textContent).toBe("xd://browser");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("ul")).toBeTruthy();
  });

  it("renders indented, numbered, and CRLF markdown lists", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-list",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "步骤：\r\n  - 读协议\r\n  - 写实现\r\n\r\n1. 允许一次\r\n2. 取消",
          }],
        }}
      />,
    );
    const items = [...container.querySelectorAll("li")].map((node) => node.textContent);
    expect(items).toEqual(["读协议", "写实现", "允许一次", "取消"]);
    expect(container.querySelector("ul")).toBeTruthy();
    expect(container.querySelector("ol")).toBeTruthy();
  });

  it("renders GFM tables with header and body cells", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-table",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "| 阶段 | 说明 |\n| --- | --- |\n| 构建 | vite build |\n| 测试 | vitest |",
          }],
        }}
      />,
    );
    const heads = [...container.querySelectorAll("thead th")].map((node) => node.textContent);
    expect(heads).toEqual(["阶段", "说明"]);
    const cells = [...container.querySelectorAll("tbody td")].map((node) => node.textContent);
    expect(cells).toEqual(["构建", "vite build", "测试", "vitest"]);
    expect(container.querySelector(".md-table-wrap table")).toBeTruthy();
  });

  it("renders blockquotes, horizontal rules, and strikethrough", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-quote",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "> 引用一段\n\n---\n\n旧方案 ~~已废弃~~。",
          }],
        }}
      />,
    );
    expect(container.querySelector("blockquote")?.textContent).toContain("引用一段");
    expect(container.querySelector("hr")).toBeTruthy();
    expect(container.querySelector("del")?.textContent).toBe("已废弃");
  });

  it("renders task lists and nested lists", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-task",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "- [x] 完成\n- [ ] 待办\n- 外层\n  - 内层",
          }],
        }}
      />,
    );
    const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    const outer = [...container.querySelectorAll("ul.contains-task-list > li")];
    expect(outer).toHaveLength(3);
    const nested = container.querySelectorAll("li ul li");
    expect(nested).toHaveLength(1);
    expect(nested[0]?.textContent).toBe("内层");
  });

  it("renders fenced code with language chip, highlighting, and copy button", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-code",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "```js\nconst answer = 42;\n```",
          }],
        }}
      />,
    );
    expect(container.querySelector(".md-code-lang")?.textContent).toBe("js");
    const code = container.querySelector(".md-code-pre code");
    expect(code?.className).toContain("language-js");
    expect(code?.textContent).toContain("const answer = 42;");
    expect(container.querySelector(".hljs-keyword")).toBeTruthy();
    expect(container.querySelector("button.md-code-copy")).toBeTruthy();
  });

  it("renders unlanguaged fenced code as a plain block, not an inline chip", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-plain-code",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "```\nplain block\n```",
          }],
        }}
      />,
    );
    expect(container.querySelector(".md-code-lang")?.textContent).toBe("text");
    const pre = container.querySelector("pre.md-code-pre");
    expect(pre?.textContent).toContain("plain block");
    expect(pre?.querySelector("code.chip-code")).toBeTruthy();
  });

  it("renders mermaid fences as diagrams once streaming settles", async () => {
    mermaidRenderMock.mockReset();
    mermaidRenderMock.mockResolvedValue({ svg: "<svg>graph</svg>" });
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-mermaid",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            text: "```mermaid\ngraph TD\n  A --> B\n```",
          }],
        }}
      />,
    );
    await waitFor(() => {
      expect(container.querySelector(".mermaid-box svg")).toBeTruthy();
    });
    expect(mermaidRenderMock).toHaveBeenCalledTimes(1);
    expect(mermaidRenderMock.mock.calls[0]?.[1]).toContain("graph TD");
  });

  it("keeps mermaid fences as source text while streaming", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "md-mermaid-stream",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [{
            type: "text",
            key: "t1",
            streaming: true,
            text: "```mermaid\ngraph TD\n  A --> B\n```",
          }],
        }}
      />,
    );
    expect(container.querySelector(".mermaid-box")).toBeNull();
    expect(container.querySelector(".md-code-pre")?.textContent).toContain("graph TD");
  });

  it("pretty-prints JSON write content instead of one raw line", () => {
    const { container } = render(
      <ToolBody
        tool={{
          toolCallId: "w1",
          toolName: "Write",
          status: "succeeded",
          arguments: { path: "xd://browser", content: '{"action":"run","name":"main"}' },
        }}
      />,
    );
    const lines = [...container.querySelectorAll(".tc-code .lx")].map((node) => node.textContent);
    expect(lines.some((line) => line?.includes('"action": "run"'))).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
  });

  it("renders structured transcript details for Read and Edit results", () => {
    const { container } = render(
      <>
        <ToolBody
          tool={{
            toolCallId: "read-details",
            toolName: "Read",
            status: "succeeded",
            arguments: { path: "a.ts" },
            result: {
              type: "toolResult",
              toolCallId: "read-details",
              toolName: "Read",
              output: "fallback",
              data: { totalLines: 2, displayContent: { text: "one\ntwo" } },
              isError: false,
            },
          }}
        />
        <ToolBody
          tool={{
            toolCallId: "edit-details",
            toolName: "Edit",
            status: "succeeded",
            result: {
              type: "toolResult",
              toolCallId: "edit-details",
              toolName: "Edit",
              data: { diff: "-old\n+new" },
              isError: false,
            },
          }}
        />
      </>,
    );
    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("-old");
    expect(container.textContent).toContain("+new");
  });

  it("preview transcript shows the demo marker", () => {
    render(<ConvoTranscript rows={buildTimeline({ ...emptyConversationState(1), items: PREVIEW_CONVO_ITEMS, hydrateStatus: "ready", identity: PREVIEW_CONVO_IDENTITY })} demo />);
    expect(screen.getAllByText("演示").length).toBeGreaterThan(0);
  });

  it("preview gallery expands every native tool-card body", () => {
    render(
      <ConvoTranscript
        rows={buildTimeline({
          ...emptyConversationState(1),
          items: previewGalleryItems(),
          hydrateStatus: "ready",
          identity: PREVIEW_CONVO_IDENTITY,
        })}
        demo
      />,
    );
    const kinds = [...document.querySelectorAll(".tl-item[data-kind]")].map((node) => node.getAttribute("data-kind"));
    expect(kinds).toEqual(expect.arrayContaining([
      "think", "read", "write", "edit", "bash", "grep", "glob", "ast_grep", "ast_edit", "ask",
      "debug", "eval", "github", "lsp", "inspect_image", "browser", "computer", "checkpoint",
      "rewind", "security_scan", "task", "hub", "todo", "web_search", "retain", "recall",
      "reflect", "memory_edit", "learn", "manage_skill", "yield", "goal", "generate_image",
      "tts", "vibe", "mcp", "resolve",
    ]));
    expect(document.querySelectorAll(".tl-item.open")).toHaveLength(kinds.length);
    expect(document.querySelector(".ev-batch.open")).not.toBeNull();
    expect(document.querySelector(".tc-diff")).not.toBeNull();
    expect(document.querySelector(".tc-ask")).not.toBeNull();
    expect(document.querySelector(".tc-todo")).not.toBeNull();
    expect(document.querySelector(".tc-lsp")).not.toBeNull();
    expect(document.querySelector(".tc-vibe")).not.toBeNull();
    expect(document.querySelector(".tc-resolve")).not.toBeNull();
    expect(document.querySelector(".subagent-strip .sa-card.running")).not.toBeNull();
    expect(document.querySelector(".subagent-strip .sa-top .sa-name")).not.toBeNull();
    expect(document.querySelector(".subagent-strip .sa-top .sa-tok")).toBeNull();
    expect(document.querySelector(".subagent-strip .sa-card > .sa-metrics .sa-tok")).not.toBeNull();
  });
});

describe("message copy", () => {
  function mockClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    return writeText;
  }

  it("copies the user message source text and shows 已复制", async () => {
    const writeText = mockClipboard();
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-copy",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "打开 @src/app.ts",
        }}
      />,
    );
    const button = screen.getByRole("button", { name: "复制消息" });
    expect(button.textContent).toBe("");
    expect(container.querySelector(".ev-copy-host .ev-body")).toBeTruthy();
    expect(container.querySelector(".cm-chip-file .cm-chip-clip")?.textContent).toBe("app.ts");
    expect(container.querySelector(".ev-body")?.textContent).not.toContain("@src/app.ts");
    fireEvent.click(button);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("打开 @src/app.ts");
    });
    expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
  });

  it("keeps skill capsules in the bubble and copies the /skill: token", async () => {
    const writeText = mockClipboard();
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-skill",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "请用 /skill:commit-msg 写说明",
        }}
      />,
    );
    expect(container.querySelector(".cm-chip-skill .cm-chip-clip")?.textContent).toBe("commit-msg");
    expect(container.querySelector(".ev-body")?.textContent).not.toContain("/skill:commit-msg");
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("请用 /skill:commit-msg 写说明");
    });
  });

  it("attaches clipboard images above the bubble and opens the preview", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-img",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "看 [图1]",
          doc: {
            nodes: [
              { type: "text", value: "看 " },
              {
                type: "chip",
                chip: {
                  id: "img-1",
                  kind: "image",
                  label: "图1",
                  image: { type: "image", mimeType: "image/png", data: png },
                },
              },
            ],
          },
        }}
      />,
    );
    expect(container.querySelector(".ev-thumbs img")).toBeTruthy();
    expect(container.querySelector(".cm-chip-image .cm-chip-clip")?.textContent).toBe("图1");
    fireEvent.click(screen.getByRole("button", { name: "预览图1" }));
    expect(screen.getByRole("dialog", { name: "预览图1" })).toBeTruthy();
  });

  it("rebuilds thumbnails from persisted thumbs after the composer doc is gone", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-reload",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "看 [图1]",
          thumbs: [{ label: "图1", image: { type: "image", mimeType: "image/png", data: png } }],
        }}
      />,
    );
    expect(container.querySelector(".ev-thumbs img")).toBeTruthy();
    expect(container.querySelector(".cm-chip-image .cm-chip-clip")?.textContent).toBe("图1");
  });

  it("native copy of a capsule selection writes the serialized token", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-native-copy",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "打开 @src/app.ts",
        }}
      />,
    );
    const body = container.querySelector(".ev-user-rich");
    expect(body).toBeInstanceOf(HTMLElement);
    const range = document.createRange();
    range.selectNodeContents(body as HTMLElement);
    expect(serializedCopyFromHost(body as HTMLElement, range)).toBe("打开 @src/app.ts");
  });

  it("copies only the last assistant text body", async () => {
    const writeText = mockClipboard();
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "a-copy",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [
            { type: "thinking", key: "th1", text: "先想一步" },
            {
              type: "batch",
              key: "b1",
              tools: [{ toolCallId: "c1", toolName: "Read", status: "succeeded", arguments: { path: "a.ts" } }],
            },
            { type: "text", key: "t1", text: "第一段" },
            { type: "text", key: "t2", text: "第二段" },
          ],
        }}
      />,
    );
    const hosts = container.querySelectorAll(".ev-copy-host");
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.querySelector(".ev-body")?.textContent).toContain("第二段");
    expect(hosts[0]?.querySelector(".ev-body")?.textContent).not.toContain("第一段");
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("第二段");
    });
  });

  it("hides copy on process rows without text", () => {
    render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "a-tools",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          presentation: "process",
          segments: [{
            type: "batch",
            key: "b1",
            tools: [{ toolCallId: "c1", toolName: "Read", status: "succeeded", arguments: { path: "a.ts" } }],
          }],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "复制消息" })).toBeNull();
  });

  it("hides copy on interstitial text between tool chains", () => {
    render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "a-mid",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          presentation: "process",
          segments: [
            {
              type: "batch",
              key: "b1",
              tools: [{ toolCallId: "c1", toolName: "Read", status: "succeeded", arguments: { path: "a.ts" } }],
            },
            { type: "text", key: "t-mid", text: "再试一次别的路径。" },
            {
              type: "batch",
              key: "b2",
              tools: [{ toolCallId: "c2", toolName: "Edit", status: "succeeded", arguments: { path: "a.ts" } }],
            },
          ],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "复制消息" })).toBeNull();
  });

  it("hides copy when the last text is still followed by tools", () => {
    render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "a-then-tools",
          createdAt: "2026-08-15T00:00:00.000Z",
          status: "completed",
          segments: [
            { type: "text", key: "t1", text: "我先去改文件。" },
            {
              type: "batch",
              key: "b1",
              tools: [{ toolCallId: "c1", toolName: "Edit", status: "succeeded", arguments: { path: "a.ts" } }],
            },
          ],
        }}
      />,
    );
    expect(screen.queryByRole("button", { name: "复制消息" })).toBeNull();
  });
});

describe("gap resync signal", () => {
  it("keeps later conversation events when eventSeq skips non-conversation traffic", () => {
    let state = resetConversation(1, identity, "ready");
    state = applyLiveEvent(state, {
      kind: "conversation.message.started",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      role: "assistant",
      createdAt: "2026-08-15T00:00:00.000Z",
    }, identity, 1);
    state = applyLiveEvent(state, {
      kind: "conversation.message.delta",
      sessionId: session,
      turnId: "t1",
      messageId: "m1",
      blockId: "b1",
      blockType: "text",
      delta: "x",
    }, identity, 4);
    expect(state.resyncRequired).toBe(false);
    expect(state.liveMessages.m1?.blocks.find((block) => block.blockId === "b1")?.text).toBe("x");
  });

  it("resync.required re-hydrates the latest page and does not guess deltas", async () => {
    const client = new FakeClient();
    const engine = engineOf(client);
    engine.start();
    client.resolveNext(page({ items: [userItem("u1", "hello")] }));
    await tick();
    expect(client.begins).toBe(1);
    client.emit({
      ...envelope(),
      kind: "resync.required",
      reason: "gap",
    });
    client.emit({
      ...envelope(),
      kind: "resync.required",
      reason: "duplicate-gap-signal",
    });
    await tick();
    expect(client.begins).toBe(2);
    expect(client.reads).toHaveLength(2);
    client.resolveNext(page({ items: [userItem("u1", "hello"), userItem("u2", "next")] }));
    await tick();
    expect(engine.getSnapshot().state.items.map((item) => item.itemId)).toEqual(["u1", "u2"]);
    expect(client.hydrateCalls.every((entry) => entry.mode === "hydrate")).toBe(true);
  });
});

describe("truncated display", () => {
  it("shows a visible 已截断 mark for a truncated tool result", () => {
    render(
      <ToolBody
        tool={{
          toolCallId: "c-trunc",
          toolName: "Bash",
          status: "succeeded",
          output: "stdout truncated for display",
          truncated: true,
          result: {
            type: "toolResult",
            toolCallId: "c-trunc",
            toolName: "Bash",
            output: "stdout truncated for display",
            isError: false,
            truncated: true,
          },
        }}
      />,
    );
    expect(screen.getByRole("note", { name: "已截断" })).toBeTruthy();
    expect(screen.getByText("stdout truncated for display")).toBeTruthy();
  });

  it("does not show 已截断 when the tool result is complete", () => {
    render(
      <ToolBody
        tool={{
          toolCallId: "c-full",
          toolName: "Bash",
          status: "succeeded",
          output: "ok",
        }}
      />,
    );
    expect(screen.queryByText("已截断")).toBeNull();
  });

  it("renders the truncated mark from a hydrated tool-result fixture", () => {
    let state = resetConversation(1, identity, "ready");
    state = hydratePage(
      state,
      page({
        items: [{
          kind: "message",
          itemId: "m-trunc",
          parentId: null,
          createdAt: "2026-08-15T00:00:02.000Z",
          role: "assistant",
          content: [
            { type: "toolCall", toolCallId: "c-trunc", toolName: "Bash", arguments: { command: "ls" } },
            {
              type: "toolResult",
              toolCallId: "c-trunc",
              toolName: "Bash",
              output: "stdout truncated for display",
              isError: false,
              truncated: true,
            },
          ],
        }],
      }),
      1,
      "replace",
    );
    const row = buildTimeline(state).find((entry) => entry.type === "assistant");
    expect(row?.type).toBe("assistant");
    render(<ConversationItemView row={row!} />);
    fireEvent.click(screen.getByRole("button", { name: /Bash/ }));
    expect(screen.getByRole("note", { name: "已截断" })).toBeTruthy();
  });

  it("shows 已截断 on truncated text and thinking blocks", () => {
    const { rerender } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "m-text",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          segments: [{ type: "text", key: "t1", text: "hello", truncated: true }],
        }}
      />,
    );
    expect(screen.getByRole("note", { name: "已截断" })).toBeTruthy();
    rerender(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "m-think",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          segments: [{ type: "thinking", key: "th1", text: "plan", truncated: true }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Think/ }));
    expect(screen.getByRole("note", { name: "已截断" })).toBeTruthy();
  });
});

describe("ver1 batch chain", () => {
  it("renders a collapsed batch summary instead of a grouped tool card", () => {
    render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "m-batch",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          segments: [{
            type: "batch",
            key: "b1",
            tools: [
              { toolCallId: "c1", toolName: "Read", status: "succeeded", arguments: { path: "a.ts" } },
              { toolCallId: "c2", toolName: "Read", status: "succeeded", arguments: { path: "b.ts" } },
            ],
          }],
        }}
      />,
    );
    expect(document.querySelector(".tool-group")).toBeNull();
    expect(document.querySelector(".ev-batch")).not.toBeNull();
    expect(screen.getByText("阅读 2 个文件")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /阅读 2 个文件/ }));
    expect(screen.getByRole("button", { name: /Read · a\.ts/ })).toBeTruthy();
  });

  it("keeps tool then thinking segments inside one visual chain", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "m-reverse-chain",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          presentation: "process",
          segments: [
            {
              type: "batch",
              key: "tools-first",
              tools: [
                { toolCallId: "edit-1", toolName: "Edit", status: "succeeded", arguments: { path: "mcp_node_repl.js" } },
                { toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "mcp_node_repl.js" } },
              ],
            },
            { type: "thinking", key: "thinking-after", text: "Still empty. The tool returns empty output." },
          ],
        }}
      />,
    );
    expect(container.querySelectorAll(".ev-batch")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /编辑 mcp_node_repl\.js/ }));
    expect(screen.getByRole("button", { name: /Still empty/ })).toBeTruthy();
  });

  it("merges repeated thinking segments into one thinking tool", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "m-merged-thinking",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          presentation: "process",
          segments: [
            { type: "thinking", key: "thinking-1", text: "First diagnostic step." },
            { type: "thinking", key: "thinking-2", text: "Second diagnostic step.", truncated: true },
            {
              type: "batch",
              key: "tools-after-thinking",
              tools: [{ toolCallId: "bash-after-thinking", toolName: "Bash", status: "succeeded" }],
            },
          ],
        }}
      />,
    );

    fireEvent.click(container.querySelector(".batch-sum") as HTMLButtonElement);
    expect(container.querySelectorAll('[data-kind="think"]')).toHaveLength(1);
    const thinkButton = screen.getByRole("button", { name: /First diagnostic step/ });
    fireEvent.click(thinkButton);
    expect(container.querySelector(".think-scroll")?.textContent).toContain("First diagnostic step.");
    expect(container.querySelector(".think-scroll")?.textContent).toContain("Second diagnostic step.");
    expect(container.querySelector('[data-kind="think"]')?.getAttribute("data-item-key")).toBe("thinking-1");
  });
});

describe("tool chain keeps the produced order", () => {
  it("keeps reasoning emitted after a tool result behind that tool when process items merge", () => {
    const step: Extract<ConversationItem, { kind: "message" }> = {
      ...assistantItem("step", ""),
      content: [
        { type: "thinking", text: "先读一下这个文件。" },
        { type: "toolCall", toolCallId: "read-1", toolName: "Read", arguments: { path: "a.ts" } },
        { type: "toolResult", toolCallId: "read-1", toolName: "Read", output: "", isError: false },
      ],
    };
    const after: Extract<ConversationItem, { kind: "message" }> = {
      ...assistantItem("after", ""),
      content: [
        { type: "thinking", text: "文件是空的，改用 Grep。" },
        { type: "toolCall", toolCallId: "grep-1", toolName: "Grep", arguments: { pattern: "needle" } },
        { type: "toolResult", toolCallId: "grep-1", toolName: "Grep", output: "hit", isError: false },
      ],
    };
    const items = [userItem("u-order", "查一下"), step, after, assistantItem("final-order", "查到了。")];
    const rows = rowsFromConversationViews(selectConversationViews({
      ...createInitialConversationState(),
      order: items.map((item) => item.itemId),
      itemsById: Object.fromEntries(items.map((item) => [item.itemId, item])),
    }));

    const process = rows.find((row) => row.type === "assistant" && row.presentation === "process");
    const shape = process?.type === "assistant"
      ? process.segments.map((segment) =>
          segment.type === "batch"
            ? `batch:${segment.tools.map((tool) => tool.toolCallId).join(",")}`
            : `${segment.type}:${segment.text}`,
        )
      : [];
    expect(shape).toEqual([
      "thinking:先读一下这个文件。",
      "batch:read-1",
      "thinking:文件是空的，改用 Grep。",
      "batch:grep-1",
    ]);
  });

  it("renders post-tool reasoning as its own card after the tool row", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "m-chain-order",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          presentation: "process",
          segments: [
            { type: "thinking", key: "think-before", text: "Plan: read the file." },
            {
              type: "batch",
              key: "batch-1",
              tools: [{ toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "a.ts" } }],
            },
            { type: "thinking", key: "think-after", text: "The file was empty." },
          ],
        }}
      />,
    );

    expect([...container.querySelectorAll(".tl-item")].map((node) => node.getAttribute("data-kind"))).toEqual([
      "think",
      "read",
      "think",
    ]);
    const cards = [...container.querySelectorAll('[data-kind="think"] .think-scroll')].map((node) => node.textContent ?? "");
    expect(cards[0]).toContain("Plan: read the file.");
    expect(cards[0]).not.toContain("The file was empty.");
    expect(cards[1]).toContain("The file was empty.");
  });

  it("keeps a manually collapsed chain collapsed across the live-to-persisted swap", () => {
    const liveRow = {
      type: "assistant" as const,
      itemId: "m-live-swap",
      createdAt: "2026-08-15T00:00:02.000Z",
      status: "streaming" as const,
      presentation: "reply" as const,
      segments: [
        { type: "thinking" as const, key: "m1:thinking:0", text: "Planning." },
        { type: "text" as const, key: "m1:text:1", text: "先看两个文件。", streaming: true },
        {
          type: "batch" as const,
          key: "live-tools-m1",
          tools: [
            { toolCallId: "read-1", toolName: "Read", status: "running" as const, arguments: { path: "a.ts" } },
            { toolCallId: "read-2", toolName: "Read", status: "queued" as const, arguments: { path: "b.ts" } },
          ],
        },
      ],
    };
    const { container, rerender } = render(<ConversationItemView row={liveRow} />);
    fireEvent.click(container.querySelector(".batch-sum") as HTMLButtonElement);
    expect(container.querySelector(".ev-batch.open")).toBeNull();

    // message.completed 落盘：segment key 从 blockId 换成序号 key，同一时刻这一行也从
    // reply 降级成 process（身份头交给新的 assistant item）。两者都不该重挂载工具链。
    rerender(
      <ConversationItemView
        row={{
          ...liveRow,
          presentation: "process",
          segments: [
            { type: "thinking", key: "thinking-0", text: "Planning." },
            { type: "text", key: "text-1", text: "先看两个文件。" },
            {
              type: "batch",
              key: "batch-2",
              tools: [
                { toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "a.ts" } },
                { toolCallId: "read-2", toolName: "Read", status: "running", arguments: { path: "b.ts" } },
              ],
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".ev-batch.open")).toBeNull();
  });
});

describe("streaming chain auto expand and fold", () => {
  const baseRow = {
    type: "assistant" as const,
    itemId: "m-live-chain",
    createdAt: "2026-08-15T00:00:02.000Z",
    status: "streaming" as const,
  };

  it("expands the last running tool and follows newly started tools", () => {
    const { container, rerender } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: [
              { toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "src/a.ts" } },
              { toolCallId: "bash-1", toolName: "Bash", status: "running", arguments: { command: "npm test" } },
            ],
          }],
        }}
      />,
    );
    expect(container.querySelector(".ev-batch")?.classList.contains("open")).toBe(true);
    const openItems = container.querySelectorAll(".tl-item.open");
    expect(openItems).toHaveLength(1);
    expect(openItems[0]?.getAttribute("data-status")).toBe("running");
    expect(container.querySelector('.codeblock[data-live="tail"]')).not.toBeNull();

    rerender(
      <ConversationItemView
        row={{
          ...baseRow,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: [
              { toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "src/a.ts" } },
              { toolCallId: "bash-1", toolName: "Bash", status: "succeeded", arguments: { command: "npm test" } },
              { toolCallId: "grep-2", toolName: "Grep", status: "running", arguments: { pattern: "needle" } },
            ],
          }],
        }}
      />,
    );
    const followed = container.querySelectorAll(".tl-item.open");
    expect(followed).toHaveLength(1);
    expect(followed[0]?.getAttribute("data-kind")).toBe("grep");
  });

  it("follows the running tool while the calls after it are still queued", () => {
    // message.completed 落盘整条链后，尾部工具还没收到 tool.started，只能是 queued。
    const { container } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: [
              { toolCallId: "read-1", toolName: "Read", status: "running", arguments: { path: "src/a.ts" } },
              { toolCallId: "read-2", toolName: "Read", status: "queued", arguments: { path: "src/b.ts" } },
              { toolCallId: "read-3", toolName: "Read", status: "queued", arguments: { path: "src/c.ts" } },
            ],
          }],
        }}
      />,
    );
    const openItems = container.querySelectorAll(".tl-item.open");
    expect(openItems).toHaveLength(1);
    expect(openItems[0]?.getAttribute("data-status")).toBe("running");
    expect(container.querySelectorAll(".tl-row .spinner")).toHaveLength(1);
  });

  it("expands the next queued call before any start event arrives", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: [
              { toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "src/a.ts" } },
              { toolCallId: "read-2", toolName: "Read", status: "queued", arguments: { path: "src/b.ts" } },
              { toolCallId: "read-3", toolName: "Read", status: "queued", arguments: { path: "src/c.ts" } },
            ],
          }],
        }}
      />,
    );
    const openItems = container.querySelectorAll(".tl-item.open");
    expect(openItems).toHaveLength(1);
    expect(openItems[0]?.querySelector(".tl-detail")?.textContent).toBe("src/b.ts");
  });

  it("expands streaming thinking and folds it once the next text starts", () => {
    const { container, rerender } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          segments: [{ type: "thinking", key: "th-1", text: "还在推演下一步。" }],
        }}
      />,
    );
    expect(container.querySelector('.tl-item.open[data-kind="think"]')).not.toBeNull();
    expect(container.querySelector('.think-scroll[data-live="tail"]')).not.toBeNull();

    rerender(
      <ConversationItemView
        row={{
          ...baseRow,
          segments: [
            { type: "thinking", key: "th-1", text: "推演完成。" },
            { type: "text", key: "tx-1", text: "结论如下", streaming: true },
          ],
        }}
      />,
    );
    expect(container.querySelector(".tl-item.open")).toBeNull();
    expect(container.querySelector('.think-scroll[data-live="tail"]')).toBeNull();
  });

  it("stops tailing a running tool when the card is collapsed", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: [{
              toolCallId: "bash-1",
              toolName: "Bash",
              status: "running",
              arguments: { command: "npm test" },
              output: "ok\n".repeat(8),
            }],
          }],
        }}
      />,
    );
    expect(container.querySelector('.codeblock[data-live="tail"]')).not.toBeNull();
    fireEvent.click(container.querySelector(".tl-row") as HTMLButtonElement);
    expect(container.querySelector(".tl-item.open")).toBeNull();
    expect(container.querySelector('.codeblock[data-live="tail"]')).toBeNull();
  });

  it("keeps the chain open while a tool runs and folds it when the turn completes", () => {
    const runningPair = [
      { toolCallId: "bash-1", toolName: "Bash", status: "running" as const, arguments: { command: "npm test" } },
      { toolCallId: "bash-2", toolName: "Bash", status: "queued" as const, arguments: { command: "npm run lint" } },
    ];
    const { container, rerender } = render(
      <ConversationItemView
        row={{ ...baseRow, presentation: "process", segments: [{ type: "batch", key: "live-tools", tools: runningPair }] }}
      />,
    );
    expect(container.querySelector(".ev-batch.open")).not.toBeNull();

    rerender(
      <ConversationItemView
        row={{
          ...baseRow,
          status: "completed",
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: runningPair.map((tool) => ({ ...tool, status: "succeeded" as const })),
          }],
        }}
      />,
    );
    expect(container.querySelector(".ev-batch.open")).toBeNull();
    expect(container.querySelector(".tl-item.open")).toBeNull();
  });

  it("manual collapse during streaming wins over auto expand", () => {
    const tools = [
      { toolCallId: "bash-1", toolName: "Bash", status: "running" as const, arguments: { command: "npm test" } },
      { toolCallId: "read-1", toolName: "Read", status: "succeeded" as const, arguments: { path: "src/a.ts" } },
    ];
    const { container, rerender } = render(
      <ConversationItemView
        row={{ ...baseRow, presentation: "process", segments: [{ type: "batch", key: "live-tools", tools }] }}
      />,
    );
    fireEvent.click(container.querySelector(".batch-sum") as HTMLButtonElement);
    expect(container.querySelector(".ev-batch.open")).toBeNull();

    rerender(
      <ConversationItemView
        row={{
          ...baseRow,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "live-tools",
            tools: [{ ...tools[0]!, output: "still running" }, tools[1]!],
          }],
        }}
      />,
    );
    expect(container.querySelector(".ev-batch.open")).toBeNull();
  });
  it("folds an earlier chain once the reply row lands, even while the turn stays open", () => {
    const processRow: TimelineRow = {
      type: "assistant",
      itemId: "chain-a",
      createdAt: "2026-08-15T00:00:02.000Z",
      status: "streaming",
      turnOpen: true,
      presentation: "process",
      segments: [{
        type: "batch",
        key: "chain-a-tools",
        tools: [
          { toolCallId: "read-1", toolName: "read", status: "succeeded", arguments: { path: "src/a.ts" } },
          { toolCallId: "bash-1", toolName: "bash", status: "succeeded", arguments: { command: "npm test" } },
        ],
      }],
    };
    const replyRow: TimelineRow = {
      type: "assistant",
      itemId: "reply-1",
      createdAt: "2026-08-15T00:00:03.000Z",
      status: "completed",
      presentation: "reply",
      segments: [{ type: "text", key: "reply-text", text: "第一轮完成。" }],
    };
    const { container } = render(<ConvoTranscript rows={[processRow, replyRow]} />);
    // 轮次未关闭（turnOpen）也要折：这条链不再是 transcript 尾行，正文行落地后链尾自动折叠。
    expect(container.querySelector(".ev-batch.open")).toBeNull();
    expect(screen.getByRole("button", { name: /Read/ }).getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-live="tail"]')).toBeNull();
    expect(screen.getByText("第一轮完成。")).toBeTruthy();
  });

  it("keeps only the newest chain following while earlier chains fold", () => {
    const rows: TimelineRow[] = [
      {
        type: "assistant",
        itemId: "chain-a",
        createdAt: "2026-08-15T00:00:02.000Z",
        status: "streaming",
        turnOpen: true,
        presentation: "process",
        segments: [{
          type: "batch",
          key: "chain-a-tools",
          tools: [
            { toolCallId: "read-1", toolName: "read", status: "succeeded", arguments: { path: "src/a.ts" } },
            { toolCallId: "bash-1", toolName: "bash", status: "succeeded", arguments: { command: "npm test" } },
          ],
        }],
      },
      {
        type: "assistant",
        itemId: "reply-1",
        createdAt: "2026-08-15T00:00:03.000Z",
        status: "completed",
        presentation: "reply",
        segments: [{ type: "text", key: "reply-text", text: "第一轮完成。" }],
      },
      {
        type: "assistant",
        itemId: "chain-b",
        createdAt: "2026-08-15T00:00:04.000Z",
        status: "streaming",
        turnOpen: true,
        presentation: "process",
        segments: [{
          type: "batch",
          key: "chain-b-tools",
          tools: [
            { toolCallId: "grep-1", toolName: "grep", status: "running", arguments: { pattern: "needle" } },
            { toolCallId: "read-2", toolName: "read", status: "queued", arguments: { path: "src/b.ts" } },
          ],
        }],
      },
    ];
    const { container } = render(<ConvoTranscript rows={rows} />);
    const open = container.querySelectorAll(".ev-batch.open");
    expect(open).toHaveLength(1);
    expect(container.querySelector('[data-item-id="chain-b"] .ev-batch.open')).not.toBeNull();
    expect(container.querySelector('[data-item-id="chain-a"] .ev-batch.open')).toBeNull();
  });

  it("keeps a manually expanded earlier chain open after a later row arrives", () => {
    const firstRows: TimelineRow[] = [
      {
        type: "assistant",
        itemId: "chain-a",
        createdAt: "2026-08-15T00:00:02.000Z",
        status: "streaming",
        turnOpen: true,
        presentation: "process",
        segments: [{
          type: "batch",
          key: "chain-a-tools",
          tools: [
            { toolCallId: "read-1", toolName: "read", status: "succeeded", arguments: { path: "src/a.ts" } },
            { toolCallId: "bash-1", toolName: "bash", status: "succeeded", arguments: { command: "npm test" } },
          ],
        }],
      },
      {
        type: "assistant",
        itemId: "reply-1",
        createdAt: "2026-08-15T00:00:03.000Z",
        status: "completed",
        presentation: "reply",
        segments: [{ type: "text", key: "reply-text", text: "第一轮完成。" }],
      },
    ];
    const { container, rerender } = render(<ConvoTranscript rows={firstRows} />);
    // 非尾行默认折叠，用户手动点开摘要后 manualOpen 压过自动折叠。
    expect(container.querySelector(".ev-batch.open")).toBeNull();
    fireEvent.click(container.querySelector(".batch-sum") as HTMLButtonElement);
    expect(container.querySelector(".ev-batch.open")).not.toBeNull();

    const nextRows: TimelineRow[] = [
      ...firstRows,
      {
        type: "assistant",
        itemId: "chain-b",
        createdAt: "2026-08-15T00:00:04.000Z",
        status: "streaming",
        turnOpen: true,
        presentation: "process",
        segments: [{
          type: "batch",
          key: "chain-b-tools",
          tools: [
            { toolCallId: "grep-1", toolName: "grep", status: "running", arguments: { pattern: "needle" } },
            { toolCallId: "read-2", toolName: "read", status: "queued", arguments: { path: "src/b.ts" } },
          ],
        }],
      },
    ];
    rerender(<ConvoTranscript rows={nextRows} />);
    // 新尾行到达后，手动展开的旧链保持打开（manualOpen 优先于自动折叠）。
    expect(container.querySelector('[data-item-id="chain-a"] .ev-batch.open')).not.toBeNull();
  });

  it("treats a standalone assistant row as the tail", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "chain-a",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "streaming",
          turnOpen: true,
          presentation: "process",
          segments: [{
            type: "batch",
            key: "chain-a-tools",
            tools: [
              { toolCallId: "read-1", toolName: "read", status: "succeeded", arguments: { path: "src/a.ts" } },
              { toolCallId: "bash-1", toolName: "bash", status: "succeeded", arguments: { command: "npm test" } },
            ],
          }],
        }}
      />,
    );
    // 不经 ConvoTranscript 单独渲染时 tail 默认 true，流式链尾仍自动展开。
    expect(container.querySelector(".ev-batch.open")).not.toBeNull();
  });
});

describe("single-card chains skip the batch shell", () => {
  const baseRow = {
    type: "assistant" as const,
    itemId: "m-single",
    createdAt: "2026-08-15T00:00:02.000Z",
    status: "completed" as const,
    presentation: "process" as const,
  };

  it("renders a lone tool as its own row without a batch summary", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          segments: [{
            type: "batch",
            key: "one-tool",
            tools: [{ toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "src/a.ts" } }],
          }],
        }}
      />,
    );
    expect(container.querySelector(".batch-sum")).toBeNull();
    expect(container.querySelector(".batch-chain")).toBeNull();
    const row = screen.getByRole("button", { name: /Read · src\/a\.ts/ });
    expect(row).toBeTruthy();
    fireEvent.click(row);
    expect(container.querySelector('.tl-item.open[data-kind="read"]')).not.toBeNull();
  });

  it("renders a lone thinking segment as its own card without a batch summary", () => {
    const { container } = render(
      <ConversationItemView row={{ ...baseRow, segments: [{ type: "thinking", key: "th-1", text: "先看清依赖方向。" }] }} />,
    );
    expect(container.querySelector(".batch-sum")).toBeNull();
    expect(container.querySelectorAll('.tl-item[data-kind="think"]')).toHaveLength(1);
  });

  it("keeps the batch summary as soon as a chain holds two cards", () => {
    const { container } = render(
      <ConversationItemView
        row={{
          ...baseRow,
          segments: [
            { type: "thinking", key: "th-1", text: "读一下再说。" },
            {
              type: "batch",
              key: "one-tool",
              tools: [{ toolCallId: "read-1", toolName: "Read", status: "succeeded", arguments: { path: "src/a.ts" } }],
            },
          ],
        }}
      />,
    );
    expect(container.querySelector(".batch-sum")).not.toBeNull();
    expect(container.querySelector(".batch-chain")).not.toBeNull();
  });
});

describe("real OMP tool-card bindings", () => {
  it("routes xd write envelopes to Browser and MCP instead of file Write", () => {
    const browser = {
      toolCallId: "xd-browser",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "xd://browser", content: "{\"action\":\"open\"}" },
      output: "Opened tab main",
      result: {
        type: "toolResult" as const,
        toolCallId: "xd-browser",
        toolName: "write",
        isError: false,
        data: {
          xdev: {
            tool: "browser",
            mode: "execute",
            args: { action: "open", url: "http://127.0.0.1:4173" },
            inner: { name: "main", result: "Opened tab main" },
          },
        },
      },
    };
    const mcp = {
      toolCallId: "xd-mcp",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "xd://mcp__node_repl_js", content: "{\"code\":\"6 * 7\"}" },
      result: {
        type: "toolResult" as const,
        toolCallId: "xd-mcp",
        toolName: "write",
        isError: false,
        data: {
          xdev: {
            tool: "mcp__node_repl_js",
            mode: "execute",
            args: { code: "6 * 7" },
            inner: { serverName: "node_repl", mcpToolName: "js", rawContent: [{ type: "text", text: "42" }] },
          },
        },
      },
    };
    expect(toolKind(browser)).toBe("browser");
    expect(toolKind(mcp)).toBe("mcp");
    const wrappedKind = (tool: string) => toolKind({
      toolCallId: `xd-${tool}`,
      toolName: "write",
      status: "succeeded",
      result: {
        type: "toolResult",
        toolCallId: `xd-${tool}`,
        toolName: "write",
        isError: false,
        data: { xdev: { tool, args: {} } },
      },
    });
    expect(wrappedKind("inspect_image")).toBe("inspect_image");
    expect(wrappedKind("lsp")).toBe("lsp");
    expect(wrappedKind("powershell")).toBe("bash");
    expect(wrappedKind("report_issue")).toBe("report_issue");
    expect(batchSummary([], [mcp]).text).toBe("请求 1 次");
    const { container } = render(<><ToolBody tool={browser} /><ToolBody tool={mcp} /></>);
    expect(container.textContent).toContain("http://127.0.0.1:4173");
    expect(container.textContent).toContain("Opened tab main");
    expect(container.textContent).toContain("6 * 7");
    expect(container.textContent).toContain("42");
  });

  it("renders real file Write and string Edit diff fields", () => {
    const write = {
      toolCallId: "write-file",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "src/a.ts", content: "one\ntwo" },
      result: { type: "toolResult" as const, toolCallId: "write-file", toolName: "write", isError: false, data: { resolvedPath: "D:/src/a.ts" } },
    };
    const edit = {
      toolCallId: "edit-file",
      toolName: "edit",
      status: "succeeded" as const,
      arguments: { path: "src/a.ts", old_string: "old", new_string: "new" },
      result: {
        type: "toolResult" as const,
        toolCallId: "edit-file",
        toolName: "edit",
        isError: false,
        data: { diff: " 11|before\n-12|old\n+12|new", firstChangedLine: 12, path: "src/a.ts" },
      },
    };
    const { container } = render(<><ToolBody tool={write} /><ToolBody tool={edit} /></>);
    expect(container.textContent).toContain("写入");
    expect(container.textContent).toContain("2 行");
    expect(container.textContent).toContain("one");
    expect(container.querySelectorAll('[data-tool-scroll="both"]')).toHaveLength(2);
    expect(container.querySelectorAll(".tc-diff .dl")).toHaveLength(3);
    expect(container.querySelector(".tc-diff .add")?.textContent).toContain("new");
    expect(container.querySelector(".tc-diff .del")?.textContent).toContain("old");
    expect(batchSummary([], [edit])).toMatchObject({ add: 1, del: 1 });
  });

  it("shows Write/Edit line stats on tool rows and an optional Edit summary", () => {
    const write = {
      toolCallId: "write-title",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "src/a.ts", content: "one\ntwo" },
    };
    const edit = {
      toolCallId: "edit-title",
      toolName: "edit",
      status: "succeeded" as const,
      arguments: { path: "src/a.ts", i: "更新配置项" },
      result: {
        type: "toolResult" as const,
        toolCallId: "edit-title",
        toolName: "edit",
        isError: false,
        data: { diff: "-12|old\n+12|new" },
      },
    };
    expect(toolDiffStats(write)).toEqual({ add: 2, del: 0 });
    expect(toolDiffStats(edit)).toEqual({ add: 1, del: 1 });

    const { container } = render(
      <ConversationItemView
        row={{
          type: "assistant",
          itemId: "tool-title-stats",
          createdAt: "2026-08-15T00:00:02.000Z",
          status: "completed",
          presentation: "process",
          segments: [{ type: "batch", key: "stats", tools: [write, edit] }],
        }}
      />,
    );
    fireEvent.click(container.querySelector(".batch-sum") as HTMLButtonElement);
    expect(container.querySelector(".batch-chain-inner")).not.toBeNull();
    expect(container.querySelector('[data-kind="write"] .tl-diff .add')?.textContent).toBe("+2");
    expect(container.querySelector('[data-kind="edit"] .tl-diff .add')?.textContent).toBe("+1");
    expect(container.querySelector('[data-kind="edit"] .tl-diff .del')?.textContent).toBe("−1");

    const editButton = screen.getByRole("button", { name: /Edit/ });
    fireEvent.click(editButton);
    expect(container.querySelector(".tc-edit-summary")?.textContent).toBe("更新配置项");
    fireEvent.click(editButton);
    expect(container.querySelector('[data-kind="edit"]')?.classList.contains("open")).toBe(false);
    expect(container.querySelector('[data-kind="edit"] .tl-card')).not.toBeNull();
    expect(container.querySelector('[data-kind="edit"] .tl-card > .tl-card-motion-inner > .tc-body')).not.toBeNull();
  });

  it("renders real Read, Bash, Grep, and Glob result shapes", () => {
    const read = {
      toolCallId: "read-real", toolName: "read", status: "succeeded" as const,
      arguments: { path: "src/a.ts" },
      result: { type: "toolResult" as const, toolCallId: "read-real", toolName: "read", isError: false, data: { totalLines: 2, fileSize: 8, displayContent: { text: "one\ntwo", startLine: 4, lineNumbers: [4, 5] } } },
    };
    const bash = {
      toolCallId: "bash-real", toolName: "bash", status: "succeeded" as const,
      arguments: { command: "npm test", cwd: "D:/repo" }, output: "ok",
      result: { type: "toolResult" as const, toolCallId: "bash-real", toolName: "bash", isError: false, data: { exitCode: 0, wallTimeMs: 1250, timeoutSeconds: 30 } },
    };
    const grep = {
      toolCallId: "grep-real", toolName: "grep", status: "succeeded" as const,
      arguments: { pattern: "needle", path: "src" },
      result: { type: "toolResult" as const, toolCallId: "grep-real", toolName: "grep", isError: false, data: { matchCount: 2, fileCount: 1, fileMatches: [{ path: "src/a.ts", count: 2 }], displayContent: "# src\n## a.ts\n  4│needle" } },
    };
    const glob = {
      toolCallId: "glob-real", toolName: "glob", status: "succeeded" as const,
      arguments: { path: "src", pattern: "*.ts" },
      result: { type: "toolResult" as const, toolCallId: "glob-real", toolName: "glob", isError: false, data: { fileCount: 1, files: ["src/a.ts"], truncated: false } },
    };
    const { container } = render(<><ToolBody tool={read} /><ToolBody tool={bash} /><ToolBody tool={grep} /><ToolBody tool={glob} /></>);
    expect(container.textContent).toContain("one");
    expect(container.querySelector('.tc-code[data-tool-scroll="both"]')).not.toBeNull();
    expect(container.textContent).toContain("1.25s");
    expect(container.textContent).toContain("src/a.ts");
    expect(container.textContent).toContain("4│needle");
  });

  it("running bash card follows live output and does not fake exit 0", () => {
    const { container, rerender } = render(
      <ToolBody
        tool={{
          toolCallId: "bash-live",
          toolName: "bash",
          status: "running",
          arguments: { command: "npm run typecheck", cwd: "D:/repo" },
          output: "\u001b[33mBuilding... 10%\u001b[0m\r\u001b[33mBuilding... 100%\u001b[0m\nerror TS2322",
        }}
      />,
    );
    expect(container.querySelector('.codeblock[data-live="tail"]')).not.toBeNull();
    expect(container.textContent).toContain("$ npm run typecheck");
    expect(container.textContent).toContain("Building... 100%");
    expect(container.textContent).not.toContain("Building... 10%");
    expect(container.textContent).toContain("error TS2322");
    expect(container.textContent).toContain("运行中");
    expect(container.textContent).not.toContain("exit 0");

    rerender(
      <ToolBody
        tool={{
          toolCallId: "bash-live",
          toolName: "bash",
          status: "succeeded",
          arguments: { command: "npm run typecheck", cwd: "D:/repo" },
          output: "done\n",
          result: {
            type: "toolResult",
            toolCallId: "bash-live",
            toolName: "bash",
            isError: false,
            data: { exitCode: 0, wallTimeMs: 800 },
          },
        }}
      />,
    );
    expect(container.querySelector(".codeblock[data-live='tail']")).toBeNull();
    expect(container.textContent).toContain("exit 0");
    expect(container.textContent).not.toContain("运行中");
  });

  it("preview live transcript shows a running bash tail after the gallery", () => {
    const rows = previewConversationRows();
    expect(rows.some((row) => row.type === "user" && row.text?.includes("再跑一遍 typecheck"))).toBe(true);
    const live = rows.find((row) => row.type === "assistant" && row.itemId === "preview-live-assistant");
    const tools = live?.type === "assistant"
      ? live.segments.flatMap((segment) => (segment.type === "batch" ? segment.tools : []))
      : [];
    expect(tools).toEqual([
      expect.objectContaining({
        toolCallId: "preview-bash-live",
        status: "running",
        output: expect.stringContaining("tsc --noEmit"),
      }),
    ]);
    const { container } = render(<ConvoTranscript rows={rows} demo />);
    expect(screen.getByText("运行中")).toBeTruthy();
    expect(container.textContent).toContain("TS2322");
    expect(container.querySelector('.codeblock[data-live="tail"]')).not.toBeNull();
  });

  it("renders real Eval, Ask, Task, Hub, and Web Search result shapes", () => {
    const evalTool = {
      toolCallId: "eval-real", toolName: "eval", status: "succeeded" as const,
      arguments: { language: "py", title: "probe", code: "print(42)" },
      result: { type: "toolResult" as const, toolCallId: "eval-real", toolName: "eval", isError: false, data: { language: "python", cells: [{ index: 0, title: "probe", code: "print(42)", language: "python", output: "42", status: "complete", exitCode: 0, durationMs: 25 }] } },
    };
    const ask = {
      toolCallId: "ask-real", toolName: "ask", status: "succeeded" as const,
      arguments: { questions: [{ question: "怎么处理？" }] }, output: "User selected: 修复它",
      result: { type: "toolResult" as const, toolCallId: "ask-real", toolName: "ask", isError: false, data: { question: "怎么处理？", options: ["修复它", "保持现状"], multi: false, selectedOptions: ["修复它"] } },
    };
    const task = {
      toolCallId: "task-real", toolName: "task", status: "succeeded" as const,
      arguments: { context: "# Goal\n检查代码", tasks: [{ name: "audit", task: "审查" }] },
      result: { type: "toolResult" as const, toolCallId: "task-real", toolName: "task", isError: false, data: { totalDurationMs: 1200, progress: [{ id: "audit", status: "completed", toolCount: 3, requests: 2, tokens: 500, durationMs: 1200 }] } },
    };
    const hub = {
      toolCallId: "hub-real", toolName: "hub", status: "succeeded" as const,
      arguments: { op: "jobs" },
      result: { type: "toolResult" as const, toolCallId: "hub-real", toolName: "hub", isError: false, data: { op: "jobs", jobs: [{ id: "audit", type: "task", status: "running", label: "audit", durationMs: 1300, resolvedModel: "deepseek" }] } },
    };
    const web = {
      toolCallId: "web-real", toolName: "web_search", status: "succeeded" as const,
      arguments: { query: "OMP Studio" }, output: "[1] Official result",
      result: { type: "toolResult" as const, toolCallId: "web-real", toolName: "web_search", isError: false, data: { response: { provider: "google", sources: [{ title: "Official result", url: "https://example.com", snippet: "summary" }] } } },
    };
    const { container } = render(<><ToolBody tool={evalTool} /><ToolBody tool={ask} /><ToolBody tool={task} /><ToolBody tool={hub} /><ToolBody tool={web} /></>);
    expect(container.textContent).toContain("42");
    expect(container.querySelector(".ask-opt.is-on")?.textContent).toContain("修复它");
    expect(container.textContent).toContain("audit");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("Official result");
    expect(container.textContent).toContain("https://example.com");
  });

  it("web_search tool card renders structured citations with tooltips and links", () => {
    const web = {
      toolCallId: "web-rich",
      toolName: "web_search",
      status: "succeeded" as const,
      arguments: { query: "DeepSeek最新动态" },
      output: "[1] 更新日志 https://api-docs.deepseek.com/zh-cn/updates/",
      result: {
        type: "toolResult" as const,
        toolCallId: "web-rich",
        toolName: "web_search",
        isError: false,
        data: {
          provider: "firecrawl",
          response: {
            provider: "firecrawl",
            sources: [
              { title: "更新日志", url: "https://api-docs.deepseek.com/zh-cn/updates/" },
              { title: "DeepSeek V4 Pro", url: "https://example.com/v4" },
              "https://example.com/raw-url",
            ],
          },
        },
      },
    };
    const { container } = render(<ToolBody tool={web} />);
    expect(container.textContent).toContain("provider");
    expect(container.textContent).toContain("firecrawl");
    expect(container.textContent).toContain("sources");
    expect(container.textContent).toContain("3");
    expect(container.textContent).toContain("更新日志");
    expect(container.textContent).toContain("https://api-docs.deepseek.com/zh-cn/updates/");

    const cites = container.querySelectorAll(".tc-cite");
    expect(cites.length).toBe(3);
    expect(cites[0]?.getAttribute("href")).toBe("https://api-docs.deepseek.com/zh-cn/updates/");
    expect(cites[0]?.getAttribute("title")).toBe("更新日志 · https://api-docs.deepseek.com/zh-cn/updates/");
    expect(cites[2]?.getAttribute("href")).toBe("https://example.com/raw-url");
  });
});

describe("turn file-change card", () => {
  const write = {
    toolCallId: "write-card",
    toolName: "write",
    status: "succeeded" as const,
    arguments: { path: "apps/renderer/src/conversation/ConversationPane.tsx", content: "a\nb\nc" },
  };
  const edit = {
    toolCallId: "edit-card",
    toolName: "edit",
    status: "succeeded" as const,
    arguments: { path: "apps/renderer/src/styles/workbench.css" },
    result: {
      type: "toolResult" as const,
      toolCallId: "edit-card",
      toolName: "edit",
      isError: false,
      data: { diff: "-1|old\n+1|new\n+2|also" },
    },
  };

  it("merges Write/Edit/AST Edit files and skips failed tools", () => {
    const failed = { ...write, toolCallId: "write-fail", status: "failed" as const, arguments: { path: "secret.env", content: "x" } };
    const ast = {
      toolCallId: "ast-card",
      toolName: "ast_edit",
      status: "succeeded" as const,
      arguments: {
        target: "console.log($MSG) → void",
        changes: [
          { file: "apps/renderer/src/conversation/ConversationPane.tsx", before: "log", after: "" },
          { file: "apps/renderer/src/xdev-notice-replay.html", before: "a", after: "b" },
        ],
      },
    };
    const changes = collectTurnFileChanges([
      { type: "batch", key: "b", tools: [write, edit, failed, ast] },
    ]);
    expect(changes.map((file) => file.path)).toEqual([
      "apps/renderer/src/conversation/ConversationPane.tsx",
      "apps/renderer/src/styles/workbench.css",
      "apps/renderer/src/xdev-notice-replay.html",
    ]);
    expect(changes[0]).toMatchObject({ name: "ConversationPane.tsx", dir: "apps/renderer/src/conversation/", add: 3, del: 1 });
    expect(changes[1]).toMatchObject({ name: "workbench.css", add: 2, del: 1 });
    expect(changes[2]).toMatchObject({ name: "xdev-notice-replay.html", add: 1, del: 1 });
  });

  it("shows a completed-turn card with 审核 and right-aligned diffstats, not while streaming", () => {
    const completed = {
      type: "assistant" as const,
      itemId: "done-turn",
      createdAt: "2026-08-15T00:00:02.000Z",
      status: "completed" as const,
      presentation: "reply" as const,
      segments: [
        { type: "text" as const, key: "t", text: "改好了。" },
        { type: "batch" as const, key: "b", tools: [write, edit] },
      ],
    };
    const streaming = { ...completed, itemId: "live-turn", status: "streaming" as const };
    expect(turnChangeBinds([streaming])[0]).toBeUndefined();
    expect(turnChangeBinds([{ ...completed, turnOpen: true }])[0]).toBeUndefined();

    const reviewed: string[] = [];
    const { container } = render(
      <ConvoTranscript
        rows={[completed]}
        onReviewChanges={(turnId) => { reviewed.push(turnId); }}
      />,
    );
    expect(container.querySelector(".turn-diff.open")).not.toBeNull();
    expect(screen.getByRole("button", { name: /2 个文件已更改/ }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".turn-diff-stats .add")?.textContent).toBe("+5");
    expect(container.querySelector(".turn-diff-stats .del")?.textContent).toBe("−1");
    expect(container.querySelector(".turn-diff-row .turn-diff-file-stats")?.textContent).toContain("+3");
    expect(screen.getByText("ConversationPane.tsx")).toBeTruthy();
    expect(screen.getByText("apps/renderer/src/conversation/")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
    expect(screen.queryByRole("button", { name: "撤销" })).toBeNull();
    expect(screen.queryByRole("button", { name: "审查" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "审核" }));
    expect(reviewed).toEqual([SESSION_CHANGE_LAST_ID]);
  });

  it("collapses earlier turns and keeps the latest completed turn expanded", () => {
    const first = {
      type: "assistant" as const,
      itemId: "turn-1",
      createdAt: "2026-08-15T00:00:02.000Z",
      status: "completed" as const,
      presentation: "reply" as const,
      segments: [{ type: "batch" as const, key: "b1", tools: [write] }],
    };
    const second = {
      type: "assistant" as const,
      itemId: "turn-2",
      createdAt: "2026-08-15T00:00:04.000Z",
      status: "completed" as const,
      presentation: "reply" as const,
      segments: [{ type: "batch" as const, key: "b2", tools: [edit] }],
    };
    const reviewed: string[] = [];
    render(
      <ConvoTranscript
        rows={[
          { type: "user", itemId: "u1", createdAt: "2026-08-15T00:00:01.000Z", text: "第一轮" },
          first,
          { type: "user", itemId: "u2", createdAt: "2026-08-15T00:00:03.000Z", text: "第二轮" },
          second,
        ]}
        onReviewChanges={(turnId) => { reviewed.push(turnId); }}
      />,
    );
    const toggles = screen.getAllByRole("button", { name: /个文件已更改/ });
    expect(toggles).toHaveLength(2);
    expect(toggles[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(toggles[1]?.getAttribute("aria-expanded")).toBe("true");
    const reviews = screen.getAllByRole("button", { name: "审核" });
    fireEvent.click(reviews[0]!);
    fireEvent.click(reviews[1]!);
    expect(reviewed).toEqual(["turn-1", SESSION_CHANGE_LAST_ID]);
  });

  it("caps lists over six files and cycles collapsed → capped → full → collapsed", () => {
    const tools = Array.from({ length: 8 }, (_, index) => ({
      ...write,
      toolCallId: `write-cap-${index}`,
      arguments: { path: `apps/renderer/src/mod-${index}.ts`, content: "a\nb" },
    }));
    const { container } = render(
      <ConvoTranscript
        rows={[
          {
            type: "assistant" as const,
            itemId: "cap-turn",
            createdAt: "2026-08-15T00:00:02.000Z",
            status: "completed" as const,
            presentation: "reply" as const,
            segments: [{ type: "batch" as const, key: "b", tools }],
          },
        ]}
      />,
    );
    expect(container.querySelector(".turn-diff")?.className).toContain("open");
    expect(container.querySelector(".turn-diff")?.className).toContain("capped");
    const toggle = screen.getAllByRole("button", { name: /个文件已更改/ })[0]!;
    fireEvent.click(toggle);
    expect(container.querySelector(".turn-diff")?.className).not.toContain("capped");
    expect(container.querySelector(".turn-diff")?.className).toContain("open");
    fireEvent.click(toggle);
    expect(container.querySelector(".turn-diff")?.className).not.toContain("open");
    fireEvent.click(toggle);
    expect(container.querySelector(".turn-diff")?.className).toContain("open");
    expect(container.querySelector(".turn-diff")?.className).toContain("capped");
  });

  it("skips the capped stage when files fit within the limit", () => {
    const { container } = render(
      <ConvoTranscript
        rows={[
          {
            type: "assistant" as const,
            itemId: "small-turn",
            createdAt: "2026-08-15T00:00:02.000Z",
            status: "completed" as const,
            presentation: "reply" as const,
            segments: [{ type: "batch" as const, key: "b", tools: [write, edit] }],
          },
        ]}
      />,
    );
    const toggle = screen.getByRole("button", { name: /2 个文件已更改/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".turn-diff")?.className).not.toContain("capped");
    fireEvent.click(toggle);
    expect(container.querySelector(".turn-diff")?.className).not.toContain("open");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(container.querySelector(".turn-diff")?.className).not.toContain("capped");
    expect(container.querySelector(".turn-diff")?.className).toContain("open");
  });

  it("holds the latest card until the Runtime turn closes, even after file tools succeed", () => {
    const writeItem: Extract<ConversationItem, { kind: "message" }> = {
      ...assistantItem("m-write", ""),
      createdAt: "2026-08-15T00:00:02.000Z",
      content: [
        { type: "toolCall", toolCallId: "w1", toolName: "write", arguments: { path: "src/a.ts", content: "a\nb\nc" } },
        { type: "toolResult", toolCallId: "w1", toolName: "write", isError: false },
      ],
    };
    const replyItem = assistantItem("m-reply", "改好了。");
    const baseState = {
      ...createInitialConversationState(),
      order: ["m-write", "m-reply"],
      itemsById: { "m-write": writeItem, "m-reply": replyItem },
    };
    const openRows = rowsFromConversationViews(selectConversationViews({
      ...baseState,
      openTurnItems: { "m-write": "t1", "m-reply": "t1" },
    }));
    expect(openRows.every((row) => row.type !== "assistant" || row.turnOpen === true)).toBe(true);
    expect(turnChangeBinds(openRows).every((bind) => bind === undefined)).toBe(true);

    const earlierClosed = {
      type: "assistant" as const,
      itemId: "old-turn",
      createdAt: "2026-08-15T00:00:00.000Z",
      status: "completed" as const,
      segments: [{ type: "batch" as const, key: "b-old", tools: [write] }],
    };
    const laterOpen = {
      type: "assistant" as const,
      itemId: "new-turn",
      createdAt: "2026-08-15T00:00:04.000Z",
      status: "completed" as const,
      turnOpen: true,
      segments: [{ type: "batch" as const, key: "b-new", tools: [edit] }],
    };
    const mixed = turnChangeBinds([
      { type: "user", itemId: "u-old", createdAt: "2026-08-15T00:00:00.000Z", text: "上一轮" },
      earlierClosed,
      { type: "user", itemId: "u-new", createdAt: "2026-08-15T00:00:03.000Z", text: "这一轮" },
      laterOpen,
    ]);
    expect(mixed[1]).toBeDefined();
    expect(mixed[3]).toBeUndefined();

    const closedRows = rowsFromConversationViews(selectConversationViews(baseState));
    const closedBinds = turnChangeBinds(closedRows);
    expect(closedRows.some((row) => row.type === "assistant" && row.turnOpen === true)).toBe(false);
    expect(closedBinds.some((bind) => bind !== undefined)).toBe(true);

    const { container: openContainer } = render(<ConvoTranscript rows={openRows} />);
    expect(openContainer.querySelector(".turn-diff")).toBeNull();
    const { container: closedContainer } = render(<ConvoTranscript rows={closedRows} />);
    expect(closedContainer.querySelector(".turn-diff")).not.toBeNull();
  });
});

describe("plan created card", () => {
  const reply = {
    type: "assistant" as const,
    itemId: "plan-turn",
    createdAt: "2026-08-15T00:00:02.000Z",
    status: "completed" as const,
    presentation: "reply" as const,
    segments: [{ type: "text" as const, key: "t", text: "计划如下。" }],
  };
  const write = {
    toolCallId: "write-plan-card",
    toolName: "write",
    status: "succeeded" as const,
    arguments: { path: "local://plan-annotation-receipt-plan.md", content: "a\nb" },
  };
  const propose = {
    toolCallId: "propose-1",
    toolName: "write",
    status: "succeeded" as const,
    arguments: { path: "xd://propose", content: JSON.stringify({ title: "plan-annotation-receipt" }) },
    result: {
      type: "toolResult" as const,
      toolCallId: "propose-1",
      toolName: "write",
      isError: false,
      data: {
        xdev: {
          tool: "propose",
          args: { title: "plan-annotation-receipt" },
          inner: { result: "Plan ready for review." },
        },
      },
    },
  };
  const processWrite = {
    type: "assistant" as const,
    itemId: "plan-write",
    createdAt: "2026-08-15T00:00:01.000Z",
    status: "completed" as const,
    presentation: "process" as const,
    segments: [{ type: "batch" as const, key: "w", tools: [write] }],
  };
  const replyPropose = {
    ...reply,
    itemId: "plan-propose",
    segments: [
      { type: "text" as const, key: "t", text: "计划已写入 local://plan-annotation-receipt-plan.md。现在提交审批：" },
      { type: "batch" as const, key: "b", tools: [propose] },
    ],
  };
  const withFiles = {
    ...reply,
    itemId: "plan-files",
    segments: [
      { type: "text" as const, key: "t", text: "改好了。" },
      { type: "batch" as const, key: "b", tools: [write] },
    ],
  };
  const reviewFallback = {
    title: "User message restore",
    onOpen: vi.fn(),
    attachEvenWithoutPropose: true as const,
  };

  it("renders above the turn diff after xd://propose, without snapshot review", () => {
    const { container } = render(
      <ConvoTranscript rows={[processWrite, replyPropose]} planLink={{ onOpen: vi.fn() }} />,
    );
    const card = container.querySelector(".plan-created");
    const diff = container.querySelector(".turn-diff");
    expect(card).not.toBeNull();
    expect(diff).not.toBeNull();
    expect(card && diff && (card.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING)).not.toBe(0);
    expect(screen.getByRole("button", { name: "打开计划：plan-annotation-receipt" })).toBeTruthy();
  });

  it("stays on the propose row after later assistants in the same run", () => {
    const afterApprove = {
      type: "assistant" as const,
      itemId: "after-approve",
      createdAt: "2026-08-15T00:00:04.000Z",
      status: "completed" as const,
      presentation: "reply" as const,
      segments: [
        { type: "text" as const, key: "t", text: "开始执行计划。" },
        {
          type: "batch" as const,
          key: "b",
          tools: [{
            toolCallId: "write-exec",
            toolName: "write",
            status: "succeeded" as const,
            arguments: { path: "apps/renderer/src/App.tsx", content: "ok\n" },
          }],
        },
      ],
    };
    const { container } = render(
      <ConvoTranscript
        rows={[processWrite, replyPropose, afterApprove]}
        planLink={{ onOpen: vi.fn() }}
      />,
    );
    const card = container.querySelector(".plan-created");
    const proposeRow = container.querySelector('[data-item-id="plan-propose"]');
    const laterRow = container.querySelector('[data-item-id="after-approve"]');
    expect(card).not.toBeNull();
    expect(proposeRow?.contains(card)).toBe(true);
    expect(laterRow?.contains(card)).toBe(false);
    expect(container.querySelectorAll(".plan-created")).toHaveLength(1);
  });

  it("shows the card as soon as xd://propose appears, before the turn closes", () => {
    const streaming = {
      ...replyPropose,
      status: "streaming" as const,
      turnOpen: true,
      segments: [
        { type: "text" as const, key: "t", text: "现在提交审批：" },
        { type: "batch" as const, key: "b", tools: [{ ...propose, status: "running" as const }] },
      ],
    };
    const { container } = render(<ConvoTranscript rows={[streaming]} planLink={{ onOpen: vi.fn() }} />);
    expect(container.querySelector(".plan-created")).not.toBeNull();
    expect(container.querySelector(".turn-diff")).toBeNull();
  });

  it("falls back to the last assistant row during review when there is no propose", () => {
    const { container } = render(
      <ConvoTranscript rows={[withFiles]} planLink={reviewFallback} />,
    );
    const card = container.querySelector(".plan-created");
    const diff = container.querySelector(".turn-diff");
    expect(card).not.toBeNull();
    expect(diff).not.toBeNull();
    expect(card && diff && (card.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING)).not.toBe(0);
    expect(screen.getByRole("button", { name: "打开计划：User message restore" })).toBeTruthy();
  });

  it("still appears on the last assistant row when there is no diff card", () => {
    const { container } = render(
      <ConvoTranscript rows={[reply]} planLink={reviewFallback} />,
    );
    expect(container.querySelector(".plan-created")).not.toBeNull();
    expect(container.querySelector(".turn-diff")).toBeNull();
  });

  it("does not render a file write as a created plan without propose", () => {
    const { container } = render(<ConvoTranscript rows={[withFiles]} planLink={{ onOpen: vi.fn() }} />);
    expect(container.querySelector(".plan-created")).toBeNull();
  });

  it("does not render without a plan link", () => {
    const { container } = render(<ConvoTranscript rows={[processWrite, replyPropose]} />);
    expect(container.querySelector(".plan-created")).toBeNull();
  });

  it("opens the plan review dialog from the conversation entry", () => {
    function Harness() {
      const originRef = useRef<HTMLElement | null>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <ConvoTranscript
            rows={[replyPropose]}
            planLink={{
              onOpen: (origin) => {
                originRef.current = origin;
                setOpen(true);
              },
            }}
          />
          <PlanReviewDeck
            title="plan-annotation-receipt"
            body="## 目标\n\nRestore the composer draft.\n"
            expanded={open}
            onExpandedChange={setOpen}
            originRef={originRef}
            onAction={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "打开计划：plan-annotation-receipt" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("Plan Review · plan-annotation-receipt");
  });
});

describe("session task progress", () => {
  const todoTool = (id: string, phases: JsonValue, op = "update"): ToolView => ({
    toolCallId: id,
    toolName: "todo",
    status: "succeeded",
    arguments: { kind: "todo", op, phases },
  });

  it("keeps the latest todo snapshot and maps done/doing labels", () => {
    const first = todoTool("todo-1", [
      { name: "计划", tasks: [{ content: "阅读文档", status: "done" }, { text: "写文档", status: "doing" }] },
    ]);
    const second = todoTool("todo-2", [
      {
        name: "验证",
        tasks: [
          { id: "a", content: "typecheck", status: "completed" },
          { id: "b", content: "lint", status: "in_progress" },
          { id: "c", content: "checkpoint", status: "pending" },
        ],
      },
    ]);
    const todos = collectLatestTodos([
      { type: "batch", key: "b1", tools: [first] },
      { type: "batch", key: "b2", tools: [second] },
    ]);
    expect(todos.map((task) => ({ id: task.id, content: task.content, status: task.status, phase: task.phase }))).toEqual([
      { id: "a", content: "typecheck", status: "completed", phase: "验证" },
      { id: "b", content: "lint", status: "in_progress", phase: "验证" },
      { id: "c", content: "checkpoint", status: "pending", phase: "验证" },
    ]);
    expect(todoStepProgress(todos)).toEqual({ current: 2, total: 3, completed: 1 });
  });

  it("groups tasks by first-seen phase and hides headers for a lone Tasks list", () => {
    const grouped = groupTodosByPhase([
      { id: "1", content: "读文档", status: "completed", phase: "文档" },
      { id: "2", content: "写文档", status: "completed", phase: "文档" },
      { id: "3", content: "lint", status: "in_progress", phase: "验证" },
    ]);
    expect(grouped.map((group) => ({ phase: group.phase, contents: group.tasks.map((task) => task.content) }))).toEqual([
      { phase: "文档", contents: ["读文档", "写文档"] },
      { phase: "验证", contents: ["lint"] },
    ]);
    expect(todoPhaseHeadersVisible(grouped)).toBe(true);
    expect(todoPhaseHeadersVisible(groupTodosByPhase([
      { id: "1", content: "写文档", status: "pending", phase: "Tasks" },
    ]))).toBe(false);
    expect(todoPhaseHeadersVisible(groupTodosByPhase([
      { id: "1", content: "写文档", status: "pending" },
    ]))).toBe(false);
    const mixed = grouped;
    expect(isTodoPhaseComplete(mixed[0]!)).toBe(true);
    expect(isTodoPhaseComplete(mixed[1]!)).toBe(false);
    expect(todoPhaseOpenByDefault(mixed)).toEqual([false, true]);
    expect(todoPhaseOpenByDefault([
      { phase: "文档", tasks: [{ id: "1", content: "读文档", status: "completed", phase: "文档" }] },
      { phase: "验证", tasks: [{ id: "2", content: "lint", status: "completed", phase: "验证" }] },
    ])).toEqual([true, true]);
  });

  it("treats clear as an empty snapshot and ignores abandoned tasks in the step count", () => {
    expect(collectLatestTodos([{
      type: "batch",
      key: "b",
      tools: [
        todoTool("todo-1", [{ name: "计划", tasks: [{ content: "x", status: "pending" }] }]),
        todoTool("todo-clear", [], "clear"),
      ],
    }])).toEqual([]);
    expect(todoStepProgress([
      { id: "1", content: "done", status: "completed" },
      { id: "2", content: "skip", status: "abandoned" },
      { id: "3", content: "next", status: "pending" },
    ])).toEqual({ current: 2, total: 2, completed: 1 });
  });

  it("reads latest-turn files even while streaming, and todos from the whole session", () => {
    const write = {
      toolCallId: "write-live",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "docs/UPSTREAM-SYNC.md", content: "a\nb" },
    };
    const progress = sessionTaskProgress([
      { type: "user", itemId: "u1", createdAt: "2026-08-15T00:00:01.000Z", text: "先列任务" },
      {
        type: "assistant",
        itemId: "a1",
        createdAt: "2026-08-15T00:00:02.000Z",
        status: "completed",
        presentation: "reply",
        segments: [{ type: "batch", key: "b1", tools: [todoTool("todo-1", [{ name: "文档", tasks: [{ content: "写文档", status: "doing" }] }])] }],
      },
      { type: "user", itemId: "u2", createdAt: "2026-08-15T00:00:03.000Z", text: "继续改文件" },
      {
        type: "assistant",
        itemId: "a2",
        createdAt: "2026-08-15T00:00:04.000Z",
        status: "streaming",
        presentation: "process",
        segments: [{ type: "batch", key: "b2", tools: [write] }],
      },
    ]);
    expect(progress.todos).toEqual([{ id: "文档-0", content: "写文档", status: "in_progress", phase: "文档" }]);
    expect(progress.files).toMatchObject([
      { path: "docs/UPSTREAM-SYNC.md", name: "UPSTREAM-SYNC.md", dir: "docs/", add: 2, del: 0, status: "added", note: "Write" },
    ]);
  });

  it("hides a completed-only todo list, and drops previous-turn files after a new user prompt", () => {
    const write = {
      toolCallId: "write-1",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "docs/a.md", content: "x" },
    };
    const finished = [
      { type: "user" as const, itemId: "u1", createdAt: "2026-08-15T00:00:01.000Z", text: "写文档" },
      {
        type: "assistant" as const,
        itemId: "a1",
        createdAt: "2026-08-15T00:00:02.000Z",
        status: "completed" as const,
        presentation: "reply" as const,
        segments: [{
          type: "batch" as const,
          key: "b1",
          tools: [
            todoTool("todo-1", [{ name: "文档", tasks: [{ content: "写文档", status: "done" }] }]),
            write,
          ],
        }],
      },
    ];
    const afterTurn = sessionTaskProgress(finished);
    expect(afterTurn.todos).toEqual([]);
    expect(afterTurn.files.map((file) => file.path)).toEqual(["docs/a.md"]);
    expect(sessionTaskProgress([
      ...finished,
      { type: "user", itemId: "u2", createdAt: "2026-08-15T00:00:03.000Z", text: "下一件事" },
    ])).toEqual({ todos: [], files: [] });
  });

  it("keeps open todos after a new user prompt, like the OMP HUD", () => {
    const write = {
      toolCallId: "write-1",
      toolName: "write",
      status: "succeeded" as const,
      arguments: { path: "docs/a.md", content: "x" },
    };
    const progress = sessionTaskProgress([
      { type: "user", itemId: "u1", createdAt: "2026-08-15T00:00:01.000Z", text: "列任务" },
      {
        type: "assistant",
        itemId: "a1",
        createdAt: "2026-08-15T00:00:02.000Z",
        status: "completed",
        presentation: "reply",
        segments: [{
          type: "batch",
          key: "b1",
          tools: [
            todoTool("todo-1", [{ name: "文档", tasks: [{ content: "写文档", status: "doing" }] }]),
            write,
          ],
        }],
      },
      { type: "user", itemId: "u2", createdAt: "2026-08-15T00:00:03.000Z", text: "继续" },
    ]);
    expect(progress.todos).toEqual([{ id: "文档-0", content: "写文档", status: "in_progress", phase: "文档" }]);
    expect(progress.files).toEqual([]);
  });
});

describe("xd:// mount notice", () => {
  const mountedNotice =
    "xd://: mounted mcp__blender_get_scene_info, mcp__blender_execute_blender_code, mcp__sts_get_game_state";

  function paneWithNotices(messages: string[]) {
    const state = {
      ...resetConversation(1, identity, "ready"),
      notices: messages.map((message, index) => ({ id: `n${index}`, level: "info" as const, message })),
    };
    return render(
      <ConversationPane
        snapshot={{ state, rows: buildTimeline(state), demo: false, loadingOlder: false, identityKey: "notice-test" }}
        onLoadOlder={() => {}}
      />,
    );
  }

  it("parses mounted/unmounted groups from the runtime notice text", () => {
    expect(parseXdevMountNotice("xd://: mounted a, b")).toEqual({ mounted: ["a", "b"] });
    expect(parseXdevMountNotice("xd://: unmounted c")).toEqual({ unmounted: ["c"] });
    expect(parseXdevMountNotice("xd://: mounted a; unmounted b, c")).toEqual({ mounted: ["a"], unmounted: ["b", "c"] });
    expect(parseXdevMountNotice("xd://: reboot required")).toBeNull();
    expect(parseXdevMountNotice("正在同步压缩摘要")).toBeNull();
  });

  it("collapses the mounted tool list behind a titled toggle by default", () => {
    const { container } = paneWithNotices([mountedNotice]);
    const toggle = screen.getByRole("button", { name: /已挂载 · 3 个工具/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".convo-notice.xdev-mount.open")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".convo-notice.xdev-mount.open")).not.toBeNull();
    expect(screen.getByText("mcp__blender_get_scene_info")).toBeTruthy();
    expect(screen.getByText("mcp__sts_get_game_state")).toBeTruthy();
  });

  it("keeps non-xdev notices as plain text", () => {
    paneWithNotices(["正在同步压缩摘要"]);
    expect(screen.getByText("正在同步压缩摘要")).toBeTruthy();
  });

  it("does not render Fast / Prewalk status notices in the transcript", () => {
    paneWithNotices([
      "The current model has no service-tier control for /fast to toggle.",
      "Prewalk: target sub2api-go/mimo-v2.5 already matches the active model and thinking level; nothing to switch.",
      "正在同步压缩摘要",
    ]);
    expect(screen.queryByText(/no service-tier control/)).toBeNull();
    expect(screen.queryByText(/already matches the active model/)).toBeNull();
    expect(screen.getByText("正在同步压缩摘要")).toBeTruthy();
  });

  it("does not render Retry N/M notices in the transcript; they belong on the activity line", () => {
    const state = {
      ...resetConversation(1, identity, "ready"),
      notices: [{ id: "n0", level: "warning" as const, message: "Retry 5/10", source: "retry" }],
    };
    const { container } = render(
      <ConversationPane
        snapshot={{ state, rows: buildTimeline(state), demo: false, loadingOlder: false, identityKey: "retry-notice" }}
        onLoadOlder={() => {}}
        activity={{ status: { phase: "waiting", label: "working", retry: { attempt: 5, maxAttempts: 10 } } }}
      />,
    );
    expect(container.querySelector(".convo-notice")).toBeNull();
    expect(container.querySelector(".al-retry")?.textContent).toBe("Retry 5/10");
  });

  it("does not render auto_retry_end notices in the transcript", () => {
    const state = {
      ...resetConversation(1, identity, "ready"),
      notices: [{ id: "n0", level: "warning" as const, message: "Retry cancelled", source: "retry-end" }],
    };
    const { container } = render(
      <ConversationPane
        snapshot={{ state, rows: buildTimeline(state), demo: false, loadingOlder: false, identityKey: "retry-end" }}
        onLoadOlder={() => {}}
      />,
    );
    expect(container.querySelector(".convo-notice")).toBeNull();
  });
});

describe("conversation activity line", () => {
  it("renders working at the bottom of the scroll document", () => {
    const state = resetConversation(1, identity, "ready");
    const { container } = render(
      <ConversationPane
        snapshot={{ state, rows: buildTimeline(state), demo: false, loadingOlder: false, identityKey: "activity-test" }}
        onLoadOlder={() => {}}
        activity={{ status: { phase: "waiting", label: "working" }, startedAt: Date.now() }}
      />,
    );
    const line = container.querySelector(".activity-line");
    expect(line?.getAttribute("data-phase")).toBe("waiting");
    expect(line?.textContent).toContain("working");
    expect(container.querySelector(".al-op")).toBeNull();
  });

  it("keeps the activity line on the empty welcome surface so send is not silent", () => {
    const state = resetConversation(1, identity, "ready");
    const { container } = render(
      <ConversationPane
        snapshot={{ state, rows: [], demo: false, loadingOlder: false, identityKey: "activity-welcome" }}
        onLoadOlder={() => {}}
        forceWelcome
        welcome={<div>开始一段对话</div>}
        activity={{ status: { phase: "waiting", label: "working" } }}
      />,
    );
    expect(screen.getByText("开始一段对话")).toBeTruthy();
    expect(container.querySelector(".activity-line")?.textContent).toContain("working");
  });
});

describe("user message restore", () => {
  it("shows restore on a committed user row and reports itemId plus text", () => {
    const onRestoreUserMessage = vi.fn();
    render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-restore",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "打开 src/app.ts",
        }}
        onRestoreUserMessage={onRestoreUserMessage}
      />,
    );
    const restore = screen.getByRole("button", { name: "恢复" });
    expect(restore.innerHTML).toContain("M2.5 8a5.5 5.5 0 1 1 1.6 3.9");
    fireEvent.click(restore);
    expect(onRestoreUserMessage).toHaveBeenCalledWith("u-restore", "打开 src/app.ts");
  });

  it("shows branch on a committed user row", () => {
    const onBranchUserMessage = vi.fn();
    render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-branch",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "打开 src/app.ts",
        }}
        onRestoreUserMessage={() => {}}
        onBranchUserMessage={onBranchUserMessage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "新会话" }));
    expect(onBranchUserMessage).toHaveBeenCalledWith("u-branch", "打开 src/app.ts");
  });

  it("disables restore when a busy reason is provided", () => {
    const onRestoreUserMessage = vi.fn();
    render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-busy",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "busy",
        }}
        onRestoreUserMessage={onRestoreUserMessage}
        userRestoreDisabledReason="进行中"
      />,
    );
    const button = screen.getByRole("button", { name: "恢复" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("data-tip")).toBe("进行中");
    fireEvent.click(button);
    expect(onRestoreUserMessage).not.toHaveBeenCalled();
  });

  it("disables branch when a branch disabled reason is provided", () => {
    const onBranchUserMessage = vi.fn();
    render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "u-busy-branch",
          createdAt: "2026-08-15T00:00:00.000Z",
          text: "busy",
        }}
        onBranchUserMessage={onBranchUserMessage}
        userBranchDisabledReason="创建中"
      />,
    );
    const button = screen.getByRole("button", { name: "新会话" });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("data-tip")).toBe("创建中");
    fireEvent.click(button);
    expect(onBranchUserMessage).not.toHaveBeenCalled();
  });

  it("keeps failed-pending on the draft restore button and does not navigate", () => {
    const onRestore = vi.fn();
    const onRestoreUserMessage = vi.fn();
    render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "pending:req-1",
          createdAt: "",
          text: "hello",
          pending: "failed",
          requestId: "req-1",
          error: "rejected",
        }}
        onRestore={onRestore}
        onRestoreUserMessage={onRestoreUserMessage}
        onBranchUserMessage={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "恢复到输入框" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新会话" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "恢复到输入框" }));
    expect(onRestore).toHaveBeenCalledWith("req-1");
    expect(onRestoreUserMessage).not.toHaveBeenCalled();
  });

  it("hides restore on a still-sending pending row", () => {
    render(
      <ConversationItemView
        row={{
          type: "user",
          itemId: "pending:req-2",
          createdAt: "",
          text: "hello",
          pending: "pending",
          requestId: "req-2",
        }}
        onRestoreUserMessage={() => {}}
        onBranchUserMessage={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
    expect(screen.queryByRole("button", { name: "新会话" })).toBeNull();
  });

  it("reload replaces the timeline with the new active branch", async () => {
    const client = new FakeClient();
    client.auto = page({
      items: [userItem("u1", "one"), assistantItem("a1", "two"), userItem("u2", "three")],
    });
    const engine = engineOf(client);
    engine.start();
    await tick();
    expect(engine.getSnapshot().state.items.map((item) => item.itemId)).toEqual(["u1", "a1", "u2"]);
    client.auto = page({ items: [userItem("u1", "one")] });
    await engine.reload();
    expect(engine.getSnapshot().state.items.map((item) => item.itemId)).toEqual(["u1"]);
    expect(engine.getSnapshot().rows.some((row) => row.type === "user" && row.itemId === "u2")).toBe(false);
    engine.dispose();
  });

  it("preview restoreFromUser drops the target user and later rows without querying Host", async () => {
    const client = new FakeClient();
    const engine = engineOf(client, { preview: true, identity: PREVIEW_CONVO_IDENTITY });
    engine.start();
    await tick();
    expect(client.reads).toEqual([]);
    expect(engine.restoreFromUser("preview-user-1")).toBe(true);
    const snap = engine.getSnapshot();
    expect(snap.state.items.map((item) => item.itemId)).toEqual(["preview-reset-1"]);
    expect(snap.rows.some((row) => row.type === "user")).toBe(false);
    expect(Object.keys(snap.state.liveMessages)).toEqual([]);
    expect(client.reads).toEqual([]);
    engine.dispose();
  });
});

describe("compaction timeline", () => {
  it("turns compaction.started into an in-progress divider, then the summary bar on completed", () => {
    let state = resetConversation(1, identity, "ready");
    state = applyLiveEvent(state, {
      kind: "conversation.compaction.started",
      sessionId: session,
      action: "context-full",
    }, identity, 1);
    expect(state.compacting).toEqual({ action: "context-full" });
    expect(state.notices).toEqual([]);
    const pending = buildTimeline(state);
    expect(pending).toEqual([{ type: "compacting", action: "context-full" }]);

    state = applyLiveEvent(state, {
      kind: "conversation.compaction.completed",
      sessionId: session,
      aborted: false,
      item: {
        kind: "compaction",
        itemId: "cp-1",
        parentId: null,
        createdAt: "2026-08-19T00:00:00.000Z",
        summary: "Earlier turns were summarized.",
        shortSummary: "Summarized history",
      },
    }, identity, 2);
    expect(state.compacting).toBeUndefined();
    const done = buildTimeline(state);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      type: "compaction",
      item: { itemId: "cp-1", shortSummary: "Summarized history" },
    });
  });

  it("clears the in-progress divider and surfaces abort without a fake summary", () => {
    let state = resetConversation(1, identity, "ready");
    state = applyLiveEvent(state, {
      kind: "conversation.compaction.started",
      sessionId: session,
      action: "manual",
    }, identity);
    state = applyLiveEvent(state, {
      kind: "conversation.compaction.completed",
      sessionId: session,
      aborted: true,
    }, identity);
    expect(state.compacting).toBeUndefined();
    expect(buildTimeline(state).some((row) => row.type === "compacting" || row.type === "compaction")).toBe(false);
    expect(state.notices.some((notice) => notice.message === "上下文压缩已中止")).toBe(true);
  });

  it("paints 压缩中 from the compacting prop even without a live start event", () => {
    const state = resetConversation(1, identity, "ready");
    render(
      <ConversationPane
        snapshot={{ state, rows: [], demo: false, loadingOlder: false, identityKey: "compact-pending" }}
        onLoadOlder={() => {}}
        compacting
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("压缩中");
  });

  it("replaces the in-progress divider with the compact summary in the transcript", () => {
    const pending = withCompactingRow([], true);
    render(<ConvoTranscript rows={pending} />);
    expect(screen.getByText("压缩中")).toBeTruthy();
    cleanup();
    render(
      <ConvoTranscript
        rows={[{
          type: "compaction",
          item: {
            kind: "compaction",
            itemId: "cp-1",
            parentId: null,
            createdAt: "t",
            summary: "Earlier turns were summarized.",
            shortSummary: "Summarized history",
          },
        }]}
      />,
    );
    expect(screen.queryByText("压缩中")).toBeNull();
    expect(screen.getByText(/Summarized history/)).toBeTruthy();
    expect(screen.queryByText("Earlier turns were summarized.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /展开详情/ }));
    expect(screen.getByText("Earlier turns were summarized.")).toBeTruthy();
  });

  it("keeps snapcompact HISTORY folded until the compact bar is opened", () => {
    const summary = [
      "You are resuming a prior conversation. Its earlier turns were archived to reclaim context and are reproduced under HISTORY below, oldest to newest.",
      "",
      "The archived transcript uses compact scopes:",
      "- `¶user:`, `¶think:`, `¶ai:`, and `¶call:` open user, assistant reasoning, assistant reply, and tool-call scopes.",
      "",
      "FILES",
      "===================",
      "package.json (Read)",
      "",
      "HISTORY",
      "===================",
    ].join("\n");
    render(
      <ConvoTranscript
        rows={[{
          type: "compaction",
          item: {
            kind: "compaction",
            itemId: "cp-snap",
            parentId: null,
            createdAt: "t",
            summary,
            shortSummary: "Compacted from 114,276 tokens",
          },
        }]}
      />,
    );
    expect(screen.getByText(/Compacted from 114,276 tokens/)).toBeTruthy();
    expect(screen.queryByText(/You are resuming a prior conversation/)).toBeNull();
    expect(screen.queryByText(/package\.json \(Read\)/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /展开详情/ }));
    expect(screen.getByText(/You are resuming a prior conversation/)).toBeTruthy();
    expect(screen.getByText(/package\.json \(Read\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /收起详情/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("appends 压缩中 after an existing compact summary on a later compact", () => {
    const rows = withCompactingRow([{
      type: "compaction",
      item: {
        kind: "compaction",
        itemId: "cp-old",
        parentId: null,
        createdAt: "t",
        summary: "Older turns were summarized.",
        shortSummary: "Older history",
      },
    }], true);
    expect(rows.map((row) => row.type)).toEqual(["compaction", "compacting"]);
    render(<ConvoTranscript rows={rows} />);
    expect(screen.getByText(/Older history/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("压缩中");
  });

  it("keeps the completed tool expanded during streaming while waiting for the model reply", () => {
    const tool: ToolView = {
      toolCallId: "t1",
      toolName: "read",
      status: "succeeded",
      output: "file contents",
    };
    const row: TimelineRow = {
      type: "assistant",
      itemId: "m1",
      createdAt: "2026-08-15T00:00:01.000Z",
      status: "streaming",
      turnOpen: true,
      segments: [{ type: "batch", key: "b1", tools: [tool] }],
    };
    const { rerender } = render(<ConvoTranscript rows={[row]} />);
    // 工具已成功执行完毕，但因为处于 liveTail（等待模型回复），工具卡片保持展开
    const toolToggle = screen.getByRole("button", { name: /Read/ });
    expect(toolToggle.getAttribute("aria-expanded")).toBe("true");

    // 当模型开始输出下一段思考时，上一条工具收起，思考卡片展开
    const rowWithThink: TimelineRow = {
      type: "assistant",
      itemId: "m1",
      createdAt: "2026-08-15T00:00:01.000Z",
      status: "streaming",
      turnOpen: true,
      segments: [
        { type: "batch", key: "b1", tools: [tool] },
        { type: "thinking", key: "th1", text: "模型正在思考下一步..." },
      ],
    };
    rerender(<ConvoTranscript rows={[rowWithThink]} />);
    expect(screen.getByRole("button", { name: /Read/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: /Think/ }).getAttribute("aria-expanded")).toBe("true");

    // 当模型开始输出正文回复时，工具链整体收起
    const rowWithText: TimelineRow = {
      type: "assistant",
      itemId: "m1",
      createdAt: "2026-08-15T00:00:01.000Z",
      status: "streaming",
      turnOpen: true,
      segments: [
        { type: "batch", key: "b1", tools: [tool] },
        { type: "text", key: "txt1", text: "这是最终的模型回复。" },
      ],
    };
    rerender(<ConvoTranscript rows={[rowWithText]} />);
    expect(screen.getByRole("button", { name: /Read/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("这是最终的模型回复。")).toBeTruthy();
  });
});


