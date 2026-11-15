import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { getPreviewSideAgents } from "./fixtures";
import { isZh } from "../i18n";
import { buildPreviewHub } from "../hubPreview";

/** One fixture feeds the roster and detail; no preview values enter Host state. */
export function getPreviewDockAgents(zh = isZh()): readonly StudioAgentSnapshot[] {
  const sideAgents = getPreviewSideAgents(zh);
  const previewHub = buildPreviewHub(undefined, zh);
  return sideAgents.map((agent, index) => {
    const model = index === 0 ? previewHub.main.model : previewHub.agents.find(row => row.id === agent.hubId)?.resolvedModel;
    return {
      agentId: agent.hubId as AgentId,
      generation: 1 as Generation,
      kind: index === 0 ? "main" : "task",
      displayName: agent.name,
      ...(model === undefined ? {} : { resolvedModel: model }),
      ...(index === 0 ? {} : { parentAgentId: sideAgents[0]!.hubId as AgentId }),
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
}

export const PREVIEW_DOCK_AGENTS: readonly StudioAgentSnapshot[] = getPreviewDockAgents();

export function previewAgentDisplay(agentId: string, zh = isZh()) {
  const fixture = getPreviewSideAgents(zh).find(agent => agent.hubId === agentId);
  return fixture ? {
    status: fixture.statusText,
    tone: fixture.waiting ? "waiting" : fixture.error ? "failed" : "running",
    duration: fixture.time,
    tokens: fixture.tokens,
    cost: fixture.cost,
  } : undefined;
}
