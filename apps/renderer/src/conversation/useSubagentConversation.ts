import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SessionId } from "@omp-studio/client-contract";
import { createSubagentConversationEngine, subagentEngineInput, type SubagentConversationClient, type SubagentConversationSnapshot } from "./subagentConversationEngine";
import type { SubagentHubTarget } from "./toolMeta";

export type UseSubagentConversationResult = SubagentConversationSnapshot & { loadOlder: () => void };
export function useSubagentConversation(input: { readonly preview: boolean; readonly client: SubagentConversationClient | null; readonly target: SubagentHubTarget | null; readonly runtimeConnected: boolean; readonly parentSessionId?: SessionId; readonly liveSessionId?: SessionId }): UseSubagentConversationResult {
  const engine = useMemo(() => createSubagentConversationEngine(subagentEngineInput(input)), [input.preview, input.client, input.target?.agentId, input.parentSessionId, input.liveSessionId, input.runtimeConnected]);
  useEffect(() => { engine.start(); return () => engine.dispose(); }, [engine]);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const current = useRef(engine); current.current = engine;
  const loadOlder = useRef(() => { void current.current.loadOlder(); }).current;
  return { ...snapshot, loadOlder };
}
