import type { BtwSnapshot } from "./btw";
import type { StudioOperation } from "./commands";
import type { ConversationRuntimeEvent } from "./conversation";
import type {
  RemoteInteractionRequiredEvent,
  StudioInteractionResolvedEvent,
} from "./interactions";
import type {
  CommandId,
  EventSeq,
  IdempotencyKey,
  OpaqueCursor,
  RequestId,
  RuntimeEpoch,
  RuntimeInstanceId,
  StateVersion,
} from "./ids";
import type { CapabilityManifest } from "./manifests";
import type { OperatorStateSnapshot } from "./state";
import type { SessionTelemetryEvent } from "./telemetry";

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
  | "CURSOR_STALE"
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
  | "TERMINAL_REQUIRED"
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

/**
 * Envelope time source freeze: `occurredAt` is the only event-emission
 * timestamp. Inner conversation events must not repeat `occurredAt`,
 * `runtimeEpoch`, `eventSeq`, or `stateVersion`.
 */
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
  /**
   * Head-cursor hint for the active-branch transcript at snapshot time.
   * It does not carry message bodies and is not a page cursor. Host may use
   * it only to decide whether `session.transcript.read` is needed. After
   * branch switch, session resume, or reset the Runtime must mint a cursor
   * bound to the new session/branch/epoch. Tamper → `INVALID_ARGUMENT`;
   * wrong session/branch/epoch → `CURSOR_STALE`.
   */
  messagesCursor?: OpaqueCursor;
  terminalReceipts: StudioReceipt[];
}

export type StudioBridgeEvent =
  | RuntimeLifecycleEvent
  | ConversationRuntimeEvent
  | SessionTelemetryEvent
  | { kind: "state.changed"; snapshot: OperatorStateSnapshot }
  | { kind: "btw.changed"; snapshot: BtwSnapshot };

export type RuntimeLifecycleEvent =
  | { kind: "runtime.ready" }
  | { kind: "runtime.quiescing" }
  | { kind: "runtime.resyncRequired"; reason: string }
  | { kind: "runtime.shutdownComplete" }
  | { kind: "command.started"; commandId: CommandId; operationKind: string }
  | { kind: "command.interactionRequired"; commandId: CommandId }
  | { kind: "command.completed"; commandId: CommandId }
  | { kind: "command.failed"; commandId: CommandId; error: StudioProtocolError }
  | { kind: "progress"; commandId: CommandId; stage: string; percent?: number }
  | { kind: "notify"; severity: "info" | "warning" | "error"; title: string; message?: string }
  | RemoteInteractionRequiredEvent
  | StudioInteractionResolvedEvent;

export interface FrameHeader {
  protocol: typeof STUDIO_PROTOCOL_NAME;
  version: typeof STUDIO_PROTOCOL_VERSION;
  frameId: string;
  runtimeEpoch: RuntimeEpoch;
  bodyLength: number;
}
