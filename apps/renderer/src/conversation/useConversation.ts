import { useEffect, useReducer, useRef } from "react";
import type { ConversationClient, ConversationIdentity } from "./conversationHost";
import { identityKey } from "./conversationHost";
import { createConversationEngine, type ConversationEngine, type ConversationSnapshot } from "./conversationEngine";
import { emptyConversationState, type PendingUser } from "./conversationViewModel";
import { PREVIEW_CONVO_IDENTITY, PREVIEW_CONVO_LIVE, previewConversationItems } from "../preview/conversationFixtures";

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

export function useConversation(input: UseConversationInput): UseConversationResult {
  const [, bump] = useReducer((value: number) => value + 1, 0);
  const engineRef = useRef<ConversationEngine | null>(null);
  const clientRef = useRef(input.client);
  clientRef.current = input.client;
  // Runtime residency is deliberately not part of the conversation engine
  // identity: a dormant session retains its persistent transcript while its
  // execution worker is offline or recovering.
  const key = `${input.preview}:${input.canRead}:${identityKey(input.identity)}:${input.previewThreadId ?? ""}`;
  const keyRef = useRef(key);
  if (keyRef.current !== key) {
    engineRef.current?.dispose();
    engineRef.current = null;
    keyRef.current = key;
  }

  useEffect(() => {
    const engine = createConversationEngine({
      preview: input.preview,
      client: input.preview ? null : clientRef.current,
      identity: input.preview ? PREVIEW_CONVO_IDENTITY : input.identity,
      canRead: input.canRead,
      runtimeConnected: input.runtimeConnected,
      previewItems: previewConversationItems(input.previewThreadId),
      previewLive: PREVIEW_CONVO_LIVE,
    });
    engineRef.current = engine;
    const off = engine.subscribe(() => bump());
    engine.start();
    bump();
    return () => {
      off();
      engine.dispose();
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [key]);

  let snapshot = emptySnapshot;
  try {
    snapshot = engineRef.current?.getSnapshot() ?? emptySnapshot;
  } catch {
    snapshot = emptySnapshot;
  }
  return {
    ...snapshot,
    loadOlder: () => {
      void engineRef.current?.loadOlder();
    },
    reload: () => engineRef.current?.reload() ?? Promise.resolve(),
    restoreFromUser: (itemId) => engineRef.current?.restoreFromUser(itemId) ?? false,
    trackPending: (pending) => engineRef.current?.trackPending(pending),
    failPending: (requestId, error) => engineRef.current?.failPending(requestId, error),
    dropPending: (requestId) => engineRef.current?.dropPending(requestId),
  };
}
