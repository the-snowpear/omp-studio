import type {
  CommandId,
  CommitSeq,
  DomainEventId,
  Environment,
  EnvironmentId,
  HostInstanceId,
  AuthorityEpoch,
  ISODateTime,
  RuntimeEpoch,
  RuntimeStreamWatermark,
  SessionBinding,
  SessionBindingId,
  SessionBindingState,
  StreamId,
  StreamSeq,
  StudioReadModel,
  Thread,
  ThreadId,
  Workspace,
  WorkspaceId,
  WorkspaceWriterLease,
  Project,
  ProjectId,
} from "./domain-types";

/** Studio-owned facts only. OMP message/tool/agent deltas do not belong here. */
export type DomainEventPayload =
  | { readonly kind: "environment.registered"; readonly environment: Environment }
  | {
      readonly kind: "environment.metadata-changed";
      readonly environmentId: EnvironmentId;
      readonly displayName: string;
      readonly updatedAt: ISODateTime;
    }
  | {
      readonly kind: "environment.removed";
      readonly environmentId: EnvironmentId;
      readonly removedAt: ISODateTime;
    }
  | { readonly kind: "project.registered"; readonly project: Project }
  | {
      readonly kind: "project.metadata-changed";
      readonly projectId: ProjectId;
      readonly displayName: string;
      readonly updatedAt: ISODateTime;
    }
  | {
      readonly kind: "project.removed";
      readonly projectId: ProjectId;
      readonly removedAt: ISODateTime;
    }
  | { readonly kind: "workspace.registered"; readonly workspace: Workspace }
  | {
      readonly kind: "workspace.metadata-changed";
      readonly workspaceId: WorkspaceId;
      readonly displayName: string;
      readonly updatedAt: ISODateTime;
    }
  | {
      readonly kind: "workspace.writer-lease-changed";
      readonly workspaceId: WorkspaceId;
      readonly writerLease: WorkspaceWriterLease;
    }
  | {
      readonly kind: "workspace.removed";
      readonly workspaceId: WorkspaceId;
      readonly removedAt: ISODateTime;
    }
  | { readonly kind: "thread.created"; readonly thread: Thread }
  | {
      readonly kind: "thread.metadata-changed";
      readonly threadId: ThreadId;
      readonly title?: string;
      readonly pinned?: boolean;
      readonly archived?: boolean;
      readonly updatedAt: ISODateTime;
    }
  | {
      readonly kind: "thread.removed";
      readonly threadId: ThreadId;
      readonly removedAt: ISODateTime;
    }
  | { readonly kind: "session-binding.created"; readonly binding: SessionBinding }
  | {
      readonly kind: "session-binding.state-changed";
      readonly bindingId: SessionBindingId;
      readonly state: SessionBindingState;
      readonly runtimeEpoch: RuntimeEpoch | null;
      readonly failureCode: string | null;
      readonly updatedAt: ISODateTime;
    }
  | {
      readonly kind: "session-binding.activated";
      readonly threadId: ThreadId;
      readonly bindingId: SessionBindingId;
      readonly updatedAt: ISODateTime;
    }
  | {
      readonly kind: "session-binding.detached";
      readonly threadId: ThreadId;
      readonly bindingId: SessionBindingId;
      readonly updatedAt: ISODateTime;
    };

/**
 * commitSeq is durable and Host-database global. previousCommitSeq forms the
 * replay chain even if numeric sequence allocation contains a gap.
 */
export interface DurableDomainEvent<P extends DomainEventPayload = DomainEventPayload> {
  readonly durability: "durable";
  readonly eventId: DomainEventId;
  readonly commitSeq: CommitSeq;
  readonly previousCommitSeq: CommitSeq | null;
  readonly committedAt: ISODateTime;
  readonly causationCommandId: CommandId | null;
  readonly payload: P;
}

export type RuntimeSourceChannel =
  | "omp-rpc-ui"
  | "omp-slash"
  | "companion-extension"
  | "experimental-collab";

export type RuntimeObservationClass = "control" | "semantic" | "delta" | "telemetry";

/**
 * The upstream type/body are preserved. Studio adds routing and ordering only;
 * consumers must not infer unreported OMP lifecycle transitions.
 */
export interface OmpRuntimeObservation {
  readonly kind: "omp.runtime-observation";
  readonly sourceChannel: RuntimeSourceChannel;
  readonly upstreamType: string;
  readonly upstreamRequestId: string | null;
  readonly classification: RuntimeObservationClass;
  readonly body: unknown;
}

export interface RuntimeLifecycleObservation {
  readonly kind: "studio.runtime-lifecycle";
  readonly state: "starting" | "connected" | "reconciling" | "ready" | "stopped" | "crashed";
  readonly reasonCode: string | null;
}

export interface RuntimeProjectionInvalidation {
  readonly kind: "studio.runtime-projection-invalidated";
  readonly reason:
    | "epoch-changed"
    | "stream-gap"
    | "snapshot-fence-unavailable"
    | "capability-changed"
    | "reducer-error";
}

export type EphemeralRuntimePayload =
  | OmpRuntimeObservation
  | RuntimeLifecycleObservation
  | RuntimeProjectionInvalidation;

export interface EphemeralRuntimeEvent<
  P extends EphemeralRuntimePayload = EphemeralRuntimePayload,
> {
  readonly durability: "ephemeral";
  readonly environmentId: EnvironmentId;
  readonly bindingId: SessionBindingId | null;
  readonly threadId: ThreadId | null;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly streamId: StreamId;
  readonly streamSeq: StreamSeq;
  readonly observedAt: ISODateTime;
  readonly payload: P;
}

export interface ProjectionCheckpoint {
  readonly commitSeq: CommitSeq;
  readonly runtimeEpochByBinding: Readonly<
    Partial<Record<SessionBindingId, RuntimeEpoch>>
  >;
  readonly streamWatermarks: ReadonlyArray<RuntimeStreamWatermark>;
}

/** Atomic composite snapshot used for initial load and reconciliation. */
export interface ProjectionSnapshot<TRuntime = unknown> {
  readonly schemaVersion: 1;
  readonly hostInstanceId: HostInstanceId;
  readonly authorityEpoch: AuthorityEpoch;
  readonly generatedAt: ISODateTime;
  readonly checkpoint: ProjectionCheckpoint;
  readonly projection: StudioReadModel<TRuntime>;
}

export function runtimeEventKey(event: EphemeralRuntimeEvent): string {
  return `${event.runtimeEpoch}:${event.streamId}:${event.streamSeq}`;
}

export function isCurrentRuntimeEvent(
  event: EphemeralRuntimeEvent,
  activeRuntimeEpoch: RuntimeEpoch | null,
): boolean {
  return activeRuntimeEpoch !== null && event.runtimeEpoch === activeRuntimeEpoch;
}

/**
 * Reducers MUST verify:
 * - event.previousCommitSeq === the durable projection watermark;
 * - runtimeEpoch equals the binding's active epoch;
 * - streamSeq is the next sequence or is covered by an explicit coalesced range.
 */
