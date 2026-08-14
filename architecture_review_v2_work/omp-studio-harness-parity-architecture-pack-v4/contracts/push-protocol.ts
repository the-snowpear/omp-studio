import type {
  ClientId,
  AuthorityEpoch,
  CommitSeq,
  EnvironmentId,
  HostInstanceId,
  ISODateTime,
  RuntimeEpoch,
  SessionBindingId,
  StreamId,
  StreamSeq,
  ThreadId,
  WorkspaceId,
} from "./domain-types";
import type {
  DurableDomainEvent,
  EphemeralRuntimeEvent,
  ProjectionSnapshot,
} from "./event-model";

declare const pushBrand: unique symbol;
export type ConnectionId = string & { readonly [pushBrand]: "ConnectionId" };
export type SubscriptionId = string & { readonly [pushBrand]: "SubscriptionId" };
export type DeliverySeq = number & { readonly [pushBrand]: "DeliverySeq" };

export const PUSH_PROTOCOL_VERSION = 1 as const;
export type PushProtocolVersion = typeof PUSH_PROTOCOL_VERSION;

export type SubscriptionScope =
  | { readonly kind: "environment"; readonly environmentId: EnvironmentId }
  | {
      readonly kind: "workspace-shell";
      readonly environmentId: EnvironmentId;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly kind: "thread-detail";
      readonly environmentId: EnvironmentId;
      readonly workspaceId: WorkspaceId;
      readonly threadId: ThreadId;
      readonly bindingId: SessionBindingId | null;
    };

export interface RuntimeResumeCursor {
  readonly runtimeEpoch: RuntimeEpoch;
  readonly streamId: StreamId;
  readonly afterStreamSeq: StreamSeq;
}

export interface PushResumeCursor {
  readonly authorityEpoch: AuthorityEpoch;
  readonly afterCommitSeq: CommitSeq;
  readonly runtime: ReadonlyArray<RuntimeResumeCursor>;
}

export interface SubscribeRequest {
  readonly type: "push.subscribe";
  readonly protocolVersion: PushProtocolVersion;
  readonly clientId: ClientId;
  readonly subscriptionId: SubscriptionId;
  readonly scope: SubscriptionScope;
  readonly resume: PushResumeCursor | null;
  readonly acceptsCompression: ReadonlyArray<"none" | "permessage-deflate">;
}

export interface PushAck {
  readonly type: "push.ack";
  readonly protocolVersion: PushProtocolVersion;
  readonly subscriptionId: SubscriptionId;
  /** Highest deliverySeq applied by the reducer, not merely received. */
  readonly throughDeliverySeq: DeliverySeq;
  readonly throughCommitSeq: CommitSeq;
  readonly runtime: ReadonlyArray<RuntimeResumeCursor>;
}

export interface UnsubscribeRequest {
  readonly type: "push.unsubscribe";
  readonly protocolVersion: PushProtocolVersion;
  readonly subscriptionId: SubscriptionId;
}

export interface ClientPing {
  readonly type: "push.ping";
  readonly protocolVersion: PushProtocolVersion;
  readonly sentAt: ISODateTime;
}

export type PushClientMessage = SubscribeRequest | PushAck | UnsubscribeRequest | ClientPing;

export interface PushHello {
  readonly type: "push.hello";
  readonly protocolVersion: PushProtocolVersion;
  readonly connectionId: ConnectionId;
  readonly hostInstanceId: HostInstanceId;
  readonly authorityEpoch: AuthorityEpoch;
  readonly serverTime: ISODateTime;
  readonly limits: {
    readonly maxQueuedFrames: number;
    readonly maxQueuedBytes: number;
    readonly maxBatchBytes: number;
    readonly maxBatchEvents: number;
    readonly heartbeatMs: number;
  };
}

interface SubscriptionFrameBase {
  readonly protocolVersion: PushProtocolVersion;
  readonly connectionId: ConnectionId;
  readonly subscriptionId: SubscriptionId;
  /** Contiguous and monotonic only for this live subscription. */
  readonly deliverySeq: DeliverySeq;
  readonly emittedAt: ISODateTime;
}

export interface SnapshotFrame<TRuntime = unknown> extends SubscriptionFrameBase {
  readonly type: "push.snapshot";
  readonly snapshot: ProjectionSnapshot<TRuntime>;
}

/** Events are ascending and the first event chains from afterCommitSeq. */
export interface DurableBatchFrame extends SubscriptionFrameBase {
  readonly type: "push.durable-batch";
  readonly afterCommitSeq: CommitSeq;
  readonly throughCommitSeq: CommitSeq;
  readonly events: ReadonlyArray<DurableDomainEvent>;
}

export interface RuntimeEventItem {
  readonly kind: "event";
  readonly event: EphemeralRuntimeEvent;
}

/**
 * Only adjacent presentation deltas with the same explicit coalesce key may use
 * this shape. event.streamSeq equals toStreamSeq.
 */
export interface CoalescedRuntimeDeltaItem {
  readonly kind: "coalesced-delta";
  readonly coalesceKey: string;
  readonly runtimeEpoch: RuntimeEpoch;
  readonly streamId: StreamId;
  readonly fromStreamSeq: StreamSeq;
  readonly toStreamSeq: StreamSeq;
  readonly event: EphemeralRuntimeEvent;
}

export type RuntimeDeliveryItem = RuntimeEventItem | CoalescedRuntimeDeltaItem;

export interface RuntimeBatchFrame extends SubscriptionFrameBase {
  readonly type: "push.runtime-batch";
  readonly runtimeEpoch: RuntimeEpoch;
  readonly streamId: StreamId;
  readonly afterStreamSeq: StreamSeq;
  readonly throughStreamSeq: StreamSeq;
  readonly items: ReadonlyArray<RuntimeDeliveryItem>;
}

/** All snapshot/catch-up items before this frame have been emitted. */
export interface SynchronizedFrame extends SubscriptionFrameBase {
  readonly type: "push.synchronized";
  readonly throughCommitSeq: CommitSeq;
  readonly runtime: ReadonlyArray<RuntimeResumeCursor>;
}

export type ResyncReason =
  | "unknown-subscription"
  | "durable-cursor-ahead"
  | "durable-journal-gap"
  | "runtime-epoch-mismatch"
  | "ephemeral-buffer-gap"
  | "projection-invalidated"
  | "slow-consumer";

export interface ResyncRequiredFrame extends SubscriptionFrameBase {
  readonly type: "push.resync-required";
  readonly reason: ResyncReason;
  readonly lastRetainedCommitSeq: CommitSeq;
  readonly activeRuntimeEpoch: RuntimeEpoch | null;
}

export interface BackpressureNoticeFrame extends SubscriptionFrameBase {
  readonly type: "push.backpressure";
  readonly action: "coalesced" | "telemetry-dropped" | "closing-slow-consumer";
  readonly queuedFrames: number;
  readonly queuedBytes: number;
  readonly affectedStreamId: StreamId | null;
  readonly throughStreamSeq: StreamSeq | null;
}

export interface HeartbeatFrame extends SubscriptionFrameBase {
  readonly type: "push.heartbeat";
  readonly throughCommitSeq: CommitSeq;
  readonly activeRuntimeEpoch: RuntimeEpoch | null;
}

export interface PushErrorFrame extends SubscriptionFrameBase {
  readonly type: "push.error";
  readonly code:
    | "unauthorized"
    | "scope-not-found"
    | "unsupported-version"
    | "frame-too-large"
    | "internal";
  readonly message: string;
  readonly terminal: boolean;
}

export type PushServerMessage<TRuntime = unknown> =
  | PushHello
  | SnapshotFrame<TRuntime>
  | DurableBatchFrame
  | RuntimeBatchFrame
  | SynchronizedFrame
  | ResyncRequiredFrame
  | BackpressureNoticeFrame
  | HeartbeatFrame
  | PushErrorFrame;

export const DEFAULT_PUSH_LIMITS = {
  maxQueuedFrames: 2_048,
  maxQueuedBytes: 16 * 1024 * 1024,
  maxBatchBytes: 256 * 1024,
  maxBatchEvents: 256,
  coalesceWindowMs: 16,
  heartbeatMs: 15_000,
  ackWarningMs: 30_000,
  slowConsumerCloseMs: 60_000,
} as const;

/**
 * Protocol invariants:
 * - one ordered writer assigns contiguous deliverySeq per subscription;
 * - deliverySeq is transport-only and never replaces commitSeq/streamSeq;
 * - P0 control and P1 semantic frames are never dropped or coalesced;
 * - P2 coalescing declares the complete covered stream sequence range;
 * - overflow of non-replayable semantic data ends in resync, never silent loss;
 * - a stale runtimeEpoch is never merged into the active projection.
 */
