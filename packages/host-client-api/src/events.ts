/**
 * Facade event bus: builds ClientEvents from Host facts and delivers them
 * to subscriptions with the exact client-contract scope semantics.
 *
 * Cursors are canonical decimal strings, monotonic within the facade's
 * (fixed) authority epoch, so the client reducer can detect duplicates and
 * gaps (§8.3). Events without a Runtime carry no `runtimeEpoch`; their
 * `stateVersion` is 0 until a snapshot establishes real Runtime state.
 */

import type {
  AuthorityEpoch,
  ClientCommandAccepted,
  ClientError,
  ClientEvent,
  ClientInteraction,
  CommandName,
  CommandReceipt,
  CommandRequestId,
  EventCursor,
  RuntimeConnection,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  SubscriptionScope,
  Unsubscribe,
  OperationProgress,
  GitRepositoryChanged,
} from "@omp-studio/client-contract";
import type {
  BtwSnapshot,
  CommandLedgerEntry,
  ConversationRuntimeEvent,
  SessionTelemetrySnapshot,
} from "@omp-studio/studio-protocol";
import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

/** Runtime state the bus consults when an event seed omits epoch/version. */
export interface HostEventContext {
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly stateVersion?: StateVersion;
}

export interface HostEventSeedBase {
  /** Overrides the bus context for this event (e.g. the lost Runtime epoch of a receipt). */
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly stateVersion?: StateVersion;
  /** Bridge `StudioEventEnvelope.occurredAt` for conversation events; otherwise the facade clock. */
  readonly occurredAt?: string;
}

/** Every ClientEvent kind the facade can emit, minus the shared envelope. */
export type HostEventSeed =
  | (HostEventSeedBase & { readonly kind: "snapshot"; readonly snapshot: OperatorStateSnapshot })
  | (HostEventSeedBase & { readonly kind: "state.changed" })
  | (HostEventSeedBase & { readonly kind: "command.accepted"; readonly accepted: ClientCommandAccepted })
  | (HostEventSeedBase & { readonly kind: "interaction.required"; readonly interaction: ClientInteraction })
  | (HostEventSeedBase & {
      readonly kind: "interaction.resolved";
      readonly interactionId: string;
      readonly leaseGeneration: number;
      readonly outcome: "submitted" | "cancelled" | "aborted" | "expired";
    })
  | (HostEventSeedBase & { readonly kind: "command.receipt"; readonly receipt: CommandReceipt })
  | (HostEventSeedBase & { readonly kind: "runtime.changed"; readonly connection: RuntimeConnection })
  | (HostEventSeedBase & { readonly kind: "resync.required"; readonly reason: string })
  | (HostEventSeedBase & { readonly kind: "diagnostics.changed" })
  | (HostEventSeedBase & { readonly kind: "operation.progress"; readonly progress: OperationProgress })
  | (HostEventSeedBase & { readonly kind: "git.repository.changed"; readonly repository: GitRepositoryChanged })
  | (HostEventSeedBase & {
      readonly kind: "telemetry.changed";
      readonly sessionId: SessionId;
      readonly telemetry: SessionTelemetrySnapshot;
    })
  | (HostEventSeedBase & {
      readonly kind: "conversation.changed";
      readonly sessionId: SessionId;
      readonly eventSeq: number;
      readonly update: ConversationRuntimeEvent;
    })
  | (HostEventSeedBase & {
      readonly kind: "btw.changed";
      readonly sessionId: SessionId;
      readonly eventSeq: number;
      readonly snapshot: BtwSnapshot;
    });

interface Subscriber {
  readonly scope: SubscriptionScope;
  readonly listener: (event: ClientEvent) => void;
}

/**
 * Exact subscription scope filtering, mirroring the shared client
 * semantics: `all` matches everything, `runtime` matches every event that
 * carries a runtime epoch, `thread` conservatively matches nothing (the
 * contract binds no event to a thread yet) and `command` matches only the
 * lifecycle events of one requestId.
 */
export function eventMatchesScope(event: ClientEvent, scope: SubscriptionScope): boolean {
  switch (scope.scope) {
    case "all":
      return true;
    case "runtime":
      return event.runtimeEpoch !== undefined;
    case "thread":
      return false;
    case "command":
      switch (event.kind) {
        case "command.accepted":
          return event.accepted.requestId === scope.requestId;
        case "interaction.required":
          return event.interaction.requestId === scope.requestId;
        case "command.receipt":
          return event.receipt.requestId === scope.requestId;
        case "operation.progress":
          return event.progress.requestId === scope.requestId;
        default:
          return false;
      }
  }
}

/**
 * Map a Host ledger entry to a terminal client receipt. Only terminal
 * statuses that need no result payload are mapped here: `completed` results
 * arrive through the facade-driven command path (the ledger does not carry
 * receipt results). Unknown requestIds are left to the caller to filter.
 */
export function receiptFromLedgerEntry(
  entry: CommandLedgerEntry,
  commandName: CommandName,
  observedAt: string,
): CommandReceipt | undefined {
  switch (entry.status) {
    case "failed":
      return {
        requestId: entry.requestId as CommandRequestId,
        commandName,
        status: "failed",
        error: ledgerError(entry),
        observedAt,
      };
    case "rejected":
      return {
        requestId: entry.requestId as CommandRequestId,
        commandName,
        status: "rejected",
        reason: ledgerReason(entry, "rejected by runtime", (code) => `runtime rejected request: ${code}`),
        observedAt,
      };
    case "outcome_unknown":
      return {
        requestId: entry.requestId as CommandRequestId,
        commandName,
        status: "outcome_unknown",
        reason: ledgerReason(
          entry,
          "runtime lost; outcome unknown",
          (code) => `runtime lost (${code}); outcome unknown`,
        ),
        observedAt,
      };
    default:
      return undefined;
  }
}

/**
 * Reason line for a non-`failed` terminal ledger status. The Runtime's own text
 * wins when it has one — it names the offending argument, which the code alone
 * cannot — and the code-derived phrasing stays as the fallback.
 */
function ledgerReason(
  entry: CommandLedgerEntry,
  whenBare: string,
  fromCode: (code: string) => string,
): string {
  const detail = entry.errorMessage?.trim();
  if (detail !== undefined && detail.length > 0) {
    return entry.errorCode === undefined ? detail : `${fromCode(entry.errorCode)}: ${detail}`;
  }
  return entry.errorCode === undefined ? whenBare : fromCode(entry.errorCode);
}

/**
 * Client error for a `failed` ledger entry. The code mapping is fixed by
 * contract; the message prefers the Runtime's own text so a mirrored failure
 * reads the same as one returned through the facade-driven command path.
 */
function ledgerError(entry: CommandLedgerEntry): ClientError {
  const code = ledgerErrorCode(entry.errorCode);
  const detail = entry.errorMessage?.trim();
  return {
    code,
    message: detail !== undefined && detail.length > 0 ? detail : ledgerFallbackMessage(entry.errorCode),
  };
}

function ledgerErrorCode(errorCode: string | undefined): ClientError["code"] {
  switch (errorCode) {
    case "RUNTIME_EPOCH_STALE":
      return "STALE_EPOCH";
    case "STATE_VERSION_CONFLICT":
      return "STATE_VERSION_CONFLICT";
    case "CAPABILITY_UNAVAILABLE":
      return "CAPABILITY_UNAVAILABLE";
    case "INVALID_ARGUMENT":
      return "INVALID_ARGUMENT";
    case "RESYNC_REQUIRED":
      return "RESYNC_REQUIRED";
    default:
      return "INTERNAL_ERROR";
  }
}

function ledgerFallbackMessage(errorCode: string | undefined): string {
  switch (errorCode) {
    case "RUNTIME_EPOCH_STALE":
      return "runtime epoch is stale";
    case "STATE_VERSION_CONFLICT":
      return "state version conflict";
    case "CAPABILITY_UNAVAILABLE":
      return "runtime capability is unavailable";
    case "INVALID_ARGUMENT":
      return "runtime rejected the request arguments";
    case "RESYNC_REQUIRED":
      return "runtime requires resync";
    default:
      return `runtime reported failure: ${errorCode ?? "unknown"}`;
  }
}

/** Monotonic decimal cursor minting for one authority epoch. */
export class HostEventCursor {
  #value = 0;

  /** Cursor of the last emitted event; the bootstrap resume point. */
  current(): EventCursor {
    return String(this.#value) as EventCursor;
  }

  /** Advance and return the next cursor ("0", "1", "2", …). */
  next(): EventCursor {
    this.#value += 1;
    return String(this.#value) as EventCursor;
  }
}

export class HostEventBus {
  readonly #authorityEpoch: AuthorityEpoch;
  readonly #clock: () => string;
  readonly #context: () => HostEventContext;
  readonly #cursor = new HostEventCursor();
  readonly #subscribers = new Set<Subscriber>();
  #closed = false;

  constructor(
    authorityEpoch: AuthorityEpoch,
    clock: () => string,
    context: () => HostEventContext,
  ) {
    this.#authorityEpoch = authorityEpoch;
    this.#clock = clock;
    this.#context = context;
  }

  /** Resume point for bootstrap: the last emitted cursor (or "0"). */
  currentCursor(): EventCursor {
    return this.#cursor.current();
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.#closed) {
      return () => {};
    }
    const subscriber: Subscriber = { scope, listener };
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** Emit an event: fills the envelope, stamps a fresh cursor, delivers. */
  emit(seed: HostEventSeed): ClientEvent {
    const context = this.#context();
    const runtimeEpoch = seed.runtimeEpoch ?? context.runtimeEpoch;
    const stateVersion = seed.stateVersion ?? context.stateVersion ?? (0 as StateVersion);
    const event = {
      ...seed,
      authorityEpoch: this.#authorityEpoch,
      ...(runtimeEpoch === undefined ? {} : { runtimeEpoch }),
      stateVersion,
      cursor: this.#cursor.next(),
      occurredAt: seed.occurredAt ?? this.#clock(),
    } as ClientEvent;
    for (const subscriber of [...this.#subscribers]) {
      if (eventMatchesScope(event, subscriber.scope)) {
        try {
          subscriber.listener(event);
        } catch {
          // Isolate sibling listeners so one throw cannot starve the rest.
        }
      }
    }
    return event;
  }

  /** Drop every subscription (client-session close); the bus stays usable. */
  close(): void {
    this.#closed = true;
    this.#subscribers.clear();
  }

  /** Re-open after close is never allowed; used by the facade's closed guard. */
  get closed(): boolean {
    return this.#closed;
  }
}
