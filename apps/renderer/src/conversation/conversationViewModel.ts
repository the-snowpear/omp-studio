import type {
  ConversationCompactionItem,
  ConversationContentBlock,
  ConversationItem,
  ConversationMessageError,
  ConversationMessageItem,
  ConversationResetBoundaryItem,
  JsonValue,
  OpaqueCursor,
} from "@omp-studio/client-contract";
import type { ComposerDoc } from "../composer/types";
import type { ConversationIdentity } from "./conversationHost";
import type { UserMessageThumb, UserThumbMap } from "./userMessageThumbs";

export type ToolStatus = "queued" | "running" | "succeeded" | "failed" | "aborted" | "missing";

export type LiveBlock = {
  readonly blockId: string;
  readonly blockType: "text" | "thinking";
  readonly text: string;
  /** Set once the live buffer hit its cap; later deltas for the block are dropped. */
  readonly truncated?: boolean;
};

export type LiveMessage = {
  readonly messageId: string;
  readonly turnId: string;
  readonly role: ConversationMessageItem["role"];
  readonly createdAt: string;
  readonly blocks: readonly LiveBlock[];
  readonly aborted: boolean;
};

export type LiveTool = {
  readonly toolCallId: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly arguments?: JsonValue;
  readonly output?: string;
  readonly truncated?: boolean;
  readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>;
  readonly status: ToolStatus;
};

export type PendingUser = {
  readonly requestId: string;
  readonly text: string;
  readonly draft: string;
  readonly status: "pending" | "failed";
  readonly knownItemIds: readonly string[];
  readonly error?: string;
  /** Composer capsules at send time; used so the bubble does not fall back to @ / tokens. */
  readonly doc?: ComposerDoc;
};

export type ConversationNotice = {
  readonly id: string;
  readonly level: "info" | "warning" | "error";
  readonly message: string;
  readonly source?: string;
};

export type HydrateStatus = "idle" | "loading" | "ready" | "error" | "resyncing" | "unavailable";

export type ConversationState = {
  readonly generation: number;
  readonly identity: ConversationIdentity | null;
  readonly items: readonly ConversationItem[];
  readonly liveMessages: { readonly [messageId: string]: LiveMessage };
  readonly liveTools: { readonly [toolCallId: string]: LiveTool };
  readonly liveOrder: readonly string[];
  readonly olderCursor?: OpaqueCursor;
  readonly headCursor?: OpaqueCursor;
  readonly hasMoreBefore: boolean;
  readonly hydrateStatus: HydrateStatus;
  readonly unavailableReason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly notices: readonly ConversationNotice[];
  readonly pendingUsers: readonly PendingUser[];
  readonly lastEventSeq?: number;
  readonly resyncRequired: boolean;
  /** Capsule docs transferred from pending → persisted itemId for the current session. */
  readonly userDisplays: { readonly [itemId: string]: ComposerDoc };
  /** Preview bytes for user-bubble thumbnails (local store + in-session absorb). */
  readonly userThumbs: UserThumbMap;
  /**
   * Persisted itemId → owning turnId while that turn is still running. OMP
   * persists the assistant item before its first tool starts, so only a closed
   * turn proves a resultless toolCall lost its result.
   */
  readonly openTurnItems: { readonly [itemId: string]: string };
  /**
   * Live compaction divider. Set by `conversation.compaction.started`;
   * cleared when the persisted compaction item (or abort) arrives.
   */
  readonly compacting?: { readonly action: string };
};

export type ToolView = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments?: JsonValue;
  readonly output?: string;
  readonly result?: Extract<ConversationContentBlock, { type: "toolResult" }>;
  readonly status: ToolStatus;
  readonly truncated?: boolean;
};

export type AssistantSegment =
  | { readonly type: "text"; readonly key: string; readonly text: string; readonly truncated?: boolean; readonly streaming?: boolean }
  | { readonly type: "thinking"; readonly key: string; readonly text: string; readonly truncated?: boolean }
  | { readonly type: "batch"; readonly key: string; readonly tools: readonly ToolView[] };

export type TimelineRow =
  | {
      readonly type: "user";
      readonly itemId: string;
      readonly createdAt: string;
      readonly text: string;
      readonly pending?: PendingUser["status"];
      readonly requestId?: string;
      readonly error?: string;
      readonly doc?: ComposerDoc;
      readonly thumbs?: readonly UserMessageThumb[];
    }
  | {
      readonly type: "assistant";
      readonly itemId: string;
      readonly createdAt: string;
      readonly segments: readonly AssistantSegment[];
      readonly status: "streaming" | "completed" | "aborted" | "error";
      /** Process rows omit the repeated OMP identity header; only the final reply in a turn uses reply. */
      readonly presentation?: "process" | "reply";
      /**
       * The owning Runtime turn is still running (`openTurnItems`). File-edit
       * tools can finish and mark this row completed while more steps remain;
       * the transcript diff card waits until this flag clears.
       */
      readonly turnOpen?: boolean;
      /** Provider failure from `conversation.message.completed`, latched until the next assistant stream starts or a later return succeeds. */
      readonly error?: ConversationMessageError;
    }
  | { readonly type: "compaction"; readonly item: ConversationCompactionItem }
  | { readonly type: "compacting"; readonly action?: string }
  | { readonly type: "resetBoundary"; readonly item: ConversationResetBoundaryItem };

export const COMPACTING_ROW_ID = "compacting";

export function timelineRowKey(row: TimelineRow): string {
  if (row.type === "compacting") return COMPACTING_ROW_ID;
  if (row.type === "compaction" || row.type === "resetBoundary") return row.item.itemId;
  return row.itemId;
}

/** Append the in-progress compact divider once, at the end of the transcript. */
export function withCompactingRow(
  rows: readonly TimelineRow[],
  compacting: boolean,
  action?: string,
): TimelineRow[] {
  if (!compacting) return [...rows];
  if (rows.some((row) => row.type === "compacting")) return [...rows];
  return [...rows, { type: "compacting", ...(action === undefined || action.length === 0 ? {} : { action }) }];
}

export function emptyConversationState(generation = 0): ConversationState {
  return {
    generation,
    identity: null,
    items: [],
    liveMessages: {},
    liveTools: {},
    liveOrder: [],
    hasMoreBefore: false,
    hydrateStatus: "idle",
    notices: [],
    pendingUsers: [],
    resyncRequired: false,
    userDisplays: {},
    userThumbs: {},
    openTurnItems: {},
  };
}

export function resetConversation(
  generation: number,
  identity: ConversationIdentity | null,
  hydrateStatus: HydrateStatus,
  unavailableReason?: string,
): ConversationState {
  return {
    ...emptyConversationState(generation),
    identity,
    hydrateStatus,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
}

export function messageText(item: ConversationMessageItem): string {
  return item.content
    .filter((block): block is Extract<ConversationContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function jsonRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as { readonly [key: string]: JsonValue };
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function formatJson(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

// --- Deleted: streaming state machine, WeakMap caches, timeline builder, segment aggregation ---
