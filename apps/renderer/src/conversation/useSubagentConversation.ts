import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { SessionId } from "@omp-studio/client-contract";
import { createSubagentConversationEngine, subagentEngineInput, type SubagentConversationClient, type SubagentConversationSnapshot } from "./subagentConversationEngine";
import type { SubagentHubTarget } from "./toolMeta";
import { useExecutionTarget } from "../workspaces/ExecutionTargets";

export type UseSubagentConversationResult = SubagentConversationSnapshot & { loadOlder: () => void };
export function useSubagentConversation(input: { readonly preview: boolean; readonly previewStream?: boolean; readonly client: SubagentConversationClient | null; readonly target: SubagentHubTarget | null; readonly runtimeConnected: boolean; readonly parentSessionId?: SessionId; readonly liveSessionId?: SessionId; readonly visible?: boolean; readonly agentGeneration?: number }): UseSubagentConversationResult {
  const engine = useMemo(() => createSubagentConversationEngine(subagentEngineInput(input)), [input.preview, input.previewStream, input.client, input.target?.agentId, input.parentSessionId, input.liveSessionId, input.agentGeneration]);
  const { syncRevision } = useExecutionTarget();
  useEffect(() => () => engine.dispose(), [engine]);
  useEffect(() => { engine.setActive(input.visible !== false, input.runtimeConnected); }, [engine, input.visible, input.runtimeConnected]);
  const lastSync = useRef({ engine, syncRevision });
  useEffect(() => {
    const previous = lastSync.current;
    lastSync.current = { engine, syncRevision };
    if (!input.preview && previous.engine === engine && previous.syncRevision !== syncRevision) void engine.reload();
  }, [engine, syncRevision, input.preview]);
  const snapshot = useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
  const current = useRef(engine); current.current = engine;
  const loadOlder = useRef(() => { void current.current.loadOlder(); }).current;
  return { ...snapshot, loadOlder };
}
