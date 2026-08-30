import { describe, expect, it } from "vitest";
import type { AgentId, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { mergeAgentRosters } from "./persistedSessionAgents";

function snapshot(overrides: Partial<StudioAgentSnapshot> = {}): StudioAgentSnapshot {
  return {
    agentId: "NodeHelios",
    generation: 1,
    kind: "sub",
    displayName: "NodeHelios",
    status: "parked",
    updatedAt: "2026-08-29T09:05:15.000Z",
    hasLiveSession: false,
    hasTranscript: true,
    unreadCount: 0,
    activeJobIds: [],
    ...overrides,
  } as StudioAgentSnapshot;
}

const ARCHIVED_USAGE = { tokens: 12_600, requests: 9, tools: 14, cost: 0.51, durationMs: 480_000, durationKind: "span" };

describe("mergeAgentRosters", () => {
  it("fills usage and startedAt from the archive when the live row lost them", () => {
    const merged = mergeAgentRosters(
      [snapshot({ displayName: "NodeHelios (live)" })],
      [snapshot({ startedAt: "2026-08-29T08:57:15.000Z", usage: ARCHIVED_USAGE })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      displayName: "NodeHelios (live)",
      startedAt: "2026-08-29T08:57:15.000Z",
      usage: ARCHIVED_USAGE,
    });
  });

  it("never lets the archive overwrite live measurements", () => {
    const liveUsage = { tokens: 30, requests: 2, tools: 1, cost: 0.01, durationMs: 9000, durationKind: "active" };
    const merged = mergeAgentRosters(
      [snapshot({ status: "running", hasLiveSession: true, startedAt: "2026-08-29T09:00:00.000Z", usage: liveUsage })],
      [snapshot({ startedAt: "2026-08-29T08:57:15.000Z", usage: ARCHIVED_USAGE })],
    );
    expect(merged[0]).toMatchObject({
      status: "running",
      startedAt: "2026-08-29T09:00:00.000Z",
      usage: liveUsage,
    });
  });

  it("keeps archive-only rows and drops the persisted main agent", () => {
    const merged = mergeAgentRosters(
      [snapshot({ agentId: "NodeValkyrie" as AgentId, displayName: "NodeValkyrie" })],
      [snapshot({ agentId: "main" as AgentId, kind: "main", displayName: "main" }), snapshot({ usage: ARCHIVED_USAGE })],
    );
    expect(merged.map((agent) => agent.agentId).sort()).toEqual(["NodeHelios", "NodeValkyrie"]);
  });
});
