import type { ConversationItem, ConversationRuntimeEvent } from "@omp-studio/client-contract";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import type { ConversationState, PendingUser, TimelineRow } from "./conversationViewModel";
import type { UserThumbStore } from "./userMessageThumbs";

export type ConversationEngineInput = {
  readonly preview: boolean;
  readonly client: ConversationClient | null;
  readonly identity: ConversationIdentity | null;
  readonly canRead: boolean;
  readonly runtimeConnected: boolean;
  readonly previewItems: readonly ConversationItem[];
  readonly previewLive?: readonly ConversationRuntimeEvent[];
  /** Injected in tests. Production uses IndexedDB (memory fallback). */
  readonly thumbStore?: UserThumbStore;
};

export type ConversationSnapshot = {
  readonly state: ConversationState;
  readonly rows: readonly TimelineRow[];
  readonly demo: boolean;
  readonly loadingOlder: boolean;
  readonly identityKey: string;
};

export type ConversationEngine = {
  getSnapshot(): ConversationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  dispose(): void;
  loadOlder(): Promise<void>;
  /** Re-hydrate the active branch. `session.tree.navigate` does not emit conversation live events. */
  reload(): Promise<void>;
  /** Preview-only: drop the target user row and everything after it. */
  restoreFromUser(itemId: string): boolean;
  trackPending(pending: PendingUser): void;
  failPending(requestId: string, error: string): void;
  dropPending(requestId: string): void;
};

// --- Deleted: createConversationEngine implementation, RAF throttling, pagination, snapshot generation ---
