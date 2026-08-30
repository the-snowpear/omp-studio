import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionId, StudioClient } from "@omp-studio/client-contract";
import type { StudioAgentSnapshot } from "@omp-studio/studio-protocol";

/**
 * 落盘记录只补 live 缺的度量，不改 live 的身份/状态：Agent 停靠（park）后 runtime
 * 会 dispose session，`liveUsage` 随之消失，而归档读取器仍能从 transcript 里算出真实
 * 的 token/请求数和跨度时长。少了这一步，没有 usage 的 live 行会整行盖掉有 usage 的
 * 落盘行，卡片就只剩 `usage —`。
 */
function fillFromPersisted(live: StudioAgentSnapshot, persisted: StudioAgentSnapshot): StudioAgentSnapshot {
  const needsUsage = live.usage === undefined && persisted.usage !== undefined;
  const needsStartedAt = live.startedAt === undefined && persisted.startedAt !== undefined;
  if (!needsUsage && !needsStartedAt) return live;
  return {
    ...live,
    ...(needsUsage ? { usage: persisted.usage } : {}),
    ...(needsStartedAt ? { startedAt: persisted.startedAt } : {}),
  };
}

export function mergeAgentRosters(
  live: readonly StudioAgentSnapshot[] | undefined,
  persisted: readonly StudioAgentSnapshot[] | undefined,
): StudioAgentSnapshot[] {
  const byId = new Map<string, StudioAgentSnapshot>();
  for (const agent of persisted ?? []) {
    if (agent.kind === "main") continue;
    byId.set(agent.agentId, agent);
  }
  for (const agent of live ?? []) {
    const archived = byId.get(agent.agentId);
    byId.set(agent.agentId, archived === undefined ? agent : fillFromPersisted(agent, archived));
  }
  return [...byId.values()];
}

export type PersistedSessionAgentsResult = {
  readonly agents: readonly StudioAgentSnapshot[];
  readonly ready: boolean;
};

export function usePersistedSessionAgents(input: {
  readonly preview: boolean;
  readonly client: Pick<StudioClient, "query"> | null;
  readonly sessionId: string | undefined;
  readonly liveSessionId: string | undefined;
  readonly liveAgents: readonly StudioAgentSnapshot[] | undefined;
}): PersistedSessionAgentsResult {
  const idle = input.preview || input.client === null || input.sessionId === undefined;
  const [persisted, setPersisted] = useState<readonly StudioAgentSnapshot[]>([]);
  const [ready, setReady] = useState(idle);
  const [seenSessionId, setSeenSessionId] = useState(input.sessionId);
  const clientRef = useRef(input.client);
  clientRef.current = input.client;
  if (seenSessionId !== input.sessionId) {
    setSeenSessionId(input.sessionId);
    setPersisted([]);
    setReady(input.preview || input.client === null || input.sessionId === undefined);
  }
  const hasClient = input.client !== null;
  useEffect(() => {
    const client = clientRef.current;
    if (input.preview || client === null || input.sessionId === undefined) {
      setPersisted([]);
      setReady(true);
      return;
    }
    let cancelled = false;
    setReady(false);
    void client
      .query("session.agents.list", { sessionId: input.sessionId as SessionId })
      .then((result) => {
        if (!cancelled) setPersisted(result.agents);
      })
      .catch(() => {
        if (!cancelled) setPersisted([]);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [input.preview, input.sessionId, hasClient]);
  const liveForView = input.liveSessionId === input.sessionId ? input.liveAgents : undefined;
  const agents = useMemo(() => mergeAgentRosters(liveForView, persisted), [liveForView, persisted]);
  return { agents, ready };
}
