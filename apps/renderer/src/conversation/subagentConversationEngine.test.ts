import { describe, expect, it, vi } from "vitest";
import { conversationPages } from "@omp-studio/testkit";
import type { AgentId, SessionId } from "@omp-studio/studio-protocol";
import { createSubagentConversationEngine } from "./subagentConversationEngine";

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
});
