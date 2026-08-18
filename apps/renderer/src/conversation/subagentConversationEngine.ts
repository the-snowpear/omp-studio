import type { ClientEvent, ConversationItem, ConversationRuntimeEvent, OpaqueCursor, QueryInput, SessionId, StudioClient } from "@omp-studio/client-contract";
import { asClientError, identityKey, isStaleCursorError, sameIdentity } from "./conversationHost";
import {
  applyLiveEvent,
  buildTimeline,
  emptyConversationState,
  hydratePage,
  resetConversation,
  type ConversationState,
  type TimelineRow,
} from "./conversationViewModel";
import type { SubagentHubTarget } from "./toolMeta";

const LIVE_BUFFER_LIMIT = 128;
const PAGE_LIMIT = 50;

export type SubagentConversationClient = Pick<StudioClient, "query" | "subscribe">;

export type SubagentConversationSnapshot = {
  readonly state: ConversationState;
  readonly rows: TimelineRow[];
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

type BufferedLive = {
  readonly eventSeq: number;
  readonly sessionId: string;
  readonly update: ConversationRuntimeEvent;
};

export function createSubagentConversationEngine(input: {
  readonly preview: boolean;
  readonly previewItems: readonly ConversationItem[];
  readonly client: SubagentConversationClient | null;
  readonly target: SubagentHubTarget | null;
  readonly runtimeConnected: boolean;
}): SubagentConversationEngine {
  let state = emptyConversationState();
  let loadingOlder = false;
  let disposed = false;
  let requestGeneration = 0;
  let overflow = false;
  let liveBuffer: BufferedLive[] = [];
  let replaying = false;
  let unsub: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const setState = (next: ConversationState) => {
    state = next;
    emit();
  };

  const enqueueLive = (event: Extract<ClientEvent, { kind: "conversation.changed" }>) => {
    if (liveBuffer.length >= LIVE_BUFFER_LIMIT) {
      liveBuffer = liveBuffer.slice(-(LIVE_BUFFER_LIMIT - 1));
      overflow = true;
    }
    liveBuffer.push({ eventSeq: event.eventSeq, sessionId: event.sessionId, update: event.update });
  };

  const applyMatching = (event: Extract<ClientEvent, { kind: "conversation.changed" }>) => {
    const identity = state.identity;
    if (identity === null) {
      enqueueLive(event);
      return;
    }
    if (event.sessionId !== identity.sessionId) return;
    if (replaying) {
      enqueueLive(event);
      return;
    }
    setState(applyLiveEvent(state, event.update, identity, event.eventSeq));
  };

  const replayBuffer = (sessionId: string) => {
    replaying = true;
    const pending = liveBuffer
      .filter((item) => item.sessionId === sessionId)
      .sort((left, right) => left.eventSeq - right.eventSeq);
    liveBuffer = [];
    let next = state;
    const identity = next.identity;
    if (identity !== null) {
      for (const item of pending) {
        next = applyLiveEvent(next, item.update, identity, item.eventSeq);
      }
    }
    replaying = false;
    if (liveBuffer.length > 0 && identity !== null) {
      const extra = liveBuffer.filter((item) => item.sessionId === sessionId).sort((left, right) => left.eventSeq - right.eventSeq);
      liveBuffer = liveBuffer.filter((item) => item.sessionId !== sessionId);
      for (const item of extra) {
        next = applyLiveEvent(next, item.update, identity, item.eventSeq);
      }
    }
    setState(next);
  };

  const readLatest = async (generation: number) => {
    if (input.preview || input.client === null || input.target === null || disposed) return;
    setState({ ...resetConversation(state.generation, state.identity, "loading"), resyncRequired: state.resyncRequired });
    try {
      const page = await input.client.query("agent.conversation.read", {
        agentId: input.target.agentId as QueryInput<"agent.conversation.read">["agentId"],
        limit: PAGE_LIMIT,
      });
      if (disposed || generation !== requestGeneration) return;
      const identity = { sessionId: page.sessionId as SessionId, runtimeEpoch: page.runtimeEpoch };
      const seeded = resetConversation(generation, identity, "loading");
      setState(hydratePage(seeded, page, generation, "replace"));
      replayBuffer(page.sessionId);
      if (overflow) {
        overflow = false;
        liveBuffer = [];
        await readLatest(generation);
      }
    } catch (cause) {
      if (disposed || generation !== requestGeneration) return;
      const error = asClientError(cause);
      setState({
        ...resetConversation(generation, state.identity, "error"),
        error,
      });
    }
  };

  const onEvent = (event: ClientEvent) => {
    if (disposed) return;
    if (event.kind === "resync.required") {
      overflow = false;
      liveBuffer = [];
      setState({ ...state, hydrateStatus: "resyncing", resyncRequired: true });
      void readLatest(requestGeneration);
      return;
    }
    if (event.kind !== "conversation.changed") return;
    applyMatching(event);
  };

  return {
    getSnapshot() {
      return {
        state,
        rows: buildTimeline(state),
        demo: input.preview,
        loadingOlder,
        identityKey: identityKey(state.identity),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start() {
      disposed = false;
      requestGeneration += 1;
      const generation = requestGeneration;
      overflow = false;
      liveBuffer = [];
      replaying = false;
      unsub?.();
      unsub = undefined;
      if (input.target === null) {
        setState(resetConversation(generation, null, "unavailable", "当前子 Agent 没有可解析的身份。"));
        return;
      }
      if (input.preview) {
        const identity = { sessionId: `preview:${input.target.agentId}` as SessionId };
        setState({
          ...resetConversation(generation, identity, "ready"),
          items: input.previewItems.slice(),
          hasMoreBefore: false,
        });
        return;
      }
      if (!input.runtimeConnected || input.client === null) {
        setState(resetConversation(generation, null, "unavailable", "当前没有已连接的 Runtime，无法读取子 Agent 对话。"));
        return;
      }
      setState(resetConversation(generation, null, "loading"));
      unsub = input.client.subscribe({ scope: "runtime" }, onEvent);
      void readLatest(generation);
    },
    dispose() {
      disposed = true;
      requestGeneration += 1;
      unsub?.();
      unsub = undefined;
      liveBuffer = [];
      listeners.clear();
    },
    async loadOlder() {
      if (input.preview || loadingOlder || disposed || input.client === null || input.target === null) return;
      if (!state.hasMoreBefore || state.olderCursor === undefined || state.identity === null) return;
      const generation = requestGeneration;
      const cursor: OpaqueCursor = state.olderCursor;
      const identity = state.identity;
      loadingOlder = true;
      emit();
      try {
        const page = await input.client.query("agent.conversation.read", {
          agentId: input.target.agentId as QueryInput<"agent.conversation.read">["agentId"],
          cursor,
          limit: PAGE_LIMIT,
        });
        if (disposed || generation !== requestGeneration) return;
        if (!sameIdentity(page, identity)) return;
        setState(hydratePage(state, page, state.generation, "prepend"));
      } catch (cause) {
        if (disposed || generation !== requestGeneration) return;
        const error = asClientError(cause);
        if (isStaleCursorError(error) || error.code === "CURSOR_STALE") {
          void readLatest(generation);
          return;
        }
        setState({ ...state, hydrateStatus: "error", error });
      } finally {
        loadingOlder = false;
        emit();
      }
    },
  };
}
