import { describe, expect, it, vi } from "vitest";
import type { ConversationOpenResult, RuntimeEpoch, SessionId } from "@omp-studio/studio-protocol";
import type { ConversationClient } from "./conversationHost";
import { activeConversationEngineCount, createConversationEngine } from "./conversationEngine";

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

  it("defers archive/live I/O while a resident session is being activated", async () => {
    const query = vi.fn(async () => opened) as unknown as ConversationClient["query"];
    const engine = createConversationEngine({
      preview: false,
      client: client(query),
      identity: { sessionId },
      canRead: true,
      runtimeConnected: true,
      deferHydrate: true,
      previewItems: [],
    });
    engine.start();
    await Promise.resolve();
    expect(query).not.toHaveBeenCalled();
    engine.dispose();
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

describe("createConversationEngine dispose (W03)", () => {
  it("replaces its published snapshots so a retained engine cannot keep the transcript alive", async () => {
    const query = vi.fn(async () => opened) as unknown as ConversationClient["query"];
    const engine = createConversationEngine({ preview: false, client: client(query), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    engine.start(); await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    const before = engine.getSnapshot();
    expect(before.rows).toHaveLength(1);
    expect(engine.getMetadataSnapshot().state.items).toHaveLength(1);
    const generation = before.state.generation;
    engine.dispose();
    // The pre-dispose snapshot object the caller kept is theirs; the engine itself no longer references it.
    const after = engine.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.rows).toEqual([]);
    expect(after.state.items).toEqual([]);
    expect(after.state.pendingUsers).toEqual([]);
    expect(engine.getMetadataSnapshot().rows).toEqual([]);
    expect(engine.getMetadataSnapshot().state.items).toEqual([]);
    expect(after.state.identity).toEqual({ sessionId, runtimeEpoch: epoch });
    expect(after.state.generation).toBe(generation);
    expect(after.identityKey).toBe(before.identityKey);
    expect(engine.getDiagnostics()).toMatchObject({ disposed: 1, rows: 0, listeners: 0, metadataListeners: 0, openBufferEvents: 0, openBufferBytes: 0 });
  });

  it("is idempotent and decrements the active-engine count exactly once", () => {
    const base = activeConversationEngineCount();
    const engine = createConversationEngine({ preview: false, client: null, identity: { sessionId }, canRead: true, runtimeConnected: false, previewItems: [] });
    expect(activeConversationEngineCount()).toBe(base + 1);
    engine.dispose(); engine.dispose(); engine.dispose();
    expect(activeConversationEngineCount()).toBe(base);
    expect(engine.getSnapshot().rows).toEqual([]);
  });

  it("does not broadcast the blanking to subscribers and refuses new subscriptions afterwards", async () => {
    const query = vi.fn(async () => opened) as unknown as ConversationClient["query"];
    const engine = createConversationEngine({ preview: false, client: client(query), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    let hot = 0; let meta = 0;
    engine.subscribe(() => { hot += 1; }); engine.subscribeMetadata(() => { meta += 1; });
    engine.start(); await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    const hotBefore = hot; const metaBefore = meta;
    engine.dispose();
    expect(hot).toBe(hotBefore); expect(meta).toBe(metaBefore);
    let late = 0;
    const off = engine.subscribe(() => { late += 1; }); off();
    engine.subscribeMetadata(() => { late += 1; });
    expect(engine.getDiagnostics().listeners).toBe(0);
    expect(late).toBe(0);
  });

  it("drops a loadOlder page and a thumbnail read that resolve after dispose", async () => {
    let resolveOlder!: (value: unknown) => void;
    let resolveThumbs!: (value: Record<string, never>) => void;
    const query = vi.fn(async (name: string) => {
      if (name === "conversation.open") return { ...opened, page: { ...page, olderCursor: "older" } };
      return new Promise((done) => { resolveOlder = done; });
    }) as unknown as ConversationClient["query"];
    const thumbStore = { load: vi.fn(() => new Promise<Record<string, never>>((done) => { resolveThumbs = done; })), save: vi.fn(async () => undefined), dropSession: vi.fn(async () => undefined) };
    const engine = createConversationEngine({ preview: false, client: client(query), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [], thumbStore });
    engine.start(); await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    const older = engine.loadOlder();
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(engine.getSnapshot().loadingOlder).toBe(true);
    engine.dispose();
    expect(engine.getSnapshot().loadingOlder).toBe(false);
    resolveOlder({ ...page, items: [{ kind: "message", itemId: "earlier", parentId: null, createdAt: "then", role: "user", content: [{ type: "text", text: "old" }] }], headCursor: "head2" });
    resolveThumbs({});
    await older; await Promise.resolve(); await Promise.resolve();
    expect(engine.getSnapshot().rows).toEqual([]);
    expect(engine.getSnapshot().state.items).toEqual([]);
    expect(engine.getSnapshot().loadingOlder).toBe(false);
  });

  it("does not let a reload issued after dispose repopulate the snapshot", async () => {
    const query = vi.fn(async () => opened) as unknown as ConversationClient["query"];
    const engine = createConversationEngine({ preview: false, client: client(query), identity: { sessionId, runtimeEpoch: epoch }, canRead: true, runtimeConnected: true, previewItems: [] });
    engine.start(); await vi.waitFor(() => expect(engine.getSnapshot().state.hydrateStatus).toBe("ready"));
    engine.dispose();
    await engine.reload();
    expect(engine.getSnapshot().rows).toEqual([]);
    expect(engine.getSnapshot().state.hydrateStatus).not.toBe("ready");
  });
});
