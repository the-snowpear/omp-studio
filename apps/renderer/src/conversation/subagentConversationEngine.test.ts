import { describe, expect, it, vi } from "vitest";
import { conversationPages } from "@omp-studio/testkit";
import type { AgentId, SessionId } from "@omp-studio/studio-protocol";
import { activeSubagentConversationEngineCount, createSubagentConversationEngine } from "./subagentConversationEngine";

describe("subagentConversationEngine", () => {
  it("keeps two visible child streams independent and only suspends the hidden one", async () => {
    const listeners = new Set<(event: never) => void>();
    const query = vi.fn(async (_name: string, input: { target: { agentId: string } }) => {
      const sessionId = `child-${input.target.agentId}` as SessionId;
      return { target: { kind: "agent", parentSessionId: "parent", agentId: input.target.agentId, conversationSessionId: sessionId },
        page: { ...conversationPages.userAssistant, sessionId }, live: { status: "complete", watermark: 0, events: [] } };
    });
    const client = { query: query as never, subscribe: (_scope: unknown, listener: (event: never) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
    const make = (agentId: string) => createSubagentConversationEngine({ preview: false, previewItems: [], client: client as never, target: { agentId },
      parentSessionId: "parent" as SessionId, liveSessionId: "parent" as SessionId, runtimeConnected: true });
    const first = make("one"), second = make("two");
    first.start(); second.start();
    await vi.waitFor(() => expect([first, second].every(engine => engine.getSnapshot().state.hydrateStatus === "ready")).toBe(true));
    expect(listeners.size).toBe(2);
    const emitGap = (sessionId: string) => { for (const listener of [...listeners]) listener({ kind: "conversation.changed", sessionId, streamSeq: 2,
      update: { kind: "conversation.turn.completed", sessionId, turnId: "turn" } } as never); };
    emitGap("child-one");
    await vi.waitFor(() => expect(query.mock.calls.filter(([, input]) => input.target.agentId === "one")).toHaveLength(2));
    expect(query.mock.calls.filter(([, input]) => input.target.agentId === "two")).toHaveLength(1);
    first.setActive(false, true);
    expect(listeners.size).toBe(1);
    emitGap("child-two");
    await vi.waitFor(() => expect(query.mock.calls.filter(([, input]) => input.target.agentId === "two")).toHaveLength(2));
    expect(first.getSnapshot().state.identity?.sessionId).toBe("child-one");
    expect(second.getSnapshot().state.identity?.sessionId).toBe("child-two");
    first.dispose(); second.dispose();
    expect(listeners.size).toBe(0);
  });
  it("suspends a hidden child without losing text, resynchronizes on reopen and retains text offline", async () => {
    const off = vi.fn();
    const subscribe = vi.fn(() => off);
    const query = vi.fn(async () => ({
      target: { kind: "agent", parentSessionId: "parent", agentId: "worker", conversationSessionId: conversationPages.userAssistant.sessionId },
      page: conversationPages.userAssistant, live: { status: "complete", watermark: 0, events: [] },
    }));
    const engine = createSubagentConversationEngine({ preview: false, previewItems: [], client: { query: query as never, subscribe }, target: { agentId: "worker" },
      parentSessionId: "parent" as SessionId, liveSessionId: "parent" as SessionId, runtimeConnected: true });
    engine.start();
    await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    const rows = engine.getSnapshot().rows;
    engine.setActive(false, true);
    expect(off).toHaveBeenCalledOnce();
    expect(engine.getSnapshot().rows).toBe(rows);
    expect(query).toHaveBeenCalledTimes(1);
    engine.setActive(true, true);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    engine.setActive(true, false);
    expect(engine.getSnapshot().rows).toHaveLength(2);
    expect(query).toHaveBeenCalledTimes(2);
    engine.dispose();
  });

  it("loads older archived child messages from the parent archive, never the active runtime agent", async () => {
    const query = vi.fn(async () => ({ ...conversationPages.userAssistant, olderCursor: "older", hasMoreBefore: true }));
    const engine = createSubagentConversationEngine({ preview: false, previewItems: [], client: { query: query as never, subscribe: () => () => {} }, target: { agentId: "worker" },
      parentSessionId: "history" as SessionId, liveSessionId: "another" as SessionId, runtimeConnected: true });
    engine.start();
    await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    await engine.loadOlder();
    expect(query).toHaveBeenLastCalledWith("session.transcript.readPage", { sessionId: "history", agentId: "worker", cursor: "older", limit: 50 });
    engine.dispose();
  });
  it("opens a live child with explicit parent, agent, and child-session identity", async () => {
    const parentSessionId = "parent" as SessionId;
    const agentId = "worker" as AgentId;
    const query = vi.fn(async (name: string) => {
      if (name !== "conversation.open") throw new Error(name);
      return {
        target: { kind: "agent", parentSessionId, agentId, conversationSessionId: conversationPages.userAssistant.sessionId },
        page: conversationPages.userAssistant,
        live: { status: "complete", watermark: 0, events: [] },
      };
    });
    const engine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client: { query: query as never, subscribe: () => () => undefined },
      target: { agentId, toolCallId: "tool-worker" },
      runtimeConnected: true,
      parentSessionId,
      liveSessionId: parentSessionId,
    });
    engine.start();
    await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    expect(engine.getSnapshot().rows.map((row) => row.type)).toEqual(["user", "assistant"]);
    expect(query).toHaveBeenCalledWith("conversation.open", {
      target: { kind: "agent", parentSessionId, agentId },
      limit: 50,
    });
    engine.dispose();
  });

  it("dispose blanks the published snapshot, keeps identity, and ignores late results (W03)", async () => {
    const parentSessionId = "parent" as SessionId;
    const agentId = "worker" as AgentId;
    let resolveOlder!: (value: unknown) => void;
    const query = vi.fn(async (name: string) => {
      if (name === "conversation.open") {
        return {
          target: { kind: "agent", parentSessionId, agentId, conversationSessionId: conversationPages.userAssistant.sessionId },
          page: { ...conversationPages.userAssistant, olderCursor: "older" },
          live: { status: "complete", watermark: 0, events: [] },
        };
      }
      return new Promise((done) => { resolveOlder = done; });
    });
    const base = activeSubagentConversationEngineCount();
    const engine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client: { query: query as never, subscribe: () => () => undefined },
      target: { agentId, toolCallId: "tool-worker" },
      runtimeConnected: true,
      parentSessionId,
      liveSessionId: parentSessionId,
    });
    expect(activeSubagentConversationEngineCount()).toBe(base + 1);
    let notified = 0;
    engine.subscribe(() => { notified += 1; });
    engine.start();
    await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    const before = engine.getSnapshot();
    expect(before.rows).toHaveLength(2);
    const older = engine.loadOlder();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    const notifiedBefore = notified;
    engine.dispose();
    engine.dispose();
    expect(activeSubagentConversationEngineCount()).toBe(base);
    expect(notified).toBe(notifiedBefore);
    const after = engine.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.rows).toEqual([]);
    expect(after.state.items).toEqual([]);
    // Identity is the resolved child conversation session, exactly as before dispose.
    expect(after.state.identity).toEqual(before.state.identity);
    expect(after.state.identity).toEqual({ sessionId: conversationPages.userAssistant.sessionId, runtimeEpoch: conversationPages.userAssistant.runtimeEpoch });
    expect(after.state.generation).toBe(before.state.generation);
    expect(after.loadingOlder).toBe(false);
    expect(engine.getDiagnostics()).toEqual({ disposed: 1, rows: 0, listeners: 0, openBufferEvents: 0, openBufferBytes: 0 });
    resolveOlder({ ...conversationPages.userAssistant, headCursor: "head2" });
    await older;
    expect(engine.getSnapshot().rows).toEqual([]);
    expect(engine.subscribe(() => undefined)).toBeTypeOf("function");
    expect(engine.getDiagnostics().listeners).toBe(0);
  });
});
