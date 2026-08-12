/**
 * Opaque branded public identifiers for the product client surface.
 *
 * These brands let the Renderer carry, compare and store identity values
 * without ever learning the underlying OMP session paths, process handles,
 * Bridge internals or private endpoints. String ids are opaque tokens;
 * numeric brands are monotonic counters that must never be treated as
 * anything but opaque version markers.
 */

type Brand<T, TName extends string> = T & { readonly __brand: TName };

/** Public identity of the Host authority that owns the client session. */
export type AuthorityId = Brand<string, "AuthorityId">;

/** Monotonic authority generation; a new value invalidates all prior state. */
export type AuthorityEpoch = Brand<number, "AuthorityEpoch">;

/** Identity of the selected Runtime instance (opaque). */
export type RuntimeId = Brand<string, "RuntimeId">;

/** Monotonic runtime generation; used to isolate stale runtime events. */
export type RuntimeEpoch = Brand<number, "RuntimeEpoch">;

/** Monotonic snapshot version of the Host read model. */
export type StateVersion = Brand<number, "StateVersion">;

/** Environment identity (opaque). */
export type EnvironmentId = Brand<string, "EnvironmentId">;

/** Thread identity (opaque). */
export type ThreadId = Brand<string, "ThreadId">;

/** Session identity (opaque). */
export type SessionId = Brand<string, "SessionId">;

/** Session-history catalog entry identity (opaque). */
export type HistoryEntryId = Brand<string, "HistoryEntryId">;

/** Client-visible request identity for a submitted command. */
export type CommandRequestId = Brand<string, "CommandRequestId">;

/** Interaction identity issued by the Host for `interaction_required` commands. */
export type InteractionId = Brand<string, "InteractionId">;

/** Diagnostic entry identity (opaque). */
export type DiagnosticEntryId = Brand<string, "DiagnosticEntryId">;

/** Client-supplied idempotency key; the same key must map to the same semantic input. */
export type IdempotencyKey = Brand<string, "IdempotencyKey">;

/** Monotonic event cursor, unique within an authority epoch; gap detection key. */
export type EventCursor = Brand<string, "EventCursor">;
