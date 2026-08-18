/**
 * Public conversation types for Host/Client. These are the protocol's
 * already-sanitized shapes — Host and Renderer must not invent a parallel
 * item/event vocabulary.
 */

export type {
  ConversationCompactionItem,
  ConversationContentBlock,
  ConversationItem,
  ConversationMessageError,
  ConversationMessageItem,
  ConversationResetBoundaryItem,
  ConversationRole,
  ConversationRuntimeEvent,
  ConversationTranscriptPage,
  JsonValue,
  OpaqueCursor,
  SessionTranscriptRead,
} from "@omp-studio/studio-protocol";

export {
  CONVERSATION_LIMITS,
  CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION,
  SESSION_TRANSCRIPT_READ_CAPABILITY,
  SESSION_TRANSCRIPT_READ_CONCURRENCY,
  SESSION_TRANSCRIPT_READ_KIND,
  parseConversationRuntimeEvent,
  parseConversationTranscriptPage,
  publicConversationToolCallId,
  truncateUtf8,
  utf8ByteLength,
} from "@omp-studio/studio-protocol";

import type {
  ConversationItem,
  OpaqueCursor,
} from "@omp-studio/studio-protocol";

import type { SessionId } from "./ids.js";

/**
 * Runtime-independent page projected from a persisted session transcript.
 *
 * `transcriptRevision` and all cursors are opaque Host-issued strings. They
 * bind pagination to one durable transcript/branch revision; clients must
 * never parse, derive, or reuse them for another session.
 */
export interface ConversationTranscriptReadPage {
  readonly sessionId: SessionId;
  readonly transcriptRevision: string;
  readonly branchLeafId: string | null;
  readonly items: readonly ConversationItem[];
  readonly olderCursor?: OpaqueCursor;
  readonly headCursor: OpaqueCursor;
  readonly hasMoreBefore: boolean;
}
