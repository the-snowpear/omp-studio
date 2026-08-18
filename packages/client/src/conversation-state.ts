import type {
  ClientError,
  ConversationContentBlock,
  ConversationItem,
  ConversationMessageError,
  ConversationRole,
  ConversationRuntimeEvent,
  ConversationTranscriptPage,
  ConversationTranscriptReadPage,
  JsonValue,
  OpaqueCursor,
  RuntimeEpoch,
  SessionId,
} from "@omp-studio/client-contract";

/** Max persisted items retained after prepend; older entries are dropped. */
export const CONVERSATION_STATE_ITEM_CAP = 500;

/** Max settled live tools kept after a turn; running tools are never dropped. */
export const CONVERSATION_STATE_LIVE_TOOLS_CAP = 256;

export type ConversationHydrateStatus = "idle" | "loading" | "ready" | "error";

export interface StickyProviderError {
  readonly sessionId: SessionId;
  readonly itemId: string;
  readonly error: ConversationMessageError;
}

export interface ConversationIdentity {
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly sessionId: SessionId;
  readonly transcriptRevision?: string;
}

export interface ConversationLiveBlock {
  readonly blockId: string;
  readonly blockType: "text" | "thinking";
  readonly text: string;
  /** Set once the live buffer hit its cap; later deltas for the block are dropped. */
  readonly truncated?: boolean;
}

export interface ConversationLiveMessage {
  readonly messageId: string;
  readonly turnId: string;
  readonly role: ConversationRole;
  readonly createdAt: string;
  readonly blocks: Readonly<Record<string, ConversationLiveBlock>>;
  readonly completed: boolean;
  readonly aborted: boolean;
}

export interface ConversationLiveTool {
  readonly toolCallId: string;
  readonly turnId: string;
  readonly messageId?: string;
  readonly toolName?: string;
  readonly arguments?: JsonValue;
  readonly output?: string;
  readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>;
  readonly truncated?: boolean;
  readonly isError?: boolean;
  readonly status: "started" | "updated" | "completed" | "aborted";
  readonly startedAt?: string;
  readonly completedAt?: string;
}

export interface ConversationNotice {
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly source?: string;
}

export interface ConversationState {
  readonly identity?: ConversationIdentity;
  readonly itemsById: Readonly<Record<string, ConversationItem>>;
  readonly order: readonly string[];
  readonly liveMessages: Readonly<Record<string, ConversationLiveMessage>>;
  readonly liveTools: Readonly<Record<string, ConversationLiveTool>>;
  readonly notices: readonly ConversationNotice[];
  readonly olderCursor?: OpaqueCursor;
  readonly headCursor?: OpaqueCursor;
  readonly transcriptRevision?: string;
  readonly hasMoreBefore: boolean;
  readonly hydrateStatus: ConversationHydrateStatus;
  readonly hydrateGeneration: number;
  readonly lastEventSeq?: number;
  readonly resyncRequired: boolean;
  readonly abortedTurns: Readonly<Record<string, true>>;
  /**
   * itemId → provider failure for assistant messages that ended with
   * `stopReason: "error"`. The transcript item itself has no error field.
   * Held until the next successful assistant return; abort and same-session
   * hydrate keep it. Survives leaving the session via `stickyProviderErrors`.
   */
  readonly itemErrors: Readonly<Record<string, ConversationMessageError>>;
  /**
   * Last provider failure per session. Survives identity switches so coming
   * back to the failed session can restore `itemErrors`. Cleared only when
   * that session's next assistant message completes without an error.
   */
  readonly stickyProviderErrors: Readonly<Record<string, StickyProviderError>>;
  /**
   * Persisted itemId → owning turnId, kept only while that turn is still open.
   * The runtime persists an assistant item before the first tool of that item
   * starts, so a resultless toolCall is only provably lost once the turn closes.
   * Entries are dropped on `turn.completed` / `turn.aborted`.
   */
  readonly openTurnItems: Readonly<Record<string, string>>;
  /**
   * Live compaction (auto or manual). Set by `conversation.compaction.started`
   * and cleared on completed / abort so the transcript can show an in-progress
   * divider before the persisted compaction item arrives.
   */
  readonly compacting?: { readonly action: string };
  readonly error?: ClientError;
}

export function createInitialConversationState(): ConversationState {
  return {
    itemsById: {},
    order: [],
    liveMessages: {},
    liveTools: {},
    notices: [],
    hasMoreBefore: false,
    hydrateStatus: "idle",
    hydrateGeneration: 0,
    resyncRequired: false,
    abortedTurns: {},
    itemErrors: {},
    stickyProviderErrors: {},
    openTurnItems: {},
  };
}

export function clearConversationState(state: ConversationState): ConversationState {
  return {
    ...createInitialConversationState(),
    hydrateGeneration: state.hydrateGeneration + 1,
    stickyProviderErrors: state.stickyProviderErrors,
  };
}

export type ConversationView =
  | {
      readonly kind: "item";
      readonly item: ConversationItem;
      readonly tools: readonly ConversationLiveTool[];
      /** The turn that produced this item is still running, so its tools may not have started yet. */
      readonly turnOpen: boolean;
    }
  | {
      readonly kind: "live";
      readonly message: ConversationLiveMessage;
      readonly tools: readonly ConversationLiveTool[];
    }
  | {
      readonly kind: "compacting";
      readonly action: string;
    };

export function selectConversationViews(state: ConversationState): readonly ConversationView[] {
  const views: ConversationView[] = [];
  const seenLive = new Set<string>();
  for (const id of state.order) {
    const live = state.liveMessages[id];
    if (live?.aborted) {
      seenLive.add(id);
      views.push({
        kind: "live",
        message: live,
        tools: toolsForMessage(state, id),
      });
      continue;
    }
    const item = state.itemsById[id];
    if (item !== undefined) {
      views.push({
        kind: "item",
        item,
        tools: toolsForMessage(state, id),
        turnOpen: state.openTurnItems[id] !== undefined,
      });
      continue;
    }
    if (live !== undefined) {
      seenLive.add(id);
      views.push({
        kind: "live",
        message: live,
        tools: toolsForMessage(state, id),
      });
    }
  }
  for (const messageId of Object.keys(state.liveMessages)) {
    if (seenLive.has(messageId)) continue;
    const message = state.liveMessages[messageId];
    if (message === undefined) continue;
    views.push({ kind: "live", message, tools: toolsForMessage(state, messageId) });
  }
  if (state.compacting !== undefined) {
    views.push({ kind: "compacting", action: state.compacting.action });
  }
  return views;
}

export function selectConversationHydrate(state: ConversationState): {
  readonly status: ConversationHydrateStatus;
  readonly error?: ClientError;
} {
  if (state.error === undefined) {
    return { status: state.hydrateStatus };
  }
  return { status: state.hydrateStatus, error: state.error };
}

function toolsForMessage(state: ConversationState, messageId: string): ConversationLiveTool[] {
  const tools: ConversationLiveTool[] = [];
  for (const tool of Object.values(state.liveTools)) {
    if (tool?.messageId === messageId) tools.push(tool);
  }
  return tools;
}

export function conversationIdentityOf(
  event: ConversationRuntimeEvent,
  runtimeEpoch: RuntimeEpoch,
): ConversationIdentity {
  return { runtimeEpoch, sessionId: event.sessionId };
}

export function conversationHintFromCursor(headCursor: OpaqueCursor | undefined): ConversationState {
  const initial = createInitialConversationState();
  if (headCursor === undefined) return initial;
  return { ...initial, headCursor };
}
