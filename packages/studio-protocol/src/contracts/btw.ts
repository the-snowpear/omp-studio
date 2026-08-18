/**
 * BTW (`/btw`) side-channel contract.
 *
 * A BTW request is one ephemeral turn against the live session's model,
 * system prompt and history. It never enters the transcript, never calls
 * tools, and never mutates persisted session state. The Runtime owns a
 * single slot: asking again while one is running is rejected.
 *
 * The snapshot below is path-free and secret-free by construction. In
 * particular the branch authorization token is deliberately absent — it
 * travels only on the `btw.ask` receipt, so a late `btw.changed` observer
 * cannot promote someone else's answer into a new session.
 */

/** Lifecycle of the single BTW slot. Only `completed` answers can be branched. */
export type BtwStatus = "running" | "completed" | "failed" | "aborted";

export type BtwErrorCode = "INTERNAL_ERROR" | "OUTPUT_LIMIT";

export interface BtwError {
  readonly code: BtwErrorCode;
  readonly message: string;
}

export interface BtwSnapshot {
  readonly ephemeralId: string;
  readonly status: BtwStatus;
  /** Answer text accumulated so far; grows while `status` is `running`. */
  readonly text: string;
  /** Trimmed copy payload; present only once the answer completed non-empty. */
  readonly copy?: string;
  readonly error?: BtwError;
}

export const BTW_STATUSES = ["running", "completed", "failed", "aborted"] as const satisfies readonly BtwStatus[];

export const BTW_ERROR_CODES = ["INTERNAL_ERROR", "OUTPUT_LIMIT"] as const satisfies readonly BtwErrorCode[];

/**
 * Upper bound on a single snapshot's answer text. The Runtime caps its own
 * accumulation at 1 MiB; this leaves headroom for multi-byte characters
 * while still refusing an unbounded frame.
 */
export const BTW_TEXT_MAX_CHARS = 1024 * 1024;

/** Bound on the opaque ephemeral id so a malformed frame cannot grow the state. */
export const BTW_ID_MAX_CHARS = 128;

export const BTW_ERROR_MESSAGE_MAX_CHARS = 512;
