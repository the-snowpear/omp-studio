import { useEffect, useReducer, useRef } from "react";
import { previewSubagentConversationItems } from "../preview/subagentConversation";
import {
  createSubagentConversationEngine,
  type SubagentConversationClient,
  type SubagentConversationEngine,
  type SubagentConversationSnapshot,
} from "./subagentConversationEngine";
import { emptyConversationState } from "./conversationViewModel";
import type { SubagentHubTarget } from "./toolMeta";

export type UseSubagentConversationResult = SubagentConversationSnapshot & {
  loadOlder: () => void;
};

const emptySnapshot: SubagentConversationSnapshot = {
  state: emptyConversationState(),
  rows: [],
  demo: false,
  loadingOlder: false,
  identityKey: "",
};

export function useSubagentConversation(input: {
  readonly preview: boolean;
  readonly client: SubagentConversationClient | null;
  readonly target: SubagentHubTarget | null;
  readonly runtimeConnected: boolean;
}): UseSubagentConversationResult {
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const engineRef = useRef<SubagentConversationEngine | null>(null);
  const clientRef = useRef(input.client);
  clientRef.current = input.client;
  const key = `${input.preview}:${input.runtimeConnected}:${input.target?.agentId ?? ""}:${input.target?.toolCallId ?? ""}`;
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    engineRef.current?.dispose();
    engineRef.current = null;
    keyRef.current = key;
  }

  useEffect(() => {
    const engine = createSubagentConversationEngine({
      preview: input.preview,
      previewItems: input.target === null ? [] : previewSubagentConversationItems(input.target.agentId),
      client: input.preview ? null : clientRef.current,
      target: input.target,
      runtimeConnected: input.runtimeConnected,
    });
    engineRef.current = engine;
    const off = engine.subscribe(() => bump());
    engine.start();
    bump();
    return () => {
      off();
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [key]);

  let snapshot = emptySnapshot;
  try {
    snapshot = engineRef.current?.getSnapshot() ?? emptySnapshot;
  } catch {
    snapshot = emptySnapshot;
  }
  return {
    ...snapshot,
    loadOlder: () => {
      void engineRef.current?.loadOlder();
    },
  };
}
