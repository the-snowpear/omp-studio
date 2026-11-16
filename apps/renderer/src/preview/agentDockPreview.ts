import type { AgentId, Generation, StudioAgentSnapshot } from "@omp-studio/studio-protocol";
import { getPreviewSideAgents } from "./fixtures";
import { isZh } from "../i18n";
import { buildPreviewHub } from "../hubPreview";

/** Demo times are relative to this instant, so every view of the story agrees on "now". */
export const PREVIEW_AGENT_EPOCH = Date.now();
const ago = (seconds: number) => new Date(PREVIEW_AGENT_EPOCH - seconds * 1000).toISOString();

/** When each agent of the shared story started and last changed, in seconds before the epoch. */
const PREVIEW_TIMES: Record<string, { started: number; updated: number; tps?: number }> = {
  "agent-019fac94": { started: 1500, updated: 2, tps: 61 },
  "agent-019fc9d2": { started: 1445, updated: 692 },
  "agent-019fcb01": { started: 812, updated: 3, tps: 46 },
  "agent-019fcb17": { started: 663, updated: 63 },
  "agent-019fcb55": { started: 438, updated: 400 },
  "agent-019fcb20": { started: 294, updated: 8, tps: 38 },
};

/** One fixture feeds the roster, the deck and the detail; no preview values enter Host state. */
export function getPreviewDockAgents(zh = isZh()): readonly StudioAgentSnapshot[] {
  const sideAgents = getPreviewSideAgents(zh);
  const previewHub = buildPreviewHub(PREVIEW_AGENT_EPOCH, zh);
  const mainId = sideAgents[0]!.hubId as AgentId;
  const hubAgent = (id: string) => previewHub.agents.find(row => row.id === id);
  const timed = (id: string) => {
    const time = PREVIEW_TIMES[id];
    return time === undefined ? { updatedAt: ago(0) } : { startedAt: ago(time.started), updatedAt: ago(time.updated) };
  };
  const usage = (id: string) => {
    const metrics = hubAgent(id)?.metrics;
    const tps = PREVIEW_TIMES[id]?.tps;
    if (metrics === undefined) return {};
    return { usage: {
      tokens: metrics.tokens, requests: metrics.requests, tools: metrics.tools, cost: metrics.cost, durationMs: metrics.durationMs,
      ...(metrics.contextTokens == null ? {} : { contextTokens: metrics.contextTokens }),
      ...(metrics.contextWindow == null ? {} : { contextWindow: metrics.contextWindow }),
      ...(tps === undefined ? {} : { generationTps: tps }),
    } };
  };
  const side = sideAgents.map((agent, index): StudioAgentSnapshot => {
    const hub = hubAgent(agent.hubId);
    const model = index === 0 ? previewHub.main.model : hub?.resolvedModel;
    return {
      agentId: agent.hubId as AgentId,
      generation: 1 as Generation,
      kind: index === 0 ? "main" : "task",
      displayName: agent.name,
      ...(model === undefined ? {} : { resolvedModel: model }),
      ...(index === 0 ? {} : { parentAgentId: mainId }),
      ...(hub?.modelRole === undefined ? {} : { modelRole: hub.modelRole }),
      assignment: agent.task,
      status: agent.status === "failed" ? "failed" : "running",
      stage: agent.lastTool,
      ...(hub?.completionPercent === undefined ? {} : { completionPercent: hub.completionPercent }),
      ...timed(agent.hubId),
      ...(index === 0
        ? { usage: { tokens: 48200, requests: 31, tools: 58, cost: 1.94, durationMs: 372000, contextTokens: previewHub.main.contextPct * 2000, contextWindow: 200000, generationTps: PREVIEW_TIMES[agent.hubId]?.tps ?? 0 } }
        : usage(agent.hubId)),
      ...(hub?.outputPath ? { outputPath: hub.outputPath } : {}),
      hasLiveSession: agent.status !== "failed",
      hasTranscript: true,
      unreadCount: hub?.ircUnread ?? 0,
      activeJobIds: [],
    };
  });
  // The Hub story's nested typecheck run and its parked docs writer, so the
  // roster shows a second generation, a parked agent and a fallback model.
  const extra = (["agent-019fcb20", "agent-019fc9d2"] as const).flatMap((id): StudioAgentSnapshot[] => {
    const hub = hubAgent(id);
    if (!hub) return [];
    return [{
      agentId: id as AgentId,
      generation: 1 as Generation,
      kind: "task",
      displayName: hub.name,
      ...(hub.resolvedModel === undefined ? {} : { resolvedModel: hub.resolvedModel }),
      ...(hub.fallback ? { modelIsFallback: true } : {}),
      ...(hub.modelRole === undefined ? {} : { modelRole: hub.modelRole }),
      parentAgentId: (hub.parentId === "main" ? mainId : hub.parentId) as AgentId,
      assignment: hub.task,
      status: hub.status === "parked" ? "parked" : "running",
      ...((hub.stage ?? hub.lastIntent) ? { stage: (hub.stage ?? hub.lastIntent)! } : {}),
      ...(hub.completionPercent === undefined ? {} : { completionPercent: hub.completionPercent }),
      ...timed(id),
      ...usage(id),
      ...(hub.outputPath ? { outputPath: hub.outputPath } : {}),
      ...(hub.patchPath ? { patchPath: hub.patchPath } : {}),
      ...(hub.branchName ? { branchName: hub.branchName } : {}),
      hasLiveSession: hub.status !== "parked",
      hasTranscript: true,
      unreadCount: hub.ircUnread ?? 0,
      activeJobIds: [],
    }];
  });
  // Children follow their parent in the roster's parent-first order either way.
  return [...side, ...extra];
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
