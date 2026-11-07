/**
 * BTW (`/btw`) side-channel contract.
 *
 * A BTW request is one ephemeral turn against the live session's model,
 * system prompt and history. It never enters the transcript, never calls
 * tools, and persists its own history without changing the main transcript. The Runtime owns a
 * single slot: asking again while one is running is rejected.
 *
 * The branch authorization token is deliberately absent — it
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
  readonly injection?: BtwInjection;
  readonly sessionId?: string;
  readonly topicId?: string;
  readonly title?: string;
  readonly question?: string;
  /** Zero-based turn within its topic, including the currently streaming turn. */
  readonly turnIndex?: number;
  readonly ephemeralId: string;
  readonly status: BtwStatus;
  /** Answer text accumulated so far; grows while `status` is `running`. */
  readonly text: string;
  /** Nonblank answer, including partial answers; preserves original whitespace. */
  readonly copy?: string;
  readonly error?: BtwError;
}

export interface BtwInjection {
  readonly id: string;
  readonly text: string;
  readonly before: string;
  readonly after: string;
  readonly state: "ready" | "sending" | "sent";
}

export const BTW_STATUSES = ["running", "completed", "failed", "aborted"] as const satisfies readonly BtwStatus[];

export const BTW_ERROR_CODES = ["INTERNAL_ERROR", "OUTPUT_LIMIT"] as const satisfies readonly BtwErrorCode[];

/**
 * Legacy size hint retained for API consumers. Native BTW answers are no longer
 * capped by this value; the enclosing transport frame supplies its own limit.
 */
export const BTW_TEXT_MAX_CHARS = 1024 * 1024;

/** Bound on the opaque ephemeral id so a malformed frame cannot grow the state. */
export const BTW_ID_MAX_CHARS = 128;

export const BTW_ERROR_MESSAGE_MAX_CHARS = 512;
