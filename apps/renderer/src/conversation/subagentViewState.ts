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
  btw: SubagentBtwViewState;
  reading?: { anchor: ScrollAnchor | null; following: boolean; rows: number; conversationSessionId?: string };
};

export function createSubagentViewState(): SubagentViewState {
  return { draft: emptySnapshot(), queued: [], queueEdit: undefined, error: undefined, nextQueueId: 0, btw: { draft: emptySnapshot(), topic: "" } };
}

/** Scope includes execution target, workspace, parent session and preview mode. */
export function subagentViewKey(scope: string, agentId: string): string {
  return JSON.stringify([scope, agentId]);
}

export function createSubagentViewBook() {
  const entries = new Map<string, SubagentViewState>();
  return {
    get(key: string): SubagentViewState {
      let value = entries.get(key);
      if (value === undefined) { value = createSubagentViewState(); entries.set(key, value); }
      return value;
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
