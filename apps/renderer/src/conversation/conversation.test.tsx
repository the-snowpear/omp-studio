import { describe, expect, it, vi } from "vitest";
import type { ConversationOpenResult, RuntimeEpoch, SessionId } from "@omp-studio/studio-protocol";
import type { ConversationClient } from "./conversationHost";
import { createConversationEngine } from "./conversationEngine";

const sessionId = "session" as SessionId;
const epoch = 1 as RuntimeEpoch;
const page = { runtimeEpoch: epoch, sessionId, branchLeafId: null, items: [{ kind: "message", itemId: "user", parentId: null, createdAt: "now", role: "user", content: [{ type: "text", text: "hello" }] }] as const, headCursor: "head" as never, hasMoreBefore: false };
const opened: ConversationOpenResult = { target: { kind: "session", sessionId, conversationSessionId: sessionId }, page, live: { status: "complete", watermark: 0, events: [] } };

function client(query: ConversationClient["query"]): ConversationClient {
  return { query, subscribe: () => () => {} };
}

describe("createConversationEngine", () => {
  it("hydrates from conversation.open and reloads the same target", async () => {
    const query = vi.fn(async () => opened) as unknown as ConversationClient["query"];
    const engine = createConversationEngine({ preview: false, client: client(query), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    engine.start(); await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    expect(engine.getSnapshot().rows[0]).toMatchObject({ type: "user", text: "hello" });
    await engine.reload(); expect(query).toHaveBeenCalledTimes(2); engine.dispose();
  });

  it("falls back to the archive when live open is unavailable", async () => {
    const queryMock = vi.fn(async (name: string) => { if (name === "conversation.open") throw { code: "UNAVAILABLE", message: "offline" }; return { sessionId, transcriptRevision: "r", branchLeafId: null, items: page.items, headCursor: "archive-head", hasMoreBefore: false }; });
    const engine = createConversationEngine({ preview: false, client: client(queryMock as unknown as ConversationClient["query"]), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    engine.start(); await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    expect(queryMock.mock.calls.map((call: readonly unknown[]) => call[0])).toEqual(["conversation.open", "session.transcript.readPage"]); engine.dispose();
  });

  it("ignores an async hydrate result after dispose", async () => {
    let resolve!: (value: ConversationOpenResult) => void;
    const query = vi.fn(() => new Promise<ConversationOpenResult>((done) => { resolve = done; })) as unknown as ConversationClient["query"];
    const engine = createConversationEngine({ preview: false, client: client(query), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    let notifications = 0; engine.subscribe(() => { notifications += 1; }); engine.start(); const before = notifications; engine.dispose(); resolve(opened); await Promise.resolve();
    expect(notifications).toBe(before);
  });

  it("reopens the target when the target-local stream sequence has a gap", async () => {
    let listener: ((event: never) => void) | undefined;
    const query = vi.fn(async () => ({ ...opened, live: { status: "complete" as const, watermark: 1, events: [] } })) as unknown as ConversationClient["query"];
    const source: ConversationClient = {
      query,
      subscribe: (_scope, next) => { listener = next as (event: never) => void; return () => {}; },
    };
    const engine = createConversationEngine({ preview: false, client: source, identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    engine.start();
    await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    listener?.({
      kind: "conversation.changed",
      cursor: "2",
      authorityId: "authority",
      runtimeEpoch: epoch,
      stateVersion: 1,
      occurredAt: "now",
      sessionId,
      streamSeq: 3,
      eventSeq: 3,
      update: { kind: "conversation.turn.completed", sessionId, turnId: "turn" },
    } as never);
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    engine.dispose();
  });
});
