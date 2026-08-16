import type {
  ClientError,
  ConversationContentBlock,
  ConversationItem,
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

export type ConversationHydrateStatus = "idle" | "loading" | "ready" | "error";

export interface ConversationIdentity {
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly sessionId: SessionId;
  readonly transcriptRevision?: string;
}

export interface ConversationLiveBlock {
  readonly blockId: string;
  readonly blockType: "text" | "thinking";
  readonly text: string;
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
  readonly status: "started" | "updated" | "completed";
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
  };
}

export function clearConversationState(state: ConversationState): ConversationState {
  return {
    ...createInitialConversationState(),
    hydrateGeneration: state.hydrateGeneration + 1,
  };
}

export type ConversationView =
  | { readonly kind: "item"; readonly item: ConversationItem; readonly tools: readonly ConversationLiveTool[] }
  | {
      readonly kind: "live";
      readonly message: ConversationLiveMessage;
      readonly tools: readonly ConversationLiveTool[];
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
      views.push({ kind: "item", item, tools: toolsForMessage(state, id) });
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
