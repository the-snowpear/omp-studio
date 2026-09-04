import { describe, expect, it } from "vitest";
import type { ConversationMessageItem, ConversationRuntimeEvent, SessionId } from "@omp-studio/client-contract";
import { ConversationStore } from "./conversationStore";
import { subagentTurnRunning } from "./subagentComposerGate";
import { timelineStructureToken } from "./conversationViewModel";

function item(id: string, role: "user" | "assistant", text: string): ConversationMessageItem {
  return { kind: "message", itemId: id, parentId: null, createdAt: id, role, content: [{ type: "text", text }] };
}
function started(sessionId: SessionId, messageId: string, turnId = "turn"): ConversationRuntimeEvent {
  return { kind: "conversation.message.started", sessionId, turnId, messageId, role: "assistant", createdAt: messageId };
}
function delta(sessionId: SessionId, messageId: string, value: string, turnId = "turn"): ConversationRuntimeEvent {
  return { kind: "conversation.message.delta", sessionId, turnId, messageId, blockId: "text", blockType: "text", delta: value };
}
function scheduler() {
  let next = 1; let time = 0; const callbacks = new Map<number, () => void>();
  return {
    frame: { request(callback: () => void) { const id = next++; callbacks.set(id, callback); return id; }, cancel(id: number | ReturnType<typeof setTimeout>) { callbacks.delete(id as number); }, now: () => time },
    flush(step = 1000 / 60) { time += step; const queued = [...callbacks.values()]; callbacks.clear(); for (const callback of queued) callback(); },
    get size() { return callbacks.size; },
  };
}
function create(session = "session") {
  const frames = scheduler(); const sessionId = session as SessionId;
  return { sessionId, frames, store: new ConversationStore({ target: { sessionId }, identity: { sessionId }, generation: 1, scheduler: frames.frame }) };
}

describe("ConversationStore", () => {
  it("hydrates, prepends without duplicates, and preserves oldest-to-newest order", () => {
    const { store } = create();
    store.hydrate({ items: [item("b", "assistant", "B")], olderCursor: "older" as never, headCursor: "head" as never, hasMoreBefore: true });
    store.prepend({ items: [item("a", "user", "A"), item("b", "assistant", "duplicate")], headCursor: "head" as never, hasMoreBefore: false });
    expect(store.getSnapshot().state.items.map((entry) => entry.itemId)).toEqual(["a", "b"]);
    expect(store.getSnapshot().rows.map((row) => row.type)).toEqual(["user", "assistant"]);
  });

  it("converges a live message by exact message id and leaves unrelated row identities stable", () => {
    const { store, sessionId, frames } = create(); const settled = item("settled", "user", "hello");
    store.hydrate({ items: [settled], headCursor: "head" as never, hasMoreBefore: false }); const first = store.getSnapshot().rows[0];
    store.applyEvent(started(sessionId, "live"), 1); store.applyEvent(delta(sessionId, "live", "answer"), 2); frames.flush();
    expect(store.getSnapshot().rows[0]).toBe(first); expect(store.getSnapshot().state.liveMessages.live?.blocks[0]?.text).toBe("answer");
    store.applyEvent({ kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "live", item: item("live", "assistant", "answer") }, 3); frames.flush();
    expect(store.getSnapshot().state.liveMessages.live).toBeUndefined(); expect(store.getSnapshot().state.items.at(-1)?.itemId).toBe("live");
  });

  it("marks an aborted live row, settles its tools, and drops them when the next turn opens", () => {
    const { store, sessionId, frames } = create(); store.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1);
    store.applyEvent({ kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "live", toolCallId: "tool", toolName: "bash", startedAt: "now" }, 2);
    store.applyEvent({ kind: "conversation.turn.aborted", sessionId, turnId: "turn" }, 3); frames.flush();
    expect(store.getSnapshot().rows[0]).toMatchObject({ type: "assistant", status: "aborted" });
    // The aborted row stays on screen until the next turn opens, so its tools
    // stay addressable there with a terminal status instead of vanishing.
    expect(store.getSnapshot().state.liveTools.tool).toMatchObject({ toolCallId: "tool", status: "aborted" });
    store.applyEvent(started(sessionId, "next", "turn-2"), 4); frames.flush();
    expect(store.getSnapshot().state.liveTools).toEqual({});
  });

  it("folds results settled before an abort into their persisted owner", () => {
    const { store, sessionId, frames } = create(); store.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1);
    store.applyEvent({ kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "live", toolCallId: "tool", toolName: "bash", startedAt: "now" }, 2);
    store.applyEvent({ kind: "conversation.tool.completed", sessionId, turnId: "turn", toolCallId: "tool", result: { type: "toolResult", toolCallId: "tool", isError: false, output: "ok" }, completedAt: "now" }, 3);
    store.applyEvent({ kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "live", item: { kind: "message", itemId: "live", parentId: null, createdAt: "live", role: "assistant", content: [{ type: "toolCall", toolCallId: "tool", toolName: "bash" }] } }, 4);
    store.applyEvent({ kind: "conversation.turn.aborted", sessionId, turnId: "turn" }, 5); frames.flush();
    const persisted = store.getSnapshot().state.items.at(-1);
    expect(persisted?.kind === "message" && persisted.content.some((block) => block.type === "toolResult" && block.toolCallId === "tool")).toBe(true);
    expect(store.getSnapshot().state.liveTools).toEqual({});
  });

  it("settles turns the Runtime never closed, so an errored run stops reading as live", () => {
    // A retryable provider error parks the logical turn (`agent_end{isTerminal:
    // false}`) and a user abort supersedes the continuation that would have closed
    // it: no `turn.completed` / `turn.aborted` ever arrives, and the leftover
    // `openTurnItems` / folded tools keep every run surface believing the session
    // is still streaming until the store is rebuilt by a session switch.
    const { store, sessionId, frames } = create(); store.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1);
    store.applyEvent({ kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "live", toolCallId: "tool", toolName: "bash", startedAt: "now" }, 2);
    store.applyEvent({ kind: "conversation.tool.completed", sessionId, turnId: "turn", toolCallId: "tool", result: { type: "toolResult", toolCallId: "tool", isError: false, output: "ok" }, completedAt: "now" }, 3);
    store.applyEvent({ kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "live", item: { kind: "message", itemId: "live", parentId: null, createdAt: "live", role: "assistant", content: [{ type: "toolCall", toolCallId: "tool", toolName: "bash" }] }, error: { message: "400 provider exploded" } }, 4);
    frames.flush();
    const stuck = store.getSnapshot().state;
    expect(stuck.liveMessages).toEqual({});
    expect(Object.keys(stuck.openTurnItems)).toEqual(["live"]);
    expect(subagentTurnRunning(stuck)).toBe(true);
    expect(store.settleOpenTurns()).toBe(true);
    const settled = store.getSnapshot().state;
    expect(settled.openTurnItems).toEqual({});
    expect(settled.liveTools).toEqual({});
    expect(subagentTurnRunning(settled)).toBe(false);
    // The tool result still has to survive as history on its persisted owner.
    const persisted = settled.items.at(-1);
    expect(persisted?.kind === "message" && persisted.content.some((block) => block.type === "toolResult" && block.toolCallId === "tool")).toBe(true);
    expect(store.settleOpenTurns()).toBe(false);
  });

  it("exposes resync state immediately", () => {
    const { store } = create(); store.requireResync("gap");
    expect(store.getSnapshot().state).toMatchObject({ hydrateStatus: "resyncing", resyncRequired: true });
  });

  it("coalesces 1000 deltas into one full publish and zero metadata publishes", () => {
    const { store, sessionId, frames } = create(); store.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1); frames.flush();
    let full = 0; let metadata = 0; store.subscribe(() => { full += 1; }); store.subscribeMetadata(() => { metadata += 1; });
    for (let index = 0; index < 1_000; index += 1) store.applyEvent(delta(sessionId, "live", "x"), index + 2);
    expect(frames.size).toBe(1); frames.flush(); expect(full).toBe(1); expect(metadata).toBe(0);
  });

  it("caps high-frequency streaming publishes at the configured cadence without rebuilding the store", () => {
    const { store, sessionId, frames } = create();
    store.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1); frames.flush();
    let publishes = 0; store.subscribe(() => { publishes += 1; });
    for (let index = 0; index < 8; index += 1) {
      store.applyEvent(delta(sessionId, "live", "x"), index + 2);
      frames.flush(1000 / 120);
    }
    expect(publishes).toBeLessThanOrEqual(4);
    store.applyEvent({ kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "live", item: item("live", "assistant", "done") }, 10);
    frames.flush(1000 / 120);
    expect(store.getSnapshot().state.items.at(-1)?.itemId).toBe("live");
  });

  it("enforces every supported streaming cadence", () => {
    for (const cadence of [30, 60, 90, 120] as const) {
      const frames = scheduler();
      const sessionId = `cadence-${cadence}` as SessionId;
      const store = new ConversationStore({
        target: { sessionId },
        identity: { sessionId },
        generation: cadence,
        scheduler: frames.frame,
        streamingCadenceHz: () => cadence,
      });
      store.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
      store.applyEvent(started(sessionId, "live"), 1);
      frames.flush();
      const publishedAt: number[] = [];
      store.subscribe(() => { publishedAt.push(frames.frame.now!()); });
      for (let index = 0; index < 120; index += 1) {
        store.applyEvent(delta(sessionId, "live", "x"), index + 2);
        frames.flush(1);
      }
      expect(publishedAt.length).toBeGreaterThan(0);
      for (let index = 1; index < publishedAt.length; index += 1) {
        expect(publishedAt[index]! - publishedAt[index - 1]! + 0.5).toBeGreaterThanOrEqual(1000 / cadence);
      }
      store.dispose();
    }
  });

  it("uses a changed cadence on the next queued stream publish", () => {
    const { store, sessionId, frames } = create();
    let cadence: 30 | 60 | 90 | 120 = 30;
    const dynamic = new ConversationStore({ target: { sessionId: "dynamic" as SessionId }, identity: { sessionId: "dynamic" as SessionId }, generation: 2, scheduler: frames.frame, streamingCadenceHz: () => cadence });
    dynamic.hydrate({ items: [], headCursor: "h" as never, hasMoreBefore: false });
    dynamic.applyEvent(started("dynamic" as SessionId, "live"), 1); frames.flush();
    let publishes = 0; dynamic.subscribe(() => { publishes += 1; });
    dynamic.applyEvent(delta("dynamic" as SessionId, "live", "x"), 2); frames.flush(1000 / 120);
    expect(publishes).toBe(0);
    cadence = 120;
    frames.flush(1000 / 120);
    expect(publishes).toBe(1);
    dynamic.dispose(); store.dispose();
  });

  it("keeps the persisted prefix and transcript structure token stable across token frames", () => {
    const { store, sessionId, frames } = create();
    store.hydrate({ items: [item("settled", "user", "hello")], headCursor: "h" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1); frames.flush();
    const startedSnapshot = store.getSnapshot();
    const token = timelineStructureToken(startedSnapshot.rows);
    const settledRow = startedSnapshot.rows[0];
    store.applyEvent(delta(sessionId, "live", "one"), 2); frames.flush();
    const firstDelta = store.getSnapshot();
    store.applyEvent(delta(sessionId, "live", " two"), 3); frames.flush();
    const secondDelta = store.getSnapshot();
    expect(firstDelta.rows).not.toBe(startedSnapshot.rows);
    expect(secondDelta.rows[0]).toBe(settledRow);
    expect(timelineStructureToken(firstDelta.rows)).toBe(token);
    expect(timelineStructureToken(secondDelta.rows)).toBe(token);
  });

  it("prunes cached rows after hydration and restore remove them from the active window", () => {
    const { store } = create();
    const cacheSize = () => (store as unknown as { rowCache: Map<string, unknown> }).rowCache.size;
    store.hydrate({ items: [item("a", "user", "a"), item("b", "assistant", "b")], headCursor: "h" as never, hasMoreBefore: false });
    expect(cacheSize()).toBe(2);
    store.hydrate({ items: [item("c", "user", "c")], headCursor: "h2" as never, hasMoreBefore: false });
    expect(cacheSize()).toBe(1);
    store.hydrate({ items: [item("a", "assistant", "a"), item("c", "user", "c")], headCursor: "h3" as never, hasMoreBefore: false });
    expect(store.restoreFromUser("c")).toBe(true);
    expect(cacheSize()).toBe(1);
    expect([...((store as unknown as { rowCache: Map<string, unknown> }).rowCache.keys())]).toEqual(["a"]);
  });

  it("cancels a queued frame and all notifications on dispose", () => {
    const { store, sessionId, frames } = create(); let notified = 0; store.subscribe(() => { notified += 1; });
    store.applyEvent(started(sessionId, "live"), 1); expect(frames.size).toBe(1); store.dispose(); expect(frames.size).toBe(0); frames.flush(); expect(notified).toBe(0);
  });

  it("isolates 64 child targets sharing one parent session", () => {
    const sessionId = "shared" as SessionId; const stores = Array.from({ length: 64 }, (_, index) => new ConversationStore({ target: { sessionId, agentId: `agent-${index}` }, identity: { sessionId }, generation: index }));
    const update = { ...started(sessionId, "only-17"), agentId: "agent-17" } as ConversationRuntimeEvent & { agentId: string };
    const accepted = stores.filter((store) => store.applyEvent(update, 1));
    expect(accepted).toHaveLength(1);
    for (const store of stores) store.dispose();
  });

  it("stops pagination when the bounded hot window cannot admit older rows", () => {
    const frames = scheduler(); const sessionId = "bounded" as SessionId;
    const store = new ConversationStore({ target: { sessionId }, identity: { sessionId }, generation: 1, maxRows: 2, scheduler: frames.frame });
    store.hydrate({ items: [item("b", "user", "b"), item("c", "assistant", "c")], olderCursor: "older" as never, headCursor: "h" as never, hasMoreBefore: true });
    store.prepend({ items: [item("a", "user", "a")], olderCursor: "older-2" as never, headCursor: "h" as never, hasMoreBefore: true });
    expect(store.getSnapshot().state.items.map((entry) => entry.itemId)).toEqual(["b", "c"]); expect(store.getSnapshot().state.hasMoreBefore).toBe(false);
    store.applyEvent({ kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "d", item: item("d", "assistant", "d") }, 1); frames.flush();
    expect(store.getSnapshot().state.items.map((entry) => entry.itemId)).toEqual(["c", "d"]);
    expect([...((store as unknown as { rowCache: Map<string, unknown> }).rowCache.keys())]).toEqual(["c", "d"]);
  });

  it("clips a large multibyte tool output without blocking the caller", () => {
    const { store, sessionId, frames } = create();
    store.hydrate({ items: [], headCursor: "head" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1);
    store.applyEvent({ kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "live", toolCallId: "tool", toolName: "bash", startedAt: "now" }, 2);
    // A tool whose partial result is rewritten (progress bar, re-rendered table)
    // arrives as a full `replace` of up to TEXT_BLOCK_MAX_BYTES. On CJK text the
    // old loop-and-re-encode clip took ~14s per event and froze the renderer.
    const output = "国".repeat(90_000);
    const begun = performance.now();
    store.applyEvent({ kind: "conversation.tool.updated", sessionId, turnId: "turn", toolCallId: "tool", updateMode: "replace", output }, 3);
    const elapsed = performance.now() - begun;
    frames.flush();
    const tool = store.getSnapshot().state.liveTools["tool"]!;
    expect(tool.truncated).toBe(true);
    expect(tool.output!.length).toBeLessThan(output.length);
    expect(tool.output!.endsWith("国")).toBe(true);
    expect(elapsed).toBeLessThan(250);
  });

  it("prunes liveOrder when a turn completes, not only when a message completes", () => {
    const { store, sessionId, frames } = create();
    store.hydrate({ items: [], headCursor: "head" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1);
    store.applyEvent(delta(sessionId, "live", "hi"), 2);
    frames.flush();
    expect(store.getSnapshot().state.liveOrder).toEqual(["live"]);
    store.applyEvent({ kind: "conversation.turn.completed", sessionId, turnId: "turn" }, 3);
    frames.flush();
    const state = store.getSnapshot().state;
    expect(state.liveMessages).toEqual({});
    expect(state.liveOrder).toEqual([]);
  });

  it("releases the published snapshots on dispose, not just the working buffers", () => {
    // Clearing `items`/`persistedRows` alone leaves a whole transcript window
    // reachable through the last published snapshot.
    const { store, sessionId, frames } = create();
    store.hydrate({ items: [item("a", "user", "A"), item("b", "assistant", "B")], headCursor: "head" as never, hasMoreBefore: false });
    store.applyEvent(started(sessionId, "live"), 1);
    store.applyEvent({ kind: "conversation.tool.started", sessionId, turnId: "turn", messageId: "live", toolCallId: "tool", toolName: "bash", startedAt: "now" }, 2);
    store.applyEvent(delta(sessionId, "live", "streaming"), 3);
    frames.flush();
    expect(store.getSnapshot().rows.length).toBeGreaterThan(0);
    store.dispose();
    const after = store.getSnapshot();
    expect(after.rows).toEqual([]);
    expect(after.state.items).toEqual([]);
    expect(after.state.liveMessages).toEqual({});
    expect(after.state.liveTools).toEqual({});
    expect(after.state.liveOrder).toEqual([]);
    expect(after.state.openTurnItems).toEqual({});
    // A read racing an unmount must still see a valid, identified conversation.
    expect(after.state.identity).toEqual({ sessionId });
    expect(store.getMetadataSnapshot()).toBe(after);
  });

  it("changes the structure token whenever the row count changes", () => {
    // ConvoTranscript memoises row-count-derived work on this token, so a row
    // count that moves without it would desynchronise itemKeys from rows.
    const { store, sessionId, frames } = create();
    store.hydrate({ items: [item("a", "user", "A")], headCursor: "head" as never, hasMoreBefore: false });
    frames.flush();
    let previous = store.getSnapshot();
    const mutations: Array<() => void> = [
      () => { store.applyEvent(started(sessionId, "live"), 1); },
      () => { store.applyEvent(delta(sessionId, "live", "text"), 2); },
      () => { store.applyEvent({ kind: "conversation.message.completed", sessionId, turnId: "turn", messageId: "live", item: item("live", "assistant", "text") }, 3); },
      () => { store.trackPending({ requestId: "req", text: "next", draft: "next", status: "pending", knownItemIds: [] }); },
      () => { store.applyEvent({ kind: "conversation.compaction.started", sessionId, action: "compact" }, 4); },
    ];
    for (const mutate of mutations) {
      mutate(); frames.flush();
      const snapshot = store.getSnapshot();
      if (snapshot.rows.length !== previous.rows.length) {
        expect(timelineStructureToken(snapshot.rows)).not.toBe(timelineStructureToken(previous.rows));
      }
      previous = snapshot;
    }
  });

  it("reconciles an optimistic user row across hydrate and command-acceptance races", () => {
    const beforeHydrate = create();
    beforeHydrate.store.trackPending({ requestId: "early", text: "next", draft: "next", status: "pending", knownItemIds: [] });
    expect(beforeHydrate.store.getSnapshot().state.pendingUsers).toHaveLength(1);
    beforeHydrate.store.hydrate({ items: [item("user-next", "user", "next")], headCursor: "head" as never, hasMoreBefore: false });
    expect(beforeHydrate.store.getSnapshot().state.pendingUsers).toEqual([]);
    expect(beforeHydrate.store.getSnapshot().rows).toHaveLength(1);

    const afterHydrate = create();
    afterHydrate.store.hydrate({ items: [item("known", "user", "old"), item("user-next", "user", "next")], headCursor: "head" as never, hasMoreBefore: false });
    afterHydrate.store.trackPending({ requestId: "late", text: "next", draft: "next", status: "pending", knownItemIds: ["known"] });
    expect(afterHydrate.store.getSnapshot().state.pendingUsers).toEqual([]);
    expect(afterHydrate.store.getSnapshot().rows).toHaveLength(2);
  });
});
