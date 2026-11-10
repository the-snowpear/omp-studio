import { describe, expect, it, vi } from "vitest";
import { contractFixtures } from "@omp-studio/testkit";
import type { StudioClient } from "@omp-studio/client-contract";
import { createConversationClient, initializeConversationClient, resyncConversationClient } from "./client";
import { acquireProjectReads, conversationBodyReady } from "./projectReads";
import { createConversationEngine } from "../conversation/conversationEngine";

function target() {
  return { bootstrap: vi.fn(async () => structuredClone(contractFixtures.bootstrap)), subscribe: vi.fn(() => () => {}), query: vi.fn(), command: vi.fn(), close: vi.fn(), transportLost: vi.fn() } as unknown as StudioClient & { bootstrap: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}
describe("conversation resource lifetime", () => {
  it("warms the startup project without creating a conversation or closing the root client", async () => {
    vi.useFakeTimers();
    const root = target(), project = target();
    const workspaceId = "startup-project" as import("@omp-studio/client-contract").WorkspaceId;
    root.bootstrap.mockResolvedValue({ ...structuredClone(contractFixtures.bootstrap), selected: { workspaceId } });
    const openContext = vi.fn(async () => project);
    Object.assign(root, { openContext });
    vi.mocked(project.query).mockResolvedValue({ entries: [], total: 0 } as never);
    const client = createConversationClient(async () => ({ client: root, owned: false }), false, undefined, true);
    await client.bootstrap(); await vi.advanceTimersByTimeAsync(2100);
    expect(openContext).toHaveBeenCalledWith({ workspaceId });
    expect(openContext).toHaveBeenCalledTimes(1);
    expect(project.query).toHaveBeenCalledWith("models.get", {});
    await client.close(); await vi.runAllTimersAsync();
    expect(project.close).toHaveBeenCalledTimes(1); expect(root.close).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
  it("a warm conversation can show its own cached page before opening its next context", async () => {
    vi.useFakeTimers();
    const shared = acquireProjectReads(target(), "workspace" as never);
    const page = contractFixtures.queryResponses["session.transcript.readPage"];
    if (!page.ok) throw new Error("fixture");
    shared.reads.savePage(page.result);
    const open = vi.fn(async () => ({ client: target(), owned: true }));
    const client = createConversationClient(open, true, shared.reads);
    const engine = createConversationEngine({ preview: false, client, identity: { sessionId: page.result.sessionId }, canRead: true, runtimeConnected: false, previewItems: [] });
    expect(engine.getSnapshot().rows.length).toBeGreaterThan(0);
    expect(engine.getSnapshot().state.hydrateStatus).toBe("resyncing");
    expect(open).not.toHaveBeenCalled();
    engine.dispose(); await client.close(); shared.release(); await vi.runAllTimersAsync(); vi.useRealTimers();
  });
  it("holds auxiliary reads until body presentation and drops queued reads when the view closes", async () => {
    vi.useFakeTimers();
    const owned = target();
    vi.mocked(owned.query).mockResolvedValue({} as never);
    const client = createConversationClient(async () => ({ client: owned, owned: true }), true);
    const auxiliary = client.query("models.get", {});
    await client.query("session.transcript.readPage", { sessionId: "a" as never });
    expect(owned.query).not.toHaveBeenCalledWith("models.get", {});
    conversationBodyReady(client); await vi.runAllTimersAsync(); await auxiliary;
    expect(owned.query).toHaveBeenCalledWith("models.get", {});
    await client.close();
    const next = createConversationClient(async () => ({ client: target(), owned: true }), true);
    const queued = next.query("models.get", {});
    const rejected = expect(queued).rejects.toThrow("closed");
    await next.close(); await rejected;
    vi.useRealTimers();
  });
  it("deduplicates initialization across mounted surfaces without closing their shared target", async () => {
    const shared = target();
    const first = createConversationClient(async () => ({ client: shared, owned: false }));
    const second = createConversationClient(async () => ({ client: shared, owned: false }));
    await Promise.all([initializeConversationClient(first), initializeConversationClient(first), initializeConversationClient(second)]);
    expect(shared.bootstrap).toHaveBeenCalledTimes(1);
    await first.close();
    expect(shared.close).not.toHaveBeenCalled();
    await initializeConversationClient(second);
    expect(shared.bootstrap).toHaveBeenCalledTimes(1);
    await resyncConversationClient(second);
    expect(shared.bootstrap).toHaveBeenCalledTimes(2);
  });
  it("releases only the owned context and reuses its initialization until explicit resync", async () => {
    const owned = target(), open = vi.fn(async () => ({ client: owned, owned: true }));
    const client = createConversationClient(open);
    await Promise.all([initializeConversationClient(client), initializeConversationClient(client)]);
    expect(open).toHaveBeenCalledOnce();
    expect(owned.bootstrap).toHaveBeenCalledOnce();
    client.transportLost?.("disconnected");
    await resyncConversationClient(client);
    expect(open).toHaveBeenCalledOnce();
    expect(owned.bootstrap).toHaveBeenCalledTimes(2);
    await client.close();
    expect(owned.close).toHaveBeenCalledOnce();
  });
});
