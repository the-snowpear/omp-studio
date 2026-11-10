import { describe, expect, it, vi } from "vitest";
import { contractFixtures } from "@omp-studio/testkit";
import type { StudioClient } from "@omp-studio/client-contract";
import { createConversationClient, initializeConversationClient, resyncConversationClient } from "./client";
import { conversationBodyReady } from "./projectReads";

function target() {
  return { bootstrap: vi.fn(async () => structuredClone(contractFixtures.bootstrap)), subscribe: vi.fn(() => () => {}), query: vi.fn(), command: vi.fn(), close: vi.fn(), transportLost: vi.fn() } as unknown as StudioClient & { bootstrap: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}
describe("conversation resource lifetime", () => {
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
