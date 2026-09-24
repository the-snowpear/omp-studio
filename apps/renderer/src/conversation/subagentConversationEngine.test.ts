import { describe, expect, it, vi } from "vitest";
import { conversationPages } from "@omp-studio/testkit";
import type { AgentId, SessionId } from "@omp-studio/studio-protocol";
import { activeSubagentConversationEngineCount, createSubagentConversationEngine } from "./subagentConversationEngine";

describe("subagentConversationEngine", () => {
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
