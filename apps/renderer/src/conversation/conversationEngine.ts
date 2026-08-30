import type { ClientEvent, ConversationItem, ConversationRuntimeEvent } from "@omp-studio/client-contract";
import { CONVERSATION_LIMITS, utf8ByteLength } from "@omp-studio/client-contract";
import type { ConversationTarget } from "@omp-studio/studio-protocol";
import { PREVIEW_CONVO_IDENTITY, PREVIEW_CONVO_LIVE, previewConversationItems } from "../preview/conversationFixtures";
import { asClientError, identityKey, isStaleCursorError, type ConversationClient, type ConversationIdentity } from "./conversationHost";
import { createConversationSource } from "./conversationSource";
import { ConversationStore } from "./conversationStore";
import type { ConversationState, PendingUser, TimelineRow } from "./conversationViewModel";
import { getDefaultThumbStore, type UserThumbStore } from "./userMessageThumbs";

export type ConversationEngineInput = {
  readonly preview: boolean; readonly client: ConversationClient | null; readonly identity: ConversationIdentity | null;
  readonly canRead: boolean; readonly runtimeConnected: boolean; readonly previewItems: readonly ConversationItem[];
  readonly previewLive?: readonly ConversationRuntimeEvent[]; readonly thumbStore?: UserThumbStore;
};
export type ConversationSnapshot = { readonly state: ConversationState; readonly rows: readonly TimelineRow[]; readonly demo: boolean; readonly loadingOlder: boolean; readonly identityKey: string };
export type ConversationEngine = {
  getSnapshot(): ConversationSnapshot; subscribe(listener: () => void): () => void;
  getMetadataSnapshot(): ConversationSnapshot; subscribeMetadata(listener: () => void): () => void;
  start(): void; dispose(): void; loadOlder(): Promise<void>; reload(): Promise<void>;
  restoreFromUser(itemId: string): boolean; trackPending(pending: PendingUser): void; failPending(requestId: string, error: string): void; dropPending(requestId: string): void;
};

let nextGeneration = 1;
type BufferedConversationEvent = Extract<ClientEvent, { kind: "conversation.changed" }>;
const OPEN_BUFFER_MAX_BYTES = 2 * 1024 * 1024;

export function createConversationEngine(input: ConversationEngineInput): ConversationEngine {
  const generation = nextGeneration++;
  const identity = input.preview ? PREVIEW_CONVO_IDENTITY : input.identity;
  const store = new ConversationStore({ target: { sessionId: identity?.sessionId ?? ("unavailable" as ConversationIdentity["sessionId"]) }, identity, generation });
  const listeners = new Set<() => void>();
  const metadataListeners = new Set<() => void>();
  let transportUnsubscribe: (() => void) | undefined;
  let started = false; let disposed = false; let loadingOlder = false; let run = 0;
  const storeUnsubscribe = store.subscribe(() => publish());
  let metadataSnapshot: ConversationSnapshot;
  const storeMetadataUnsubscribe = store.subscribeMetadata(() => {
    if (disposed) return;
    const value = store.getMetadataSnapshot(); metadataSnapshot = { ...value, demo: input.preview, loadingOlder, identityKey: identityKey(value.state.identity) };
    for (const listener of metadataListeners) listener();
  });
  let liveTarget: ConversationTarget | undefined; let conversationSessionId: string | undefined; let watermark = 0;
  let buffer: BufferedConversationEvent[] = []; let bufferBytes = 0; let bufferOverflowed = false;
  let snapshot: ConversationSnapshot = { ...store.getSnapshot(), demo: input.preview, loadingOlder: false, identityKey: identityKey(identity) };
  metadataSnapshot = { ...store.getMetadataSnapshot(), demo: input.preview, loadingOlder: false, identityKey: identityKey(identity) };

  function publish(): void {
    if (disposed) return;
    snapshot = { ...store.getSnapshot(), demo: input.preview, loadingOlder, identityKey: identityKey(store.getSnapshot().state.identity) };
    for (const listener of listeners) listener();
  }
  function applyLiveEvent(event: BufferedConversationEvent): void {
    if (event.streamSeq <= watermark) return;
    if (event.streamSeq !== watermark + 1) {
      store.requireResync("对话流序号不连续，正在重新同步。");
      void hydrate(true);
      return;
    }
    watermark = event.streamSeq;
    store.applyEvent(event.update, event.streamSeq);
  }
  function onEvent(event: ClientEvent): void {
    if (event.kind === "resync.required") { store.requireResync(event.reason); void hydrate(true); return; }
    if (event.kind !== "conversation.changed") return;
    if (conversationSessionId === undefined) {
      const bytes = utf8ByteLength(JSON.stringify(event));
      if (bytes > OPEN_BUFFER_MAX_BYTES) { buffer = []; bufferBytes = 0; bufferOverflowed = true; return; }
      buffer.push(event); bufferBytes += bytes;
      while (bufferBytes > OPEN_BUFFER_MAX_BYTES && buffer.length > 0) {
        bufferOverflowed = true;
        bufferBytes -= utf8ByteLength(JSON.stringify(buffer.shift()));
      }
      return;
    }
    if (event.sessionId !== conversationSessionId) return;
    applyLiveEvent(event);
  }
  async function loadThumbs(token: number, sessionId: string): Promise<void> {
    try { const thumbs = await (input.thumbStore ?? getDefaultThumbStore()).load(sessionId); if (!disposed && token === run) store.setUserThumbs(thumbs); } catch { /* local decoration never blocks transcript */ }
  }
  async function hydrate(resyncing = false): Promise<void> {
    const token = ++run; buffer = []; bufferBytes = 0; bufferOverflowed = false; conversationSessionId = undefined; watermark = 0;
    if (identity === null) { store.setUnavailable("当前没有活动会话。"); return; }
    if (input.preview) {
      store.setLoading(resyncing); store.hydrate({ items: input.previewItems, headCursor: "preview" as never, hasMoreBefore: false }, (input.previewLive ?? []).map((update, index) => ({ streamSeq: index + 1, update })), input.previewLive?.length ?? 0); return;
    }
    if (!input.canRead || input.client === null) { store.setUnavailable("当前环境无法读取对话。"); return; }
    store.setLoading(resyncing);
    const source = createConversationSource(input.client);
    liveTarget = { kind: "session", sessionId: identity.sessionId };
    try {
      if (input.runtimeConnected && identity.runtimeEpoch !== undefined) {
        const opened = await source.open(liveTarget, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
        if (disposed || token !== run) return;
        const resolvedSessionId = opened.target.conversationSessionId; conversationSessionId = resolvedSessionId; store.resolveTarget(resolvedSessionId);
        watermark = opened.live.watermark;
        if (opened.live.status === "resyncRequired") {
          store.hydrate(opened.page, [], watermark);
          store.requireResync(opened.live.reason);
        } else {
          store.hydrate(opened.page, opened.live.events.map((event) => ({ streamSeq: event.streamSeq, update: event.update })), watermark);
        }
        const buffered = buffer; const overflowed = bufferOverflowed; buffer = []; bufferBytes = 0; bufferOverflowed = false;
        if (overflowed) { store.requireResync("打开对话期间的事件缓冲已满，正在重新同步。"); void hydrate(true); return; }
        for (const event of buffered) if (event.sessionId === conversationSessionId) applyLiveEvent(event);
      } else {
        const page = await source.readArchive(identity.sessionId, undefined, undefined, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
        if (disposed || token !== run) return; conversationSessionId = identity.sessionId; store.hydrate(page);
      }
      void loadThumbs(token, identity.sessionId);
    } catch (cause) {
      if (disposed || token !== run) return;
      try {
        const page = await source.readArchive(identity.sessionId, undefined, undefined, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
        if (disposed || token !== run) return; conversationSessionId = identity.sessionId; store.hydrate(page); void loadThumbs(token, identity.sessionId);
      } catch (fallbackCause) { if (!disposed && token === run) store.setError(asClientError(fallbackCause ?? cause)); }
    }
  }
  async function loadOlder(): Promise<void> {
    if (disposed || loadingOlder || input.client === null) return; const cursor = store.getOlderCursor(); if (cursor === undefined) return;
    loadingOlder = true; publish(); metadataSnapshot = { ...store.getMetadataSnapshot(), demo: input.preview, loadingOlder, identityKey: identityKey(store.getMetadataSnapshot().state.identity) }; for (const listener of metadataListeners) listener(); const token = run; const source = createConversationSource(input.client);
    try {
      const page = liveTarget !== undefined && input.runtimeConnected ? await source.readLiveOlder(liveTarget, cursor, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT) : await source.readArchive(identity!.sessionId, undefined, cursor, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
      if (!disposed && token === run) store.prepend(page);
    } catch (cause) { const error = asClientError(cause); if (isStaleCursorError(error)) await hydrate(true); else if (!disposed && token === run) store.setError(error); }
    finally { if (!disposed && token === run) { loadingOlder = false; publish(); metadataSnapshot = { ...store.getMetadataSnapshot(), demo: input.preview, loadingOlder, identityKey: identityKey(store.getMetadataSnapshot().state.identity) }; for (const listener of metadataListeners) listener(); } }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    getMetadataSnapshot: () => metadataSnapshot,
    subscribeMetadata(listener) { if (disposed) return () => {}; metadataListeners.add(listener); return () => metadataListeners.delete(listener); },
    start() { if (started || disposed) return; started = true; if (!input.preview && input.client !== null) transportUnsubscribe = createConversationSource(input.client).subscribe(onEvent); void hydrate(); },
    dispose() { if (disposed) return; disposed = true; run += 1; transportUnsubscribe?.(); storeUnsubscribe(); storeMetadataUnsubscribe(); store.dispose(); listeners.clear(); metadataListeners.clear(); buffer = []; bufferBytes = 0; bufferOverflowed = false; },
    loadOlder,
    reload: () => hydrate(true),
    restoreFromUser: (itemId) => input.preview && store.restoreFromUser(itemId),
    trackPending: (pending) => store.trackPending(pending),
    failPending: (requestId, error) => store.failPending(requestId, error),
    dropPending: (requestId) => store.dropPending(requestId),
  };
}

export function defaultConversationEngineInput(input: Omit<ConversationEngineInput, "previewItems" | "previewLive"> & { readonly previewThreadId?: string }): ConversationEngineInput {
  return { ...input, previewItems: input.preview ? previewConversationItems(input.previewThreadId) : [], ...(input.preview ? { previewLive: PREVIEW_CONVO_LIVE } : {}) };
}
