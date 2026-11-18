import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { QueuedMessage } from "../MessageQueueBar";
import type { QueueEditState } from "../composer/queueEdit";
import { emptySnapshot, type ComposerSnapshot } from "../composer/types";
import type { ScrollAnchor } from "./useConversationScroll";
import type { AgentBtwState } from "@omp-studio/studio-protocol";

export type SubagentQueuedMessage = QueuedMessage & { readonly agentGeneration?: number };
export type SubagentBtwViewState = { draft: ComposerSnapshot; topic: string; previewState?: AgentBtwState; previewHistory?: Record<string, AgentBtwState["turns"]> };
export type SubagentViewState = {
  draft: ComposerSnapshot;
  queued: SubagentQueuedMessage[];
  queueEdit: QueueEditState | undefined;
  error: string | undefined;
  nextQueueId: number;
  contentTab?: "chat" | "details" | "btw";
  btwVisited?: boolean;
  /** Deck requests retain their sequence with the target across workbench remounts. */
  btwIntentSerial?: number;
  /** The last "open on BTW" request this tab has applied, so a remount does not apply it again. */
  btwIntentSeen?: number;
  btw: SubagentBtwViewState;
  reading?: { anchor: ScrollAnchor | null; following: boolean; rows: number; conversationSessionId?: string };
};

export function createSubagentViewState(): SubagentViewState {
  return { draft: emptySnapshot(), queued: [], queueEdit: undefined, error: undefined, nextQueueId: 0, btw: { draft: emptySnapshot(), topic: "" } };
}

export function nextSubagentBtwIntent(record: SubagentViewState): number {
  record.btwIntentSerial = (record.btwIntentSerial ?? 0) + 1;
  return record.btwIntentSerial;
}

/** Scope includes execution target, workspace, parent session and preview mode. */
export function subagentViewKey(scope: string, agentId: string): string {
  return JSON.stringify([scope, agentId]);
}

const SUBAGENT_VIEW_BOOK_MAX_ENTRIES = 64;

function isIdleSubagentViewState(state: SubagentViewState): boolean {
  return (
    state.queued.length === 0
    && state.queueEdit === undefined
    && state.draft.text.length === 0
    && state.draft.images.length === 0
    && state.btw.draft.text.length === 0
    && state.btw.draft.images.length === 0
  );
}

export function createSubagentViewBook(maxEntries = SUBAGENT_VIEW_BOOK_MAX_ENTRIES) {
  const entries = new Map<string, SubagentViewState>();
  const prune = () => {
    if (entries.size <= maxEntries) return;
    for (const [candidateKey, candidateState] of entries) {
      if (entries.size <= maxEntries) break;
      if (isIdleSubagentViewState(candidateState)) entries.delete(candidateKey);
    }
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  };
  return {
    get(key: string): SubagentViewState {
      let value = entries.get(key);
      if (value !== undefined) {
        entries.delete(key);
        entries.set(key, value);
        return value;
      }
      value = createSubagentViewState();
      entries.set(key, value);
      prune();
      return value;
    },
    delete(key: string): boolean {
      return entries.delete(key);
    },
    get size(): number {
      return entries.size;
    },
  };
}

/** Kept for this renderer lifetime, including execution-target remounts. */
export const sharedSubagentViewBook = createSubagentViewBook();

/** Writes outlive the mounted editor, including receipts returned after switching targets. */
export function useSubagentViewField<K extends "draft" | "queued" | "queueEdit" | "error">(
  record: SubagentViewState, key: K,
): [SubagentViewState[K], Dispatch<SetStateAction<SubagentViewState[K]>>] {
  const [, refresh] = useState(0);
  const set: Dispatch<SetStateAction<SubagentViewState[K]>> = useCallback(action => {
    record[key] = typeof action === "function"
      ? (action as (value: SubagentViewState[K]) => SubagentViewState[K])(record[key])
      : action;
    refresh(value => value + 1);
  }, [record, key]);
  return [record[key], set];
}
