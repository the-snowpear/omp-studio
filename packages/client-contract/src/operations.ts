/**
 * Semantic request/response maps and envelopes for the product client.
 *
 * Query and command names are type-mapped: `QueryInput`/`QueryResult` and
 * `CommandInput`/`CommandResult` resolve each name to its exact shape, so
 * the Renderer never deals with untyped blobs. Protocol domain types
 * (`CapabilityManifest`, `OperatorCommandManifest`, `OperatorStateSnapshot`)
 * are reused via type-only imports because they are safe public contracts.
 */

import type {
  CapabilityManifest,
  OperatorCommandManifest,
  OperatorStateSnapshot,
} from "@omp-studio/studio-protocol";

import type { CommandRequestId, IdempotencyKey, InteractionId, ThreadId } from "./ids.js";
import type {
  DiagnosticReadModel,
  EnvironmentReadModel,
  HomeReadModel,
  RuntimeInstallState,
  SessionHistoryReadModel,
} from "./read-models.js";

/** Empty input shape for queries that take no arguments. */
export type EmptyInput = Readonly<Record<string, never>>;

export interface QueryInputMap {
  "environment.get": EmptyInput;
  "capabilities.get": EmptyInput;
  "commands.getManifest": EmptyInput;
  "diagnostics.get": EmptyInput;
  "history.list": { readonly limit?: number };
  "session.state": EmptyInput;
  "home.get": EmptyInput;
}

export interface QueryResultMap {
  "environment.get": EnvironmentReadModel;
  /** Capability read model; the protocol manifest is the safe public shape. */
  "capabilities.get": CapabilityManifest;
  /** Operator command manifest; reused from the protocol as a public shape. */
  "commands.getManifest": OperatorCommandManifest;
  "diagnostics.get": DiagnosticReadModel;
  "history.list": SessionHistoryReadModel;
  /** Reused from the protocol as a public shape. */
  "session.state": OperatorStateSnapshot;
  "home.get": HomeReadModel;
}

export type QueryName = keyof QueryInputMap & keyof QueryResultMap;
export type QueryInput<TName extends QueryName> = QueryInputMap[TName];
export type QueryResult<TName extends QueryName> = QueryResultMap[TName];

export type RuntimeChannel = "stable" | "canary";

/**
 * Value accepted by `interaction.respond`. Heterogeneous by nature
 * (select picks, editor text, approval payloads), hence the union.
 */
export type InteractionResponseValue =
  | string
  | boolean
  | ReadonlyArray<string>
  | Readonly<Record<string, unknown>>;

export interface CommandInputMap {
  /** Install or update the trusted runtime (environment page action). */
  "runtime.install": { readonly channel?: RuntimeChannel };
  /** Resume a thread from history or the home page. */
  "session.resume": { readonly threadId: ThreadId };
  /** Drop a thread. Destructive: the Host issues a one-time confirmation. */
  "session.drop": { readonly threadId: ThreadId };
  /** Answer an `interaction_required` prompt issued by the Host. */
  "interaction.respond": {
    readonly interactionId: InteractionId;
    readonly decision: "submit" | "cancel";
    readonly value?: InteractionResponseValue;
  };
}

export interface CommandResultMap {
  "runtime.install": RuntimeInstallState;
  "session.resume": OperatorStateSnapshot;
  "session.drop": OperatorStateSnapshot;
  "interaction.respond": OperatorStateSnapshot;
}

export type CommandName = keyof CommandInputMap & keyof CommandResultMap;
export type CommandInput<TName extends CommandName> = CommandInputMap[TName];
export type CommandResult<TName extends CommandName> = CommandResultMap[TName];

export type ClientErrorCode =
  | "UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "STALE_EPOCH"
  | "STATE_VERSION_CONFLICT"
  | "CAPABILITY_UNAVAILABLE"
  | "RESYNC_REQUIRED"
  | "TRANSPORT_ERROR"
  | "INTERNAL_ERROR";

export interface ClientError {
  readonly code: ClientErrorCode;
  readonly message: string;
}

/** Semantic query envelope sent to the transport (FRONTEND_INTEGRATION.md §9.1). */
export interface ClientQueryRequest<TName extends QueryName = QueryName> {
  readonly queryName: TName;
  readonly input: QueryInput<TName>;
}

/** Semantic query response: either the exact result or a typed error. */
export type ClientQueryResponse<TName extends QueryName = QueryName> =
  | { readonly ok: true; readonly queryName: TName; readonly result: QueryResult<TName> }
  | { readonly ok: false; readonly queryName: TName; readonly error: ClientError };

/**
 * Semantic command envelope sent to the transport. `requestId` is the
 * client-generated correlation id: the Host must echo it back unchanged in
 * every acknowledgement/receipt so client-side entries stay keyed to it.
 */
export interface ClientCommandRequest<TName extends CommandName = CommandName> {
  readonly commandName: TName;
  readonly input: CommandInput<TName>;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestId: CommandRequestId;
}

/**
 * Transport acknowledgement for a command. `accepted` means the Host took
 * the request — never that it succeeded. Terminal success arrives only via
 * `CommandReceipt` (`completed`/`failed`/`rejected`/`outcome_unknown`).
 */
export interface ClientCommandAccepted<TName extends CommandName = CommandName> {
  readonly commandName: TName;
  readonly requestId: CommandRequestId;
  readonly status: "accepted";
  readonly acceptedAt: string;
}
