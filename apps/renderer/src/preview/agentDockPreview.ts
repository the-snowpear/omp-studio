import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { PREVIEW_SIDE_AGENTS } from "./fixtures";
import { buildPreviewHub } from "../hubPreview";

const previewHub = buildPreviewHub();

/** One fixture feeds the roster and detail; no preview values enter Host state. */
export const PREVIEW_DOCK_AGENTS: readonly StudioAgentSnapshot[] = PREVIEW_SIDE_AGENTS.map((agent, index) => {
  const model = index === 0 ? previewHub.main.model : previewHub.agents.find(row => row.id === agent.hubId)?.resolvedModel;
  return {
  agentId: agent.hubId as AgentId,
  generation: 1 as Generation,
  kind: index === 0 ? "main" : "task",
  displayName: agent.name,
  ...(model === undefined ? {} : { resolvedModel: model }),
  ...(index === 0 ? {} : { parentAgentId: PREVIEW_SIDE_AGENTS[0]!.hubId as AgentId }),
  assignment: agent.task,
  status: agent.status === "failed" ? "failed" : "running",
  stage: agent.lastTool,
  updatedAt: "2026-11-01T06:08:00.000Z",
  hasLiveSession: agent.status !== "failed",
  hasTranscript: true,
  unreadCount: 0,
  activeJobIds: [],
  };
});

export function previewAgentDisplay(agentId: string) {
  const fixture = PREVIEW_SIDE_AGENTS.find(agent => agent.hubId === agentId);
  return fixture ? {
    status: fixture.statusText,
    tone: fixture.waiting ? "waiting" : fixture.error ? "failed" : "running",
    duration: fixture.time,
    tokens: fixture.tokens,
    cost: fixture.cost,
  } : undefined;
}
