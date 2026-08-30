import type { ClientEvent, ConversationItem, SessionId, StudioClient } from "@omp-studio/client-contract";
import { CONVERSATION_LIMITS, utf8ByteLength } from "@omp-studio/client-contract";
import type { AgentId, ConversationTarget } from "@omp-studio/studio-protocol";
import { previewSubagentConversationItems } from "../preview/subagentConversation";
import { asClientError, identityKey, isStaleCursorError } from "./conversationHost";
import { createConversationSource } from "./conversationSource";
import { ConversationStore } from "./conversationStore";
import type { ConversationState, TimelineRow } from "./conversationViewModel";
import type { SubagentHubTarget } from "./toolMeta";

export type SubagentConversationClient = Pick<StudioClient, "query" | "subscribe">;
export type SubagentConversationEngineInput = { readonly preview: boolean; readonly previewItems: readonly ConversationItem[]; readonly client: SubagentConversationClient | null; readonly target: SubagentHubTarget | null; readonly runtimeConnected: boolean; readonly parentSessionId?: SessionId; readonly liveSessionId?: SessionId };
export type SubagentConversationSnapshot = { readonly state: ConversationState; readonly rows: readonly TimelineRow[]; readonly demo: boolean; readonly loadingOlder: boolean; readonly identityKey: string };
export type SubagentConversationEngine = { getSnapshot(): SubagentConversationSnapshot; subscribe(listener: () => void): () => void; start(): void; dispose(): void; loadOlder(): Promise<void> };

let generation = 10_000;
const OPEN_BUFFER_MAX_BYTES = 2 * 1024 * 1024;
export function createSubagentConversationEngine(input: SubagentConversationEngineInput): SubagentConversationEngine {
  const parentSessionId = input.parentSessionId ?? input.liveSessionId;
  const initialSessionId = parentSessionId ?? ("unavailable" as SessionId);
  const store = new ConversationStore({ target: { sessionId: initialSessionId, ...(input.target === null ? {} : { agentId: input.target.agentId }) }, identity: parentSessionId === undefined ? null : { sessionId: parentSessionId }, generation: generation++ });
  const listeners = new Set<() => void>(); let disposed = false; let started = false; let loadingOlder = false; let token = 0;
  let unsubscribe: (() => void) | undefined; let conversationSessionId: SessionId | undefined; let watermark = 0; let buffered: Array<Extract<ClientEvent, { kind: "conversation.changed" }>> = []; let bufferedBytes = 0; let bufferOverflowed = false;
  let liveTarget: ConversationTarget | undefined;
  let snapshot: SubagentConversationSnapshot = { ...store.getSnapshot(), demo: input.preview, loadingOlder, identityKey: identityKey(store.getSnapshot().state.identity) };
  const offStore = store.subscribe(() => publish());
  function publish(): void { if (disposed) return; const value = store.getSnapshot(); snapshot = { ...value, demo: input.preview, loadingOlder, identityKey: identityKey(value.state.identity) }; for (const listener of listeners) listener(); }
  function applyLiveEvent(event: Extract<ClientEvent, { kind: "conversation.changed" }>): void {
    if (event.streamSeq <= watermark) return;
    if (event.streamSeq !== watermark + 1) {
      store.requireResync("子 Agent 对话流序号不连续，正在重新同步。");
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
      if (bytes > OPEN_BUFFER_MAX_BYTES) { buffered = []; bufferedBytes = 0; bufferOverflowed = true; return; }
      buffered.push(event); bufferedBytes += bytes;
      while (bufferedBytes > OPEN_BUFFER_MAX_BYTES && buffered.length > 0) { bufferOverflowed = true; bufferedBytes -= utf8ByteLength(JSON.stringify(buffered.shift())); }
      return;
    }
    if (event.sessionId !== conversationSessionId) return;
    applyLiveEvent(event);
  }
  async function hydrate(resyncing = false): Promise<void> {
    const current = ++token; buffered = []; bufferedBytes = 0; bufferOverflowed = false; conversationSessionId = undefined; watermark = 0;
    if (input.target === null) { store.setUnavailable("没有可读取的子 Agent 对话。"); return; }
    store.setLoading(resyncing);
    if (input.preview) { store.hydrate({ items: input.previewItems, headCursor: "preview" as never, hasMoreBefore: false }); return; }
    if (parentSessionId === undefined) { store.setUnavailable("没有可读取的子 Agent 对话。"); return; }
    if (input.client === null) { store.setUnavailable("当前环境无法读取子 Agent 对话。"); return; }
    const source = createConversationSource(input.client);
    const target: ConversationTarget = { kind: "agent", parentSessionId, agentId: input.target.agentId as AgentId };
    liveTarget = target;
    try {
      if (input.runtimeConnected && input.liveSessionId === parentSessionId) {
        const opened = await source.open(target, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
        if (disposed || current !== token) return; const resolvedSessionId = opened.target.conversationSessionId; conversationSessionId = resolvedSessionId; store.resolveTarget(resolvedSessionId);
        watermark = opened.live.watermark;
        if (opened.live.status === "resyncRequired") {
          store.hydrate(opened.page, [], watermark);
          store.requireResync(opened.live.reason);
        } else {
          store.hydrate(opened.page, opened.live.events.map((event) => ({ streamSeq: event.streamSeq, update: event.update })), watermark);
        }
        const queued = buffered; const overflowed = bufferOverflowed; buffered = []; bufferedBytes = 0; bufferOverflowed = false;
        if (overflowed) { store.requireResync("打开子 Agent 对话期间的事件缓冲已满，正在重新同步。"); void hydrate(true); return; }
        for (const event of queued) if (event.sessionId === conversationSessionId) applyLiveEvent(event);
      } else {
        const page = await source.readArchive(parentSessionId, input.target.agentId, undefined, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
        if (disposed || current !== token) return; conversationSessionId = page.sessionId; store.resolveTarget(page.sessionId); store.hydrate(page);
      }
    } catch (cause) {
      try {
        const page = await source.readArchive(parentSessionId, input.target.agentId, undefined, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT);
        if (disposed || current !== token) return; conversationSessionId = page.sessionId; store.resolveTarget(page.sessionId); store.hydrate(page);
      } catch (fallback) { if (!disposed && current === token) store.setError(asClientError(fallback ?? cause)); }
    }
  }
  async function loadOlder(): Promise<void> {
    if (disposed || loadingOlder || input.client === null || input.target === null || parentSessionId === undefined) return;
    const cursor = store.getOlderCursor(); if (cursor === undefined) return; loadingOlder = true; publish(); const current = token; const source = createConversationSource(input.client);
    try { const page = liveTarget !== undefined && input.runtimeConnected ? await source.readLiveOlder(liveTarget, cursor, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT) : await source.readArchive(parentSessionId, input.target.agentId, cursor, CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT); if (!disposed && current === token) store.prepend(page); }
    catch (cause) { const error = asClientError(cause); if (isStaleCursorError(error)) await hydrate(true); else if (!disposed && current === token) store.setError(error); }
    finally { if (!disposed && current === token) { loadingOlder = false; publish(); } }
  }
  return {
    getSnapshot: () => snapshot, subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    start() { if (started || disposed) return; started = true; if (!input.preview && input.client !== null) unsubscribe = createConversationSource(input.client).subscribe(onEvent); void hydrate(); },
    dispose() { if (disposed) return; disposed = true; token += 1; unsubscribe?.(); offStore(); store.dispose(); listeners.clear(); buffered = []; bufferedBytes = 0; bufferOverflowed = false; }, loadOlder,
  };
}

export function subagentEngineInput(input: Omit<SubagentConversationEngineInput, "previewItems">): SubagentConversationEngineInput {
  return { ...input, previewItems: input.preview && input.target !== null ? previewSubagentConversationItems(input.target.agentId) : [] };
}
