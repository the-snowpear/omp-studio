import type { StudioOperation } from "./commands";
import type {
  CommandId,
  EventSeq,
  IdempotencyKey,
  RequestId,
  RuntimeEpoch,
  RuntimeInstanceId,
  StateVersion,
} from "./ids";
import type { CapabilityManifest } from "./manifests";
import type { OperatorStateSnapshot } from "./state";

export const STUDIO_PROTOCOL_NAME = "omp-studio" as const;
export const STUDIO_PROTOCOL_VERSION = 1 as const;

export interface StudioHelloRequest {
  type: "studio.hello";
  requestId: RequestId;
  supportedProtocolVersions: number[];
  requiredProfile: "full-parity-v1";
  challenge: string;
}

export interface StudioHelloResponse {
  type: "studio.hello.result";
  requestId: RequestId;
  selectedProtocolVersion: number;
  runtimeVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
  runtimeInstanceId: RuntimeInstanceId;
  runtimeEpoch: RuntimeEpoch;
  capabilityManifest: CapabilityManifest;
  commandManifestHash: string;
  stateVersion: StateVersion;
  challengeProof: string;
}

export interface StudioRequest {
  type: "studio.request";
  requestId: RequestId;
  runtimeEpoch: RuntimeEpoch;
  expectedStateVersion?: StateVersion;
  idempotencyKey?: IdempotencyKey;
  operation: StudioOperation;
}

export type ReceiptStatus =
  | "accepted"
  | "completed"
  | "rejected"
  | "failed"
  | "outcome_unknown";

export type StudioErrorCode =
  | "UNAUTHENTICATED"
  | "PROTOCOL_UNSUPPORTED"
  | "RUNTIME_EPOCH_STALE"
  | "STATE_VERSION_CONFLICT"
  | "CAPABILITY_UNAVAILABLE"
  | "COMMAND_UNKNOWN"
  | "COMMAND_BLOCKED"
  | "INVALID_ARGUMENT"
  | "INTERACTION_REQUIRED"
  | "INTERACTION_STALE"
  | "AGENT_GENERATION_CONFLICT"
  | "JOB_GENERATION_CONFLICT"
  | "NOT_OWNER"
  | "BUSY_STREAMING"
  | "BUSY_COMPACTING"
  | "MODE_CONFLICT"
  | "OUTCOME_UNKNOWN"
  | "INTERNAL_ERROR";

export interface StudioProtocolError {
  code: StudioErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface StudioReceipt<TResult = unknown> {
  type: "studio.receipt";
  requestId: RequestId;
  commandId?: CommandId;
  runtimeEpoch: RuntimeEpoch;
  stateVersion: StateVersion;
  status: ReceiptStatus;
  result?: TResult;
  error?: StudioProtocolError;
}

export interface StudioEventEnvelope<TEvent = unknown> {
  type: "studio.event";
  runtimeEpoch: RuntimeEpoch;
  eventSeq: EventSeq;
  stateVersion: StateVersion;
  occurredAt: string;
  event: TEvent;
}

export interface StudioSnapshotResponse {
  type: "studio.snapshot";
  requestId: RequestId;
  snapshot: OperatorStateSnapshot;
  commandManifestHash: string;
  capabilityHash: string;
  lastEventSeq: EventSeq;
}

export type RuntimeLifecycleEvent =
  | { kind: "runtime.ready" }
  | { kind: "runtime.quiescing" }
  | { kind: "runtime.resyncRequired"; reason: string }
  | { kind: "runtime.shutdownComplete" }
  | { kind: "command.started"; commandId: CommandId; operationKind: string }
  | { kind: "command.interactionRequired"; commandId: CommandId }
  | { kind: "command.completed"; commandId: CommandId }
  | { kind: "command.failed"; commandId: CommandId; error: StudioProtocolError };

export interface FrameHeader {
  protocol: typeof STUDIO_PROTOCOL_NAME;
  version: typeof STUDIO_PROTOCOL_VERSION;
  frameId: string;
  runtimeEpoch: RuntimeEpoch;
  bodyLength: number;
}

