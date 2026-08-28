import type { ConversationItem, SessionId, StudioClient } from "@omp-studio/client-contract";
import type { ConversationState, TimelineRow } from "./conversationViewModel";
import type { SubagentHubTarget } from "./toolMeta";

export type SubagentConversationClient = Pick<StudioClient, "query" | "subscribe">;

export type SubagentConversationEngineInput = {
  readonly preview: boolean;
  readonly previewItems: readonly ConversationItem[];
  readonly client: SubagentConversationClient | null;
  readonly target: SubagentHubTarget | null;
  readonly runtimeConnected: boolean;
  readonly parentSessionId?: SessionId;
  readonly liveSessionId?: SessionId;
};

export type SubagentConversationSnapshot = {
  readonly state: ConversationState;
  readonly rows: readonly TimelineRow[];
  readonly demo: boolean;
  readonly loadingOlder: boolean;
  readonly identityKey: string;
};

export type SubagentConversationEngine = {
  getSnapshot(): SubagentConversationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  dispose(): void;
  loadOlder(): Promise<void>;
};

// --- Deleted: createSubagentConversationEngine implementation ---
