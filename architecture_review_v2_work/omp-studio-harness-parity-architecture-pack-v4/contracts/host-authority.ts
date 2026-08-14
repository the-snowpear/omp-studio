import type {
  AuthorizationDecision,
  ClientGrant,
  ClientSessionId,
  SecurityPrincipal,
  TransportSecurityContext,
} from "./security-types";
import type {
  AuthorityEpoch,
  CommandId,
  EnvironmentId,
  RuntimeEpoch,
} from "./domain-types";

export type RequestId = string;

export type HostTransportKind =
  | "desktop-private-ipc"
  | "web-loopback"
  | "web-remote-tls";

export type HostResourceScope =
  | { kind: "host"; environmentId: EnvironmentId }
  | { kind: "project"; environmentId: EnvironmentId; projectId: string }
  | { kind: "workspace"; environmentId: EnvironmentId; projectId: string; workspaceId: string }
  | { kind: "thread"; environmentId: EnvironmentId; projectId: string; threadId: string }
  | {
      kind: "runtime";
      environmentId: EnvironmentId;
      projectId: string;
      threadId: string;
      runtimeEpoch: RuntimeEpoch;
    }
  | { kind: "terminal"; environmentId: EnvironmentId; projectId: string; terminalId: string; generation: string }
  | { kind: "preview"; environmentId: EnvironmentId; projectId: string; previewId: string; generation: string };

export interface HostInstanceDescriptor {
  environmentId: EnvironmentId;
  authorityId: string;
  authorityEpoch: AuthorityEpoch;
  processStartTime: number;
  bootNonce: string;
  protocolMajor: number;
  protocolMinor: number;
  startedAt: number;
  desktopPrivateIpc: boolean;
  webListener:
    | { state: "disabled" }
    | { state: "loopback"; origins: string[] }
    | { state: "remote-tls"; origins: string[] };
}

/** Non-secret metadata suitable for an owner-only discovery record. */
export interface HostDiscoveryRecord {
  environmentId: EnvironmentId;
  authorityId: string;
  authorityEpoch: AuthorityEpoch;
  protocolMajor: number;
  pid: number;
  transport: Extract<HostTransportKind, "desktop-private-ipc" | "web-loopback">;
  endpoint: string;
  startedAt: number;
  processStartTime: number;
  bootNonce: string;
}

export interface HostAuthorityContext {
  principal: SecurityPrincipal;
  clientSessionId: ClientSessionId;
  grant: ClientGrant;
  authzRevision: number;
  transport: TransportSecurityContext;
}

export interface MutationPreconditions {
  idempotencyKey: string;
  expectedRuntimeEpoch?: RuntimeEpoch;
  expectedControlLeaseRevision?: number;
  expectedWorkspaceLeaseRevision?: number;
}

export interface HostRequestEnvelope<T = unknown> {
  requestId: RequestId;
  protocolMajor: number;
  operation: string;
  expectedAuthorityEpoch: AuthorityEpoch;
  scope: HostResourceScope;
  payload: T;
  mutation?: MutationPreconditions;
}

export interface AcceptedCommand {
  commandId: CommandId;
  state: "received" | "dispatched" | "acknowledged" | "running";
  statusPath: string;
}

export type HostResponseEnvelope<T = unknown> =
  | { requestId: RequestId; ok: true; result: T }
  | {
      requestId: RequestId;
      ok: false;
      error: {
        code:
          | "invalid_request"
          | "protocol_incompatible"
          | "unauthenticated"
          | "forbidden"
          | "resource_not_found"
          | "stale_authority_epoch"
          | "stale_runtime_epoch"
          | "lease_required"
          | "revision_conflict"
          | "rate_limited"
          | "capability_unavailable";
        message: string;
        retryable: boolean;
      };
    };

export interface HostAuthority {
  readonly instance: HostInstanceDescriptor;

  authorize(
    request: HostRequestEnvelope,
    context: HostAuthorityContext,
  ): Promise<AuthorizationDecision>;

  execute<TInput, TOutput>(
    request: HostRequestEnvelope<TInput>,
    context: HostAuthorityContext,
  ): Promise<HostResponseEnvelope<TOutput | AcceptedCommand>>;

  query<TInput, TOutput>(
    request: HostRequestEnvelope<TInput>,
    context: HostAuthorityContext,
  ): Promise<HostResponseEnvelope<TOutput>>;
}

/**
 * Normative invariants:
 * - Transport authenticates before Host resource lookup.
 * - Only HostAuthority resolves opaque IDs or mutates authoritative state.
 * - A mutation is durably accepted under its idempotency key before dispatch.
 * - Authority replacement changes authorityEpoch; OMP replacement changes runtimeEpoch.
 * - No dispatched command is automatically replayed across either epoch.
 * - Private IPC and Web transports differ only in bootstrap/framing, not in
 *   business authorization or operation semantics.
 */
