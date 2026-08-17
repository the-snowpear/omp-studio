import { selectConversationHydrate, selectConversationViews } from "@omp-studio/client";
import type { ConversationItem, ConversationRuntimeEvent, OpaqueCursor } from "@omp-studio/client-contract";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import {
  asClientError,
  identityKey,
  isStaleCursorError,
  sameIdentity,
  archiveTranscriptReadInput,
} from "./conversationHost";
import {
  applyLiveEvent,
  buildTimeline,
  dropPending,
  emptyConversationState,
  failPending,
  persistedItemsOf,
  projectClientConversation,
  reconcilePendingUsers,
  resetConversation,
  rowsFromConversationViews,
  trackPending,
  type ConversationState,
  type HydrateStatus,
  type PendingUser,
  type TimelineRow,
} from "./conversationViewModel";

export type ConversationEngineInput = {
  readonly preview: boolean;
  readonly client: ConversationClient | null;
  readonly identity: ConversationIdentity | null;
  readonly canRead: boolean;
  readonly runtimeConnected: boolean;
  readonly previewItems: readonly ConversationItem[];
  readonly previewLive?: readonly ConversationRuntimeEvent[];
};

export type ConversationSnapshot = {
  readonly state: ConversationState;
  readonly rows: TimelineRow[];
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
  trackPending(pending: PendingUser): void;
  failPending(requestId: string, error: string): void;
  dropPending(requestId: string): void;
};

function unavailableReason(input: ConversationEngineInput): string | undefined {
  if (input.preview) return undefined;
  if (input.identity === null) return "当前没有活动会话。";
  if (!input.canRead) return "当前 Host 不支持 session.history 或持久化 transcript 读取。";
  if (input.client === null) return "当前 Client 未提供 transcript hydrate。";
  return undefined;
}

function conversationOf(client: ConversationClient) {
  try {
    return client.getState()?.conversation;
  } catch {
    return undefined;
  }
}

export function createConversationEngine(input: ConversationEngineInput): ConversationEngine {
  let previewState: ConversationState = emptyConversationState();
  let pendingUsers: readonly PendingUser[] = [];
  let loadingOlder = false;
  let disposed = false;
  let hydrateInFlight = false;
  let unsubEvent: (() => void) | undefined;
  let unsubState: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setPreviewState = (next: ConversationState) => {
    previewState = next;
    emit();
  };

  const readLatest = async () => {
    if (input.preview || input.client === null || input.identity === null || disposed || hydrateInFlight) return;
    hydrateInFlight = true;
    const gen = input.client.beginTranscriptHydrate(input.identity);
    emit();
    try {
      if (input.identity.runtimeEpoch === undefined && input.client.hydrateArchiveTranscript !== undefined) {
        const page = await input.client.query("session.transcript.readPage", archiveTranscriptReadInput(input.identity.sessionId));
        if (disposed || !sameIdentity(page, input.identity)) return;
        input.client.hydrateArchiveTranscript(page, gen);
      } else {
        const page = await input.client.query("session.transcript.read", { limit: 50 });
        if (disposed || !sameIdentity(page, input.identity)) return;
        input.client.hydrateTranscript(page, gen);
      }
    } catch (cause) {
      if (disposed) return;
      input.client.failTranscriptHydrate(asClientError(cause), gen);
    } finally {
      hydrateInFlight = false;
      emit();
    }
  };

  const onRuntimeEvent = (kind: string) => {
    if (kind !== "resync.required" || disposed) return;
    void readLatest();
  };

  const onClientState = () => {
    if (disposed || input.client === null) return;
    const convo = conversationOf(input.client);
    if (convo === undefined) return;
    pendingUsers = reconcilePendingUsers(pendingUsers, persistedItemsOf(convo));
    if (convo.resyncRequired && convo.hydrateStatus === "ready" && !hydrateInFlight) {
      void readLatest();
    }
    emit();
  };

  const readSnapshot = (): ConversationSnapshot => {
    if (input.preview) {
      return {
        state: previewState,
        rows: buildTimeline(previewState),
        demo: true,
        loadingOlder,
        identityKey: identityKey(previewState.identity),
      };
    }
    const reason = unavailableReason(input);
    if (reason !== undefined) {
      const state = resetConversation(0, input.identity, "unavailable", reason);
      return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
    }
    const client = input.client;
    if (client === null) {
      const state = resetConversation(0, input.identity, "unavailable", "当前 Client 未提供 transcript hydrate。");
      return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
    }
    const convo = conversationOf(client);
    if (convo === undefined) {
      const state = resetConversation(0, input.identity, "unavailable", "当前 Client 未提供 transcript hydrate。");
      return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
    }
    const pending = reconcilePendingUsers(pendingUsers, persistedItemsOf(convo));
    const hydrate = selectConversationHydrate(convo);
    const hydrateStatus: HydrateStatus =
      convo.resyncRequired && hydrate.status !== "error" ? "resyncing" : hydrate.status;
    const state = projectClientConversation(convo, pending, {
      identityFallback: input.identity,
      hydrateStatus,
      ...(hydrate.error === undefined ? {} : { error: hydrate.error }),
    });
    return {
      state,
      rows: rowsFromConversationViews(selectConversationViews(convo), pending, convo.itemErrors),
      demo: false,
      loadingOlder,
      identityKey: identityKey(state.identity),
    };
  };

  return {
    getSnapshot() {
      try {
        return readSnapshot();
      } catch (cause) {
        const state = {
          ...resetConversation(0, input.identity, "error"),
          error: asClientError(cause),
        };
        return { state, rows: [], demo: false, loadingOlder: false, identityKey: identityKey(input.identity) };
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      hydrateInFlight = false;
      pendingUsers = [];
      unsubEvent?.();
      unsubState?.();
      unsubEvent = undefined;
      unsubState = undefined;
      if (input.preview) {
        setPreviewState({
          ...resetConversation(1, input.identity, "ready"),
          items: input.previewItems.slice(),
          hasMoreBefore: false,
        });
        if (input.previewLive && input.identity) {
          let next = previewState;
          for (const event of input.previewLive) {
            next = applyLiveEvent(next, event, input.identity);
          }
          setPreviewState(next);
        }
        return;
      }
      const reason = unavailableReason(input);
      if (reason !== undefined) {
        emit();
        return;
      }
      if (input.client === null || input.identity === null) return;
      unsubEvent = input.client.subscribe({ scope: "runtime" }, (event) => onRuntimeEvent(event.kind));
      unsubState = input.client.onState(onClientState);
      void readLatest();
    },
    dispose() {
      disposed = true;
      hydrateInFlight = false;
      unsubEvent?.();
      unsubState?.();
      unsubEvent = undefined;
      unsubState = undefined;
      listeners.clear();
    },
    async loadOlder() {
      if (input.preview || loadingOlder || disposed) return;
      if (input.client === null || input.identity === null) return;
      const convo = conversationOf(input.client);
      if (convo === undefined || !convo.hasMoreBefore || convo.olderCursor === undefined) return;
      const generation = convo.hydrateGeneration;
      const cursor: OpaqueCursor = convo.olderCursor;
      loadingOlder = true;
      emit();
      try {
        if (input.identity.runtimeEpoch === undefined && input.client.prependArchiveTranscript !== undefined) {
          const page = await input.client.query(
            "session.transcript.readPage",
            archiveTranscriptReadInput(input.identity.sessionId, cursor),
          );
          if (disposed || !sameIdentity(page, input.identity)) return;
          input.client.prependArchiveTranscript(page, generation);
        } else {
          const page = await input.client.query("session.transcript.read", { cursor, limit: 50 });
          if (disposed || !sameIdentity(page, input.identity)) return;
          input.client.prependTranscript(page, generation);
        }
      } catch (cause) {
        if (disposed) return;
        const error = asClientError(cause);
        if (isStaleCursorError(error)) {
          void readLatest();
          return;
        }
        input.client.failTranscriptHydrate(error, generation);
      } finally {
        loadingOlder = false;
        emit();
      }
    },
    trackPending(pending) {
      if (input.preview) {
        setPreviewState(trackPending(previewState, pending));
        return;
      }
      pendingUsers = trackPending({ ...emptyConversationState(), pendingUsers }, pending).pendingUsers;
      emit();
    },
    failPending(requestId, error) {
      if (input.preview) {
        setPreviewState(failPending(previewState, requestId, error));
        return;
      }
      pendingUsers = failPending({ ...emptyConversationState(), pendingUsers }, requestId, error).pendingUsers;
      emit();
    },
    dropPending(requestId) {
      if (input.preview) {
        setPreviewState(dropPending(previewState, requestId));
        return;
      }
      pendingUsers = dropPending({ ...emptyConversationState(), pendingUsers }, requestId).pendingUsers;
      emit();
    },
  };
}
