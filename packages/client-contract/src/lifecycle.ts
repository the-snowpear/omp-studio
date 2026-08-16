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

import type { ConversationRuntimeEvent, OperatorStateSnapshot, SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";

import type {
  AuthorityEpoch,
  CommandRequestId,
  EventCursor,
  IdempotencyKey,
  InteractionId,
  RuntimeEpoch,
  SessionId,
  StateVersion,
  ThreadId,
} from "./ids.js";
import type { GitRepositoryChanged, OperationProgress } from "./git.js";
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

/**
 * Shared identity fields of every interaction prompt. `requestId` is
 * optional: only commands such as `core.prompt` / `session.drop` correlate
 * an interaction with a client command; Ask / tool-approval interactions
 * are session-level and stand on their own.
 */
export interface ClientInteractionBase {
  readonly interactionId: InteractionId;
  readonly sessionId: SessionId;
  readonly leaseGeneration: number;
  readonly title: string;
  readonly requestId?: CommandRequestId;
}

/**
 * Interaction prompt issued by the Host. `interaction.required` always
 * enters `state.interaction.pending`; with a `requestId` the reducer also
 * correlates the original command when it is still accepted.
 */
export type ClientInteraction =
  | (ClientInteractionBase & {
      readonly kind: "confirm";
      readonly message: string;
      readonly destructive: boolean;
    })
  | (ClientInteractionBase & {
      readonly kind: "select";
      readonly options: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly description?: string;
      }>;
      readonly multiple: boolean;
    })
  | (ClientInteractionBase & {
      readonly kind: "input";
      readonly placeholder?: string;
      readonly secret: boolean;
    })
  | (ClientInteractionBase & {
      readonly kind: "editor";
      readonly content?: string;
      readonly language?: string;
    })
  | (ClientInteractionBase & {
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
  | (ClientEventBase & { readonly kind: "interaction.required"; readonly interaction: ClientInteraction })
  | (ClientEventBase & {
      readonly kind: "interaction.resolved";
      readonly interactionId: InteractionId;
      readonly leaseGeneration: number;
      readonly outcome: "submitted" | "cancelled" | "aborted" | "expired";
    })
  | (ClientEventBase & { readonly kind: "command.receipt"; readonly receipt: CommandReceipt })
  | (ClientEventBase & { readonly kind: "runtime.changed"; readonly connection: RuntimeConnection })
  | (ClientEventBase & { readonly kind: "resync.required"; readonly reason: string })
  | (ClientEventBase & { readonly kind: "diagnostics.changed" })
  | (ClientEventBase & { readonly kind: "operation.progress"; readonly progress: OperationProgress })
  | (ClientEventBase & { readonly kind: "git.repository.changed"; readonly repository: GitRepositoryChanged })
  | (ClientEventBase & {
      readonly kind: "telemetry.changed";
      readonly sessionId: SessionId;
      readonly telemetry: SessionTelemetrySnapshot;
    })
  /**
   * Live conversation projector output. `ClientEventBase.cursor` is the
   * Host facade delivery cursor (decimal, monotonic per authority epoch).
   * `eventSeq` is `StudioEventEnvelope.eventSeq` from the Bridge — a
   * different namespace used by the conversation reducer for Runtime
   * continuity. Do not treat the two as interchangeable.
   *
   * Time source is `ClientEventBase.occurredAt`, copied from
   * `StudioEventEnvelope.occurredAt`. Inner `update` payloads must not
   * repeat occurredAt / runtimeEpoch / eventSeq / stateVersion.
   */
  | (ClientEventBase & {
      readonly kind: "conversation.changed";
      readonly sessionId: SessionId;
      readonly eventSeq: number;
      readonly update: ConversationRuntimeEvent;
    });

/** What subset of the event stream a subscription requests. */
export type SubscriptionScope =
  | { readonly scope: "all" }
  | { readonly scope: "runtime" }
  | { readonly scope: "thread"; readonly threadId: ThreadId }
  | { readonly scope: "command"; readonly requestId: CommandRequestId };

export type Unsubscribe = () => void;
