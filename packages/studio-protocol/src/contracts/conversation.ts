import type { OpaqueCursor, RuntimeEpoch, SessionId } from "./ids.js";

/**
 * Strict JSON value. Classes, functions, symbols, `undefined`, `NaN`,
 * `Infinity`, cyclic graphs, and objects with a non-null/non-Object prototype
 * are not representable and must be rejected at the trust boundary.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ConversationRole = "user" | "assistant" | "system";

export type ConversationContentBlock =
  | { type: "text"; text: string; truncated?: boolean }
  | { type: "thinking"; text: string; truncated?: boolean }
  | {
      type: "toolCall";
      toolCallId: string;
      toolName: string;
      arguments?: JsonValue;
      truncated?: boolean;
    }
  | {
      type: "toolResult";
      toolCallId: string;
      toolName?: string;
      output?: string;
      data?: JsonValue;
      isError: boolean;
      truncated?: boolean;
    };

export type ConversationMessageItem = {
  kind: "message";
  itemId: string;
  parentId: string | null;
  createdAt: string;
  role: ConversationRole;
  content: readonly ConversationContentBlock[];
};

export type ConversationCompactionItem = {
  kind: "compaction";
  itemId: string;
  parentId: string | null;
  createdAt: string;
  summary: string;
  shortSummary?: string;
  warning?: string;
};

export type ConversationResetBoundaryItem = {
  kind: "resetBoundary";
  itemId: string;
  parentId: string | null;
  createdAt: string;
};

/**
 * Why an assistant turn produced nothing, carried on the live completion event
 * only. `provider`/`model` matter as much as the text: a gateway that advertises
 * a model through discovery but refuses to serve it is only diagnosable from the
 * pair that was actually requested.
 */
export type ConversationMessageError = {
  message: string;
  /** Provider HTTP status when the failure came from a request. */
  status?: number;
  provider?: string;
  model?: string;
};

/**
 * Persistent public transcript items. These are the only kinds Host/Renderer
 * may render from `session.transcript.read`.
 *
 * First-version mapping of OMP session entries (Commit B reader):
 * - `message` → `message`
 * - `compaction` → `compaction` (summary/shortSummary/warning only; never
 *   `preserveData`, `details`, or provider payloads)
 * - `reset_boundary` → `resetBoundary`
 * - `branch_summary` → **ignored** (`CONVERSATION_BRANCH_SUMMARY_MAPPING`)
 * - `custom` and any other entry type → ignored unless a later contract
 *   revision allow-lists a public kind
 *
 * Absolute session file paths, `providerPayload`, secrets, and unfiltered
 * custom data must never appear on this type.
 */
export type ConversationItem =
  | ConversationMessageItem
  | ConversationCompactionItem
  | ConversationResetBoundaryItem;

/**
 * Page of the current active branch, oldest-to-newest.
 *
 * - Omit `cursor` on the operation to read the latest page.
 * - `olderCursor` is the only cursor used to read an older page.
 * - `headCursor` is always present, including on an empty branch, so gap
 *   detection and reload share one cursor namespace.
 * - Sibling entries from other branches must not appear in `items`.
 */
export interface ConversationTranscriptPage {
  runtimeEpoch: RuntimeEpoch;
  sessionId: SessionId;
  branchLeafId: string | null;
  items: readonly ConversationItem[];
  olderCursor?: OpaqueCursor;
  headCursor: OpaqueCursor;
  hasMoreBefore: boolean;
}

/**
 * `session.transcript.read` is gated by the existing capability `session.history`.
 * The operation exists in the contract now; Runtime hello must not advertise
 * `session.history` as implemented until the transcript reader is wired
 * (plan 02 Commit B).
 */
export const SESSION_TRANSCRIPT_READ_KIND = "session.transcript.read" as const;
export const SESSION_TRANSCRIPT_READ_CAPABILITY = "session.history" as const;
export const SESSION_TRANSCRIPT_READ_CONCURRENCY = "read-concurrent" as const;

export type SessionTranscriptRead = {
  kind: typeof SESSION_TRANSCRIPT_READ_KIND;
  cursor?: OpaqueCursor;
  limit?: number;
};

/**
 * Opaque conversation cursor (wire type: `OpaqueCursor` string).
 *
 * Runtime encodes a signed payload in a **separate namespace** from
 * `agent.transcript.read` cursors. The payload binds:
 * - schema version (`CONVERSATION_CURSOR_SCHEMA_VERSION`)
 * - session identity
 * - runtime epoch (generation equivalent)
 * - active branch leaf id
 * - page boundary entry id
 * - direction (`older` only in v1)
 *
 * Must not encode file paths, tokens, or raw branch bytes. Host and Renderer
 * treat the string as opaque and must not parse it.
 *
 * Tampered / malformed / wrong-namespace cursor → `INVALID_ARGUMENT`.
 * Well-formed cursor for a different session, branch leaf, or epoch → `CURSOR_STALE`.
 */
export const CONVERSATION_CURSOR_SCHEMA_VERSION = 1 as const;
export const CONVERSATION_CURSOR_DIRECTION = "older" as const;
export const CONVERSATION_CURSOR_NAMESPACE = "session.transcript.v1" as const;

/**
 * Frozen size and safety limits. Projectors and tests must import these
 * rather than scattering magic numbers. Truncation of oversized native
 * content is a Runtime sanitizer concern (Commit B) and must set
 * `truncated: true`. The trust-boundary parsers below **reject** over-limit
 * public payloads so a buggy projector cannot pass a frame that exceeds the
 * Bridge budget.
 */
export const CONVERSATION_LIMITS = {
  TRANSCRIPT_LIMIT_MIN: 1,
  TRANSCRIPT_LIMIT_MAX: 100,
  TRANSCRIPT_LIMIT_DEFAULT: 50,
  TEXT_BLOCK_MAX_BYTES: 256 * 1024,
  JSON_VALUE_MAX_BYTES: 256 * 1024,
  JSON_VALUE_MAX_DEPTH: 12,
  /** Must remain below `DEFAULT_MAX_CONTROL_FRAME_BYTES` (1 MiB). */
  PAGE_MAX_BYTES: 768 * 1024,
  CURSOR_MAX_CHARS: 1024,
  ITEM_ID_MAX_CHARS: 256,
  TOOL_NAME_MAX_CHARS: 256,
  NOTICE_MESSAGE_MAX_CHARS: 16 * 1024,
  DELTA_MAX_BYTES: 32 * 1024,
  COMPACTION_SUMMARY_MAX_BYTES: 256 * 1024,
} as const;

/**
 * First-version `branch_summary` handling: skip the entry. Do not map it to
 * `compaction`. A later contract revision may introduce a dedicated public
 * kind; until then Host/Renderer must not invent one.
 */
export const CONVERSATION_BRANCH_SUMMARY_MAPPING = "ignore" as const;

export const CONVERSATION_PUBLIC_ITEM_KINDS = ["message", "compaction", "resetBoundary"] as const;
export const CONVERSATION_IGNORED_SESSION_ENTRY_TYPES = [
  "branch_summary",
  "custom",
  "label",
  "model_change",
  "service_tier_change",
] as const;

/**
 * Frozen: a pure `conversation.message.delta` must increment `eventSeq` but
 * must **not** increment envelope `stateVersion`. `stateVersion` advances when
 * persisted conversation authority changes (message/tool/turn/compaction
 * completed or aborted) or operator snapshot fields change.
 */
export const CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION = false as const;

/**
 * Secret-shaped key names. The Runtime sanitizer replaces matching keys
 * before a public item is emitted, except usage-count keys that only share
 * the substring `token` — see `conversationRedactKey`. Public parsers still
 * reject unknown item/block fields via exact-key checks.
 */
export const CONVERSATION_REDACT_KEY_PATTERN =
  /token|secret|password|api[_-]?key|authorization|cookie|providerpayload/iu;

/** Usage totals that contain `token` but are not credentials. */
const CONVERSATION_USAGE_TOKEN_KEYS =
  /^(tokens|tokensBefore|contextTokens|inputTokens|outputTokens|totalTokens|tokenUsage|tokensPerSecond)$/iu;

/** Whether a JSON key must be replaced with `[redacted]` on the public conversation surface. */
export function conversationRedactKey(key: string): boolean {
  if (CONVERSATION_USAGE_TOKEN_KEYS.test(key)) return false;
  return CONVERSATION_REDACT_KEY_PATTERN.test(key);
}

/**
 * Live conversation events. Time source freeze:
 *
 * - `StudioEventEnvelope.occurredAt` is the **only** event-emission timestamp.
 *   Inner payloads must not include `occurredAt`.
 * - `createdAt` / `startedAt` / `completedAt` on inner payloads are domain
 *   timestamps of the message or tool call, not emission time.
 * - Envelope also carries `runtimeEpoch`, `eventSeq`, and `stateVersion`.
 *   Inner payloads must not repeat those fields.
 *
 * Identity freeze:
 *
 * - `messageId` is the persistent SessionEntry id. Runtime must know this id
 *   before emitting `conversation.message.started`.
 * - `conversation.message.completed.item.itemId` **must equal** `messageId`.
 * - There is no `replacesLiveId`. Downstream must not correlate by text.
 */
export type ConversationRuntimeEvent =
  | {
      kind: "conversation.message.started";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      role: ConversationRole;
      createdAt: string;
    }
  | {
      kind: "conversation.message.delta";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      blockId: string;
      blockType: "text" | "thinking";
      delta: string;
    }
  | {
      kind: "conversation.message.completed";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      item: ConversationMessageItem;
      /**
       * Present when the assistant message ended with a provider error. The
       * persisted item has no error field; the client latches the last live
       * payload until that session's next assistant message completes without
       * an error.
       */
      error?: ConversationMessageError;
    }
  | {
      kind: "conversation.tool.started";
      sessionId: SessionId;
      turnId: string;
      messageId: string;
      toolCallId: string;
      toolName: string;
      arguments?: JsonValue;
      startedAt: string;
    }
  | {
      kind: "conversation.tool.updated";
      sessionId: SessionId;
      turnId: string;
      toolCallId: string;
      updateMode: "append" | "replace";
      output?: string;
      truncated?: boolean;
    }
  | {
      kind: "conversation.tool.completed";
      sessionId: SessionId;
      turnId: string;
      toolCallId: string;
      result: Extract<ConversationContentBlock, { type: "toolResult" }>;
      completedAt: string;
    }
  | {
      kind: "conversation.turn.completed";
      sessionId: SessionId;
      turnId: string;
    }
  | {
      kind: "conversation.turn.aborted";
      sessionId: SessionId;
      turnId: string;
    }
  | {
      kind: "conversation.compaction.started";
      sessionId: SessionId;
      action: string;
    }
  | {
      kind: "conversation.compaction.completed";
      sessionId: SessionId;
      item?: ConversationCompactionItem;
      aborted: boolean;
    }
  | {
      kind: "conversation.notice";
      sessionId: SessionId;
      level: "info" | "warning" | "error";
      message: string;
      source?: string;
    };
