import { describe, expect, it, vi } from "vitest";
import type { ClientEvent, ConversationTranscriptPage, OpaqueCursor, SessionId } from "@omp-studio/client-contract";
import {
  CONVERSATION_FIXTURE_IDS,
  conversationChangedEvent,
  conversationPages,
} from "@omp-studio/testkit";
import { createSubagentConversationEngine, type SubagentConversationClient } from "./subagentConversationEngine";
import { previewSubagentConversationItems } from "../preview/subagentConversation";

const PAGE = conversationPages.userAssistant;
const CHILD_SESSION = PAGE.sessionId;
const OTHER_SESSION = "sess-other" as SessionId;

function started(sessionId: SessionId, eventSeq: number, messageId: string): ClientEvent {
  return conversationChangedEvent(
    {
      kind: "conversation.message.started",
      sessionId,
      turnId: "turn-live",
      messageId,
      role: "assistant",
      createdAt: "2026-08-17T00:00:01.000Z",
    },
    eventSeq,
  );
}

function resyncEvent(): ClientEvent {
  return {
    kind: "resync.required",
    authorityEpoch: CONVERSATION_FIXTURE_IDS.authorityEpoch,
    runtimeEpoch: CONVERSATION_FIXTURE_IDS.runtimeEpoch,
    stateVersion: 41 as never,
    cursor: "c-resync" as never,
    occurredAt: "2026-08-17T00:00:02.000Z",
    reason: "conversation mapping failed; re-read open transcripts",
  };
}

async function ready(engine: ReturnType<typeof createSubagentConversationEngine>): Promise<void> {
  await vi.waitFor(() => {
    expect(engine.getSnapshot().state.hydrateStatus).toBe("ready");
  });
}

describe("createSubagentConversationEngine", () => {
  it("uses preview fixtures and never queries Host", () => {
    const query = vi.fn();
    const client: SubagentConversationClient = {
      query,
      subscribe: () => () => undefined,
    };
    const engine = createSubagentConversationEngine({
      preview: true,
      previewItems: previewSubagentConversationItems("agent-019fcb01"),
      client,
      target: { agentId: "agent-019fcb01", toolCallId: "t1", task: "audit" },
      runtimeConnected: true,
    });
    engine.start();
    const snapshot = engine.getSnapshot();
    expect(snapshot.demo).toBe(true);
    expect(snapshot.rows.length).toBeGreaterThan(0);
    expect(query).not.toHaveBeenCalled();
    engine.dispose();
  });

  it("subscribes before querying and replays buffered matching events", async () => {
    let listener: ((event: ClientEvent) => void) | undefined;
    let resolvePage!: (page: ConversationTranscriptPage) => void;
    const page = new Promise<ConversationTranscriptPage>((resolve) => {
      resolvePage = resolve;
    });
    const client: SubagentConversationClient = {
      query: vi.fn(async () => page) as SubagentConversationClient["query"],
      subscribe: (_scope, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    };
    const engine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client,
      target: { agentId: "agent-019fcb01", toolCallId: "t1" },
      runtimeConnected: true,
    });
    engine.start();
    expect(client.query).toHaveBeenCalledWith("agent.conversation.read", { agentId: "agent-019fcb01", limit: 50 });
    listener?.(started(CHILD_SESSION, 8, "live-8"));
    listener?.(started(OTHER_SESSION, 9, "live-9"));
    resolvePage(PAGE);
    await ready(engine);
    const snapshot = engine.getSnapshot();
    expect(snapshot.state.identity?.sessionId).toBe(CHILD_SESSION);
    expect(snapshot.state.liveOrder).toContain("live-8");
    expect(snapshot.state.liveOrder).not.toContain("live-9");
    engine.dispose();
  });

  it("re-reads after buffer overflow and after a global resync.required", async () => {
    let listener: ((event: ClientEvent) => void) | undefined;
    const query = vi.fn(async () => PAGE) as unknown as SubagentConversationClient["query"];
    const client: SubagentConversationClient = {
      query,
      subscribe: (_scope, next) => {
        listener = next;
        return () => undefined;
      },
    };
    const engine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client,
      target: { agentId: "agent-019fcb01", toolCallId: "t1" },
      runtimeConnected: true,
    });
    engine.start();
    await ready(engine);
    listener?.(resyncEvent());
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledTimes(2);
    });

    let resolveLate!: (page: ConversationTranscriptPage) => void;
    const late = new Promise<ConversationTranscriptPage>((resolve) => {
      resolveLate = resolve;
    });
    (query as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => late);
    const overflowEngine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client,
      target: { agentId: "agent-019fcb01", toolCallId: "t1" },
      runtimeConnected: true,
    });
    overflowEngine.start();
    for (let index = 0; index < 129; index += 1) {
      listener?.(started(CHILD_SESSION, 20 + index, `overflow-${index}`));
    }
    resolveLate(PAGE);
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledTimes(4);
    });
    engine.dispose();
    overflowEngine.dispose();
  });

  it("prepends an older page and treats CURSOR_STALE as a latest-page reload", async () => {
    const olderItem = {
      kind: "message" as const,
      itemId: "older-1",
      parentId: null,
      createdAt: "2026-08-17T00:00:00.000Z",
      role: "user" as const,
      content: [{ type: "text" as const, text: "earlier" }],
    };
    const first: ConversationTranscriptPage = {
      ...PAGE,
      hasMoreBefore: true,
      olderCursor: "older-cursor" as OpaqueCursor,
    };
    const older: ConversationTranscriptPage = {
      ...PAGE,
      items: [olderItem],
      hasMoreBefore: false,
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(Object.assign(new Error("stale"), { code: "CURSOR_STALE" }))
      .mockResolvedValueOnce(PAGE) as unknown as SubagentConversationClient["query"];
    const client: SubagentConversationClient = {
      query,
      subscribe: () => () => undefined,
    };
    const engine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client,
      target: { agentId: "agent-019fcb01", toolCallId: "t1" },
      runtimeConnected: true,
    });
    engine.start();
    await ready(engine);
    await engine.loadOlder();
    await vi.waitFor(() => {
      expect(query).toHaveBeenCalledTimes(3);
      expect(engine.getSnapshot().state.hydrateStatus).toBe("ready");
    });
    engine.dispose();
  });

  it("ignores a late page after dispose", async () => {
    let resolvePage!: (page: ConversationTranscriptPage) => void;
    const page = new Promise<ConversationTranscriptPage>((resolve) => {
      resolvePage = resolve;
    });
    const client: SubagentConversationClient = {
      query: vi.fn(async () => page) as SubagentConversationClient["query"],
      subscribe: () => () => undefined,
    };
    const engine = createSubagentConversationEngine({
      preview: false,
      previewItems: [],
      client,
      target: { agentId: "agent-019fcb01", toolCallId: "t1" },
      runtimeConnected: true,
    });
    engine.start();
    engine.dispose();
    resolvePage(PAGE);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getSnapshot().state.hydrateStatus).toBe("loading");
    expect(engine.getSnapshot().state.identity).toBeNull();
  });
});
