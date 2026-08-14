/**
 * Opaque public identifiers. They never encode paths, PIDs, ports or DB keys.
 * The structural brand intentionally matches runtime-types.ts so shared IDs do
 * not become nominally incompatible when the contracts are consumed together.
 */
export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type EnvironmentId = Brand<string, "EnvironmentId">;
export type ProjectId = Brand<string, "ProjectId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type ThreadId = Brand<string, "ThreadId">;
export type SessionBindingId = Brand<string, "SessionBindingId">;
export type OmpSessionHandle = Brand<string, "OmpSessionHandle">;
export type RuntimeEpoch = Brand<string, "RuntimeEpoch">;
export type StreamId = Brand<string, "StreamId">;
export type DomainEventId = Brand<string, "DomainEventId">;
export type CommandId = Brand<string, "CommandId">;
export type ClientId = Brand<string, "ClientId">;
export type HostInstanceId = Brand<string, "HostInstanceId">;
export type AuthorityEpoch = Brand<string, "AuthorityEpoch">;
export type ISODateTime = Brand<string, "ISODateTime">;

export type CommitSeq = Brand<number, "CommitSeq">;
export type StreamSeq = Brand<number, "StreamSeq">;

export type EnvironmentKind = "local" | "ssh" | "remote";
export type EnvironmentConnectionState =
  | "offline"
  | "connecting"
  | "online"
  | "degraded";

/** Durable Studio-owned environment registration. */
export interface Environment {
  readonly environmentId: EnvironmentId;
  readonly kind: EnvironmentKind;
  readonly displayName: string;
  readonly registeredAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Logical project identity. Files live in one or more Workspace checkouts. */
export interface Project {
  readonly projectId: ProjectId;
  readonly displayName: string;
  readonly repositoryIdentity: string | null;
  readonly registeredAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Epoch-scoped observation; not part of durable Environment state. */
export interface EnvironmentRuntimeStatus {
  readonly environmentId: EnvironmentId;
  readonly connectionState: EnvironmentConnectionState;
  readonly runtimeEpoch: RuntimeEpoch | null;
  readonly ompVersion: string | null;
  readonly capabilityRevision: string | null;
  readonly observedAt: ISODateTime;
}

export interface WorkspaceWriterLease {
  readonly revision: number;
  readonly holderBindingId: SessionBindingId | null;
  readonly acquiredAt: ISODateTime | null;
}

/**
 * Durable registration for a canonical root. The real path is Host-private;
 * canonicalRootLabel is display-only and cannot be submitted back as authority.
 */
export interface Workspace {
  readonly workspaceId: WorkspaceId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly displayName: string;
  readonly canonicalRootLabel: string;
  readonly writerLease: WorkspaceWriterLease;
  readonly registeredAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

/** Durable Studio organization, not an OMP session or agent state machine. */
export interface Thread {
  readonly threadId: ThreadId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly activeBindingId: SessionBindingId | null;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export type SessionBindingState =
  | "requested"
  | "attaching"
  | "reconciling"
  | "ready"
  | "detached"
  | "failed";

/**
 * Durable association to a real OMP session. ompSessionHandle is an opaque Host
 * registry handle, never a session JSONL path. Runtime-owned state is projected
 * separately and is valid only for runtimeEpoch.
 */
export interface SessionBinding {
  readonly bindingId: SessionBindingId;
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  /** Null only while a new real OMP session is still being established. */
  readonly ompSessionHandle: OmpSessionHandle | null;
  readonly state: SessionBindingState;
  readonly runtimeEpoch: RuntimeEpoch | null;
  readonly failureCode: string | null;
  readonly createdAt: ISODateTime;
  readonly updatedAt: ISODateTime;
}

export interface RuntimeStreamWatermark {
  readonly runtimeEpoch: RuntimeEpoch;
  readonly streamId: StreamId;
  readonly streamSeq: StreamSeq;
}

/** Disposable OMP-owned projection attached to a live binding. */
export interface BindingRuntimeProjection<T = unknown> {
  readonly bindingId: SessionBindingId;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly watermarks: ReadonlyArray<RuntimeStreamWatermark>;
  readonly reconciledAt: ISODateTime;
  readonly value: T;
}

/** Composite screen model: durable Studio state plus replaceable OMP views. */
export interface StudioReadModel<TRuntime = unknown> {
  readonly throughCommitSeq: CommitSeq;
  readonly environments: Readonly<Record<EnvironmentId, Environment>>;
  readonly projects: Readonly<Record<ProjectId, Project>>;
  readonly workspaces: Readonly<Record<WorkspaceId, Workspace>>;
  readonly threads: Readonly<Record<ThreadId, Thread>>;
  readonly sessionBindings: Readonly<Record<SessionBindingId, SessionBinding>>;
  readonly runtimeByBinding: Readonly<
    Partial<Record<SessionBindingId, BindingRuntimeProjection<TRuntime>>>
  >;
}

export interface EntityVersions {
  readonly environment: number;
  readonly project: number;
  readonly workspace: number;
  readonly thread: number;
  readonly sessionBinding: number;
}

/**
 * Cross-entity invariants enforced by the Host:
 * - Workspace.projectId resolves to an existing logical Project.
 * - Workspace.environmentId resolves to an existing Environment.
 * - Thread.workspaceId resolves to an existing Workspace.
 * - SessionBinding environment equals the Thread's Workspace environment.
 * - A Thread has at most one active binding.
 * - ready implies ompSessionHandle/runtimeEpoch are non-null.
 * - detached implies runtimeEpoch === null.
 * - Runtime projections whose epoch differs from the binding are discarded.
 */
