import { useRef } from "react";
import type { SessionId } from "@omp-studio/client-contract";
import {
  type SubagentConversationClient,
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

// TODO: createSubagentConversationEngine removed — needs reimplementation
export function useSubagentConversation(input: {
  readonly preview: boolean;
  readonly client: SubagentConversationClient | null;
  readonly target: SubagentHubTarget | null;
  readonly runtimeConnected: boolean;
  readonly parentSessionId?: SessionId;
  readonly liveSessionId?: SessionId;
}): UseSubagentConversationResult {
  const loadOlderRef = useRef(() => {});
  return {
    ...emptySnapshot,
    loadOlder: loadOlderRef.current,
  };
}
