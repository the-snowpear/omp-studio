/**
 * Command lifecycle, event envelope and subscription scope.
 *
 * Mutation lifecycle (FRONTEND_INTEGRATION.md §8.2):
 *
 *   local_pending -> accepted -> interaction_required (optional)
 *     -> completed | failed | rejected | outcome_unknown
 *
 * `accepted` only means "request taken"; terminal receipts carry the final
 * outcome. Events carry authority/runtime epoch, state version and a
 * monotonic cursor so the reducer can ignore stale epochs, detect gaps and
 * resync (FRONTEND_INTEGRATION.md §8.3).
 */

import type { OperatorStateSnapshot } from "@omp-studio/studio-protocol";

import type {
  AuthorityEpoch,
  CommandRequestId,
  EventCursor,
  IdempotencyKey,
  InteractionId,
  RuntimeEpoch,
  StateVersion,
  ThreadId,
} from "./ids.js";
import type { RuntimeConnection } from "./read-models.js";
import type {
  ClientCommandAccepted,
  ClientError,
  CommandName,
  CommandResult,
} from "./operations.js";

export type CommandStatus =
  | "local_pending"
  | "accepted"
  | "interaction_required"
  | "completed"
  | "failed"
  | "rejected"
  | "outcome_unknown";

export type CommandTerminalStatus = "completed" | "failed" | "rejected" | "outcome_unknown";

/** Shared identity fields of every command lifecycle state. */
export interface CommandStateBase<TName extends CommandName = CommandName> {
  readonly requestId: CommandRequestId;
  readonly commandName: TName;
}

/**
 * Handle returned by `StudioClient.command`. Represents the client-side
 * `local_pending` state; every later transition arrives as a ClientEvent
 * and is tracked by the reducer keyed on `requestId`.
 */
export interface CommandHandle<TName extends CommandName = CommandName>
  extends CommandStateBase<TName> {
  readonly status: "local_pending";
  readonly idempotencyKey: IdempotencyKey;
  readonly issuedAt: string;
}

export interface InteractionBase {
  readonly interactionId: InteractionId;
  readonly requestId: CommandRequestId;
}

/**
 * Interaction prompt issued by the Host for `interaction_required`
 * commands; answered via the `interaction.respond` command.
 */
export type ClientInteraction =
  | (InteractionBase & {
      readonly kind: "confirm";
      readonly message: string;
      readonly destructive: boolean;
    })
  | (InteractionBase & {
      readonly kind: "select";
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }>;
      readonly multiple: boolean;
    })
  | (InteractionBase & {
      readonly kind: "input";
      readonly placeholder?: string;
      readonly secret: boolean;
    })
  | (InteractionBase & {
      readonly kind: "editor";
      readonly content?: string;
      readonly language?: string;
    })
  | (InteractionBase & {
      readonly kind: "approval";
      readonly approvalType: string;
      /** Heterogeneous, pre-redacted approval details. */
      readonly detail: Readonly<Record<string, unknown>>;
    });

/**
 * Terminal receipt: the only source of final command outcomes. A receipt is
 * never produced for a command that merely was accepted.
 */
export type CommandReceipt<TName extends CommandName = CommandName> =
  | (CommandStateBase<TName> & {
      readonly status: "completed";
      readonly result: CommandResult<TName>;
      readonly observedAt: string;
    })
  | (CommandStateBase<TName> & {
      readonly status: "failed";
      readonly error: ClientError;
      readonly observedAt: string;
    })
  | (CommandStateBase<TName> & {
      readonly status: "rejected";
      readonly reason: string;
      readonly observedAt: string;
    })
  | (CommandStateBase<TName> & {
      readonly status: "outcome_unknown";
      readonly reason: string;
      readonly observedAt: string;
    });

/** Full reducer-side command state, from local_pending to a terminal receipt. */
export type CommandState<TName extends CommandName = CommandName> =
  | (CommandStateBase<TName> & {
      readonly status: "local_pending";
      readonly idempotencyKey: IdempotencyKey;
      readonly issuedAt: string;
    })
  | (CommandStateBase<TName> & {
      readonly status: "accepted";
      readonly acceptedAt: string;
    })
  | (CommandStateBase<TName> & {
      readonly status: "interaction_required";
      readonly interaction: ClientInteraction;
    })
  | CommandReceipt<TName>;

/** Envelope fields carried by every ClientEvent (FRONTEND_INTEGRATION.md §8.3). */
export interface ClientEventBase {
  readonly authorityEpoch: AuthorityEpoch;
  /** Absent for authority-level events that are not tied to a runtime. */
  readonly runtimeEpoch?: RuntimeEpoch;
  readonly stateVersion: StateVersion;
  /** Monotonic per authority epoch; a gap means resync is required. */
  readonly cursor: EventCursor;
  readonly occurredAt: string;
}

/** Discriminated event stream delivered through `StudioClient.subscribe`. */
export type ClientEvent =
  | (ClientEventBase & { readonly kind: "snapshot"; readonly snapshot: OperatorStateSnapshot })
  | (ClientEventBase & { readonly kind: "state.changed" })
  | (ClientEventBase & { readonly kind: "command.accepted"; readonly accepted: ClientCommandAccepted })
  | (ClientEventBase & {
      readonly kind: "command.interactionRequired";
      readonly interaction: ClientInteraction;
    })
  | (ClientEventBase & { readonly kind: "command.receipt"; readonly receipt: CommandReceipt })
  | (ClientEventBase & { readonly kind: "runtime.changed"; readonly connection: RuntimeConnection })
  | (ClientEventBase & { readonly kind: "resync.required"; readonly reason: string })
  | (ClientEventBase & { readonly kind: "diagnostics.changed" });

/** What subset of the event stream a subscription requests. */
export type SubscriptionScope =
  | { readonly scope: "all" }
  | { readonly scope: "runtime" }
  | { readonly scope: "thread"; readonly threadId: ThreadId }
  | { readonly scope: "command"; readonly requestId: CommandRequestId };

export type Unsubscribe = () => void;
