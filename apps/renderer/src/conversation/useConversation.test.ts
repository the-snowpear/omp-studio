import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { SessionId } from "@omp-studio/client-contract";
import type { ConversationOpenResult, RuntimeEpoch } from "@omp-studio/studio-protocol";
import { activeConversationEngineCount, type ConversationSnapshot } from "./conversationEngine";
import type { ConversationClient } from "./conversationHost";
import { resetConversation, type HydrateStatus } from "./conversationViewModel";
import { retainConversationWhileRemounting, useConversation } from "./useConversation";

const sessionA = "session-a" as SessionId;
const sessionB = "session-b" as SessionId;

function snapshot(sessionId: SessionId | undefined, rows: ConversationSnapshot["rows"], hydrateStatus: HydrateStatus = rows.length === 0 ? "idle" : "ready"): ConversationSnapshot {
  return {
    state: resetConversation(1, sessionId === undefined ? null : { sessionId }, hydrateStatus),
    rows,
    demo: false,
    loadingOlder: false,
    identityKey: sessionId ?? "",
  };
}

describe("retainConversationWhileRemounting", () => {
  it("keeps the previous transcript while the remounted engine is still empty for the same session", () => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const remounting = snapshot(undefined, [], "loading");
    expect(retainConversationWhileRemounting(remounting, previous, sessionA)).toBe(previous);
  });

  it("does not paint another session's transcript over an empty remount", () => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const remounting = snapshot(undefined, []);
    expect(retainConversationWhileRemounting(remounting, previous, sessionB)).toBe(remounting);
  });

  it("lets a hydrated current snapshot replace the hold", () => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const current = snapshot(sessionA, [{ type: "compaction", item: {
      kind: "compaction",
      itemId: "cp-1",
      parentId: null,
      createdAt: "t",
      summary: "Summarized.",
      shortSummary: "Done",
    } }]);
    expect(retainConversationWhileRemounting(current, previous, sessionA)).toBe(current);
  });

  it.each(["ready", "error", "unavailable"] as const)("releases the previous transcript when an empty remount reaches %s", (hydrateStatus) => {
    const previous = snapshot(sessionA, [{ type: "compacting" }]);
    const current = snapshot(sessionA, [], hydrateStatus);
    expect(retainConversationWhileRemounting(current, previous, sessionA)).toBe(current);
  });
});

describe("useConversation hold lifecycle (W03)", () => {
  afterEach(() => cleanup());

  const epoch = 1 as RuntimeEpoch;
  function opened(sessionId: SessionId, text: string): ConversationOpenResult {
    return {
      target: { kind: "session", sessionId, conversationSessionId: sessionId },
      page: { runtimeEpoch: epoch, sessionId, branchLeafId: null, items: [{ kind: "message", itemId: `${sessionId}-user`, parentId: null, createdAt: "now", role: "user", content: [{ type: "text", text }] }], headCursor: "head" as never, hasMoreBefore: false },
      live: { status: "complete", watermark: 0, events: [] },
    };
  }
  /** Resolves conversation.open only when told to, so the remount window is observable. */
  function gatedClient(): { client: ConversationClient; release: () => void } {
    let pending: Array<(value: ConversationOpenResult) => void> = [];
    let target: SessionId = sessionA;
    const client: ConversationClient = {
      query: vi.fn((name: string, input: unknown) => {
        target = (input as { target: { sessionId: SessionId } }).target.sessionId;
        if (name !== "conversation.open") throw new Error(name);
        return new Promise<ConversationOpenResult>((done) => { pending.push(done); });
      }) as never,
      subscribe: () => () => {},
    };
    return { client, release: () => { const batch = pending; pending = []; for (const done of batch) done(opened(target, `hello ${target}`)); } };
  }

  it("keeps the same-session transcript across an engine remount, drops it on session switch and on unmount", async () => {
    const { client, release } = gatedClient();
    const base = activeConversationEngineCount();
    const hook = renderHook((input: { sessionId: SessionId; transcriptRevision: string }) =>
      useConversation({ preview: false, client, identity: { sessionId: input.sessionId, runtimeEpoch: epoch, transcriptRevision: input.transcriptRevision as never }, canRead: true, runtimeConnected: true }),
    { initialProps: { sessionId: sessionA, transcriptRevision: "r1" } });
    release();
    await vi.waitFor(() => expect(hook.result.current.state.hydrateStatus).toBe("ready"));
    expect(hook.result.current.rows).toHaveLength(1);
    const firstEngine = hook.result.current.engine;

    // Same session, new transcript revision: engine rebuilt, first snapshot empty → hold paints the old rows.
    hook.rerender({ sessionId: sessionA, transcriptRevision: "r2" });
    expect(hook.result.current.engine).not.toBe(firstEngine);
    expect(hook.result.current.engine.getSnapshot().state.hydrateStatus).toBe("loading");
    // The hold paints the previous (ready) snapshot while the new engine is still empty.
    expect(hook.result.current.rows).toHaveLength(1);
    expect(hook.result.current.rows[0]).toMatchObject({ type: "user", text: `hello ${sessionA}` });
    // The disposed engine no longer holds those rows itself; only the hook's hold does.
    expect(firstEngine.getSnapshot().rows).toEqual([]);
    release();
    await vi.waitFor(() => expect(hook.result.current.state.hydrateStatus).toBe("ready"));

    // Different session: the hold must not be painted and must be released.
    hook.rerender({ sessionId: sessionB, transcriptRevision: "r1" });
    expect(hook.result.current.rows).toHaveLength(0);
    expect(hook.result.current.state.hydrateStatus).toBe("loading");
    release();
    await vi.waitFor(() => expect(hook.result.current.state.hydrateStatus).toBe("ready"));
    expect(hook.result.current.rows[0]).toMatchObject({ type: "user", text: `hello ${sessionB}` });

    const lastEngine = hook.result.current.engine;
    hook.unmount();
    expect(lastEngine.getSnapshot().rows).toEqual([]);
    expect(activeConversationEngineCount()).toBe(base);
  });
});
