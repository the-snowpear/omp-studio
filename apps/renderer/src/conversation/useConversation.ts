import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import { createConversationEngine, defaultConversationEngineInput, type ConversationEngine, type ConversationSnapshot } from "./conversationEngine";
import type { PendingUser } from "./conversationViewModel";

export type UseConversationInput = { readonly preview: boolean; readonly client: ConversationClient | null; readonly identity: ConversationIdentity | null; readonly canRead: boolean; readonly runtimeConnected: boolean; readonly deferHydrate?: boolean; readonly previewThreadId?: string };
export type UseConversationResult = ConversationSnapshot & { readonly engine: ConversationEngine; loadOlder: () => void; reload: () => Promise<void>; restoreFromUser: (itemId: string) => boolean; trackPending: (pending: PendingUser) => void; failPending: (requestId: string, error: string) => void; dropPending: (requestId: string) => void; settleOpenTurns: () => boolean };

export function retainConversationWhileRemounting(current: ConversationSnapshot, previous: ConversationSnapshot | undefined, sessionId: ConversationIdentity["sessionId"] | undefined): ConversationSnapshot {
  const remounting = current.state.hydrateStatus === "idle" || current.state.hydrateStatus === "loading";
  if (!remounting || current.rows.length > 0 || sessionId === undefined || previous === undefined || previous.rows.length === 0 || previous.state.identity?.sessionId !== sessionId) return current;
  return previous;
}

export function useConversation(input: UseConversationInput): UseConversationResult {
  const engine = useMemo(() => createConversationEngine(defaultConversationEngineInput(input)), [input.preview, input.client, input.identity?.sessionId, input.identity?.runtimeEpoch, input.identity?.transcriptRevision, input.canRead, input.runtimeConnected, input.deferHydrate, input.previewThreadId]);
  useEffect(() => { engine.start(); return () => engine.dispose(); }, [engine]);
  // The workbench consumes only low-frequency metadata. Token/tool deltas are
  // subscribed inside ConversationPane so they cannot wake the whole canvas.
  const current = useSyncExternalStore(engine.subscribeMetadata, engine.getMetadataSnapshot, engine.getMetadataSnapshot);
  const previous = useRef<ConversationSnapshot | undefined>(undefined);
  const retained = retainConversationWhileRemounting(current, previous.current, input.identity?.sessionId);
  if (retained.rows.length > 0) previous.current = retained;
  else if (current.state.hydrateStatus === "ready" || current.state.hydrateStatus === "error" || current.state.hydrateStatus === "unavailable") previous.current = undefined;
  const callbacks = useRef({
    loadOlder: () => engine.loadOlder(), reload: () => engine.reload(), restoreFromUser: (itemId: string) => engine.restoreFromUser(itemId),
    trackPending: (pending: PendingUser) => engine.trackPending(pending), failPending: (requestId: string, error: string) => engine.failPending(requestId, error), dropPending: (requestId: string) => engine.dropPending(requestId),
    settleOpenTurns: () => engine.settleOpenTurns(),
  });
  callbacks.current = { loadOlder: () => engine.loadOlder(), reload: () => engine.reload(), restoreFromUser: (itemId) => engine.restoreFromUser(itemId), trackPending: (pending) => engine.trackPending(pending), failPending: (requestId, error) => engine.failPending(requestId, error), dropPending: (requestId) => engine.dropPending(requestId), settleOpenTurns: () => engine.settleOpenTurns() };
  const stable = useRef({
    loadOlder: () => callbacks.current.loadOlder(), reload: () => callbacks.current.reload(), restoreFromUser: (itemId: string) => callbacks.current.restoreFromUser(itemId),
    trackPending: (pending: PendingUser) => callbacks.current.trackPending(pending), failPending: (requestId: string, error: string) => callbacks.current.failPending(requestId, error), dropPending: (requestId: string) => callbacks.current.dropPending(requestId),
    settleOpenTurns: () => callbacks.current.settleOpenTurns(),
  }).current;
  return { ...retained, engine, ...stable };
}
