/**
 * @omp-studio/client-contract
 *
 * Authoritative P0 product client contract (FRONTEND_INTEGRATION.md §§8, 11,
 * 13 P0). Transport-neutral: the same `StudioClient` surface is implemented
 * by Desktop IPC and local Web adapters, and by in-process semantic adapters
 * during P0.
 *
 * The contract carries only public facts — opaque identities, epochs,
 * versions and pre-redacted text. It never contains Bridge tokens, private
 * endpoints, PIDs, process handles or session/workspace paths.
 */

import type {
  CapabilityManifest,
  OperatorStateSnapshot,
} from "@omp-studio/studio-protocol";

import type {
  EnvironmentId,
  EventCursor,
  IdempotencyKey,
  SessionId,
  StateVersion,
  ThreadId,
  WorkspaceId,
} from "./ids.js";
import type {
  PublicAuthorityIdentity,
  RuntimeConnection,
  SurfaceCapabilities,
} from "./read-models.js";
import type {
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientQueryRequest,
  ClientQueryResponse,
  CommandInput,
  CommandName,
  QueryInput,
  QueryName,
  QueryResult,
} from "./operations.js";
import type {
  ClientEvent,
  CommandHandle,
  SubscriptionScope,
  Unsubscribe,
} from "./lifecycle.js";

/** Version of this client contract; bumped on incompatible contract changes. */
export const CLIENT_CONTRACT_VERSION = 1 as const;

/** Opaque selections carried by the bootstrap; never resolved to paths. */
export interface ClientSelection {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly sessionId?: SessionId;
  readonly workspaceId?: WorkspaceId;
}

/**
 * Bootstrap output (FRONTEND_INTEGRATION.md §8.1): public authority/runtime
 * identity, connection classification, manifests, opaque selections, the
 * initial read model snapshot and the resume cursor. Excludes all secrets.
 */
export interface ClientBootstrap {
  readonly contractVersion: typeof CLIENT_CONTRACT_VERSION;
  readonly authority: PublicAuthorityIdentity;
  readonly runtime: RuntimeConnection;
  readonly surface: SurfaceCapabilities;
  readonly capabilityManifest: CapabilityManifest;
  /** Hash of the operator command manifest; the full manifest comes by query. */
  readonly commandManifestHash: string;
  readonly selected: ClientSelection;
  /** Present when a Runtime snapshot is available; omitted in read-only bootstrap. */
  readonly snapshot?: OperatorStateSnapshot;
  /** Snapshot version; equals `snapshot.stateVersion`. */
  readonly stateVersion?: StateVersion;
  /** Subscription resume point; events after this cursor are in order. */
  readonly cursor?: EventCursor;
}

/** Shared bootstrap fields before an optional Runtime snapshot is attached. */
export type ClientBootstrapBase = Omit<ClientBootstrap, "snapshot" | "stateVersion" | "cursor">;

export interface CommandOptions {
  /** Same key + same command must map to the same semantic input. */
  readonly idempotencyKey?: IdempotencyKey;
}

/**
 * Transport adapter boundary. P0 adapters are in-process/in-memory semantic
 * adapters; Desktop IPC and HTTP/WebSocket adapters implement the same
 * interface in P1/P2. Envelopes are the semantic request/response shapes.
 */
export interface ClientTransport {
  bootstrap(): Promise<ClientBootstrap>;
  query<TName extends QueryName>(
    request: ClientQueryRequest<TName>,
  ): Promise<ClientQueryResponse<TName>>;
  command<TName extends CommandName>(
    request: ClientCommandRequest<TName>,
  ): Promise<ClientCommandAccepted<TName>>;
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

/**
 * The product client surface shared by Desktop and Web (FRONTEND_INTEGRATION.md §8).
 * Queries resolve exact read models; commands return a `local_pending` handle
 * and progress through the accepted/receipt lifecycle as ClientEvents arrive.
 */
export interface StudioClient {
  bootstrap(): Promise<ClientBootstrap>;
  query<TName extends QueryName>(name: TName, input: QueryInput<TName>): Promise<QueryResult<TName>>;
  command<TName extends CommandName>(
    name: TName,
    input: CommandInput<TName>,
    options?: CommandOptions,
  ): Promise<CommandHandle<TName>>;
  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe;
  close(): Promise<void>;
}

export * from "./ids.js";
export * from "./read-models.js";
export * from "./operations.js";
export * from "./lifecycle.js";
