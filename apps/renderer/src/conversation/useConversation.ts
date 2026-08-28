import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import type { ConversationSnapshot } from "./conversationEngine";
import { emptyConversationState, type PendingUser } from "./conversationViewModel";

export type UseConversationInput = {
  readonly preview: boolean;
  readonly client: ConversationClient | null;
  readonly identity: ConversationIdentity | null;
  readonly canRead: boolean;
  readonly runtimeConnected: boolean;
  readonly previewThreadId?: string;
};

export type UseConversationResult = ConversationSnapshot & {
  loadOlder: () => void;
  reload: () => Promise<void>;
  restoreFromUser: (itemId: string) => boolean;
  trackPending: (pending: PendingUser) => void;
  failPending: (requestId: string, error: string) => void;
  dropPending: (requestId: string) => void;
};

const emptySnapshot: ConversationSnapshot = {
  state: emptyConversationState(),
  rows: [],
  demo: false,
  loadingOlder: false,
  identityKey: "",
};

/**
 * Keep the last transcript on screen while the engine remounts for the same
 * session (archive → live after resume, or compact completion reload).
 * An empty current snapshot for a *different* session is shown as-is.
 */
export function retainConversationWhileRemounting(
  current: ConversationSnapshot,
  previous: ConversationSnapshot | undefined,
  sessionId: ConversationIdentity["sessionId"] | undefined,
): ConversationSnapshot {
  if (current.rows.length > 0) return current;
  if (sessionId === undefined || previous === undefined || previous.rows.length === 0) return current;
  if (previous.state.identity?.sessionId !== sessionId) return current;
  return previous;
}

// TODO: createConversationEngine removed — needs reimplementation
export function useConversation(_input: UseConversationInput): UseConversationResult {
  return {
    ...emptySnapshot,
    loadOlder: () => {},
    reload: async () => {},
    restoreFromUser: () => false,
    trackPending: () => {},
    failPending: () => {},
    dropPending: () => {},
  };
}
