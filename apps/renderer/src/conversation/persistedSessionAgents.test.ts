import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionId, StudioClient } from "@omp-studio/client-contract";
import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { mergeAgentRosters, usePersistedSessionAgents } from "./persistedSessionAgents";

afterEach(cleanup);

function agent(overrides: Partial<StudioAgentSnapshot> = {}): StudioAgentSnapshot {
  return {
    agentId: "WorkerEcho" as AgentId,
    generation: 1 as Generation,
    kind: "sub",
    displayName: "WorkerEcho",
    status: "parked",
    updatedAt: "2026-08-19T00:00:00.000Z",
    hasLiveSession: false,
    hasTranscript: true,
    unreadCount: 0,
    activeJobIds: [],
    ...overrides,
  };
}

describe("mergeAgentRosters", () => {
  it("keeps persisted children and lets live rows win the same id", () => {
    const persisted = [
      agent({ agentId: "Main" as AgentId, kind: "main", displayName: "Main" }),
      agent({ status: "parked", usage: { tokens: 18_000, requests: 3, tools: 3, cost: 0.003, durationMs: 675_000 } }),
    ];
    const live = [
      agent({
        status: "running",
        hasLiveSession: true,
        usage: { tokens: 20_000, requests: 4, tools: 4, cost: 0.004, durationMs: 12_000 },
      }),
    ];
    const merged = mergeAgentRosters(live, persisted);
    expect(merged.map((row) => row.agentId)).toEqual(["WorkerEcho"]);
    expect(merged[0]?.status).toBe("running");
    expect(merged[0]?.usage?.tokens).toBe(20_000);
  });
});

describe("usePersistedSessionAgents", () => {
  it("does not overlay live agents from a different session", async () => {
    const persisted = agent({ status: "parked" });
    const live = agent({
      agentId: "LiveOnly" as AgentId,
      displayName: "LiveOnly",
      status: "running",
      hasLiveSession: true,
    });
    const query = vi.fn(async () => ({ sessionId: "hist-session", agents: [persisted] }));
    const { result } = renderHook(() => usePersistedSessionAgents({
      preview: false,
      client: { query } as Pick<StudioClient, "query">,
      sessionId: "hist-session",
      liveSessionId: "fresh-session",
      liveAgents: [live],
    }));
    await waitFor(() => {
      expect(result.current.agents.map((row) => row.agentId)).toEqual(["WorkerEcho"]);
      expect(result.current.ready).toBe(true);
    });
    expect(query).toHaveBeenCalledWith("session.agents.list", { sessionId: "hist-session" as SessionId });
    expect(result.current.agents[0]?.status).toBe("parked");
    expect(result.current.ready).toBe(true);
  });

  it("merges live agents when the viewed session is the live session", async () => {
    const persisted = agent({ status: "parked" });
    const live = agent({ status: "idle", hasLiveSession: true });
    const query = vi.fn(async () => ({ sessionId: "live-session", agents: [persisted] }));
    const { result } = renderHook(() => usePersistedSessionAgents({
      preview: false,
      client: { query } as Pick<StudioClient, "query">,
      sessionId: "live-session",
      liveSessionId: "live-session",
      liveAgents: [live],
    }));
    await waitFor(() => {
      expect(result.current.agents[0]?.status).toBe("idle");
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.agents[0]?.hasLiveSession).toBe(true);
  });

  it("clears the previous roster as soon as sessionId changes", async () => {
    let resolveFirst!: (value: { sessionId: string; agents: StudioAgentSnapshot[] }) => void;
    const query = vi.fn(async () => new Promise<{ sessionId: string; agents: StudioAgentSnapshot[] }>((resolve) => {
      resolveFirst = resolve;
    }));
    const { result, rerender } = renderHook(
      ({ sessionId }) => usePersistedSessionAgents({
        preview: false,
        client: { query } as Pick<StudioClient, "query">,
        sessionId,
        liveSessionId: undefined,
        liveAgents: undefined,
      }),
      { initialProps: { sessionId: "sess-a" } },
    );
    await waitFor(() => {
      expect(query).toHaveBeenCalledTimes(1);
    });
    resolveFirst({ sessionId: "sess-a", agents: [agent({})] });
    await waitFor(() => {
      expect(result.current.agents).toHaveLength(1);
      expect(result.current.ready).toBe(true);
    });

    let resolveSecond!: (value: { sessionId: string; agents: StudioAgentSnapshot[] }) => void;
    query.mockImplementation(async () => new Promise((resolve) => {
      resolveSecond = resolve;
    }));
    rerender({ sessionId: "sess-b" });
    expect(result.current.agents).toEqual([]);
    expect(result.current.ready).toBe(false);
    await waitFor(() => {
      expect(query).toHaveBeenCalledTimes(2);
    });
    resolveSecond({ sessionId: "sess-b", agents: [] });
    await waitFor(() => {
      expect(result.current.ready).toBe(true);
    });
    expect(result.current.agents).toEqual([]);
  });
});
