import type { StudioAgentSnapshot, StudioJobSnapshot } from "./agents-jobs";
import type { ApprovalMode } from "./commands";
import type {
  AgentId,
  CommandId,
  Generation,
  InteractionId,
  JobId,
  RuntimeEpoch,
  RuntimeId,
  SessionId,
  StateVersion,
} from "./ids";
import type { StudioPendingInteraction } from "./interactions";
import type { SessionTelemetrySnapshot } from "./telemetry";

export interface PlanState {
  status: "off" | "active" | "paused" | "review";
  planReference?: string;
}

export interface GoalState {
  status: "off" | "active" | "paused" | "complete";
  objective?: string;
  tokenBudget?: number;
  tokensUsed?: number;
}

export interface VibeState {
  enabled: boolean;
  workerAgentIds: AgentId[];
}

export interface LoopState {
  status: "waiting" | "running" | "paused";
  prompt?: string;
  iterations?: number;
}

export interface PauseState {
  paused: boolean;
  pauseEpoch?: number;
  pausedAt?: string;
}

export interface LiveState {
  status: "off" | "connecting" | "active" | "stopping" | "failed";
  deviceId?: string;
}

export interface OperatorStateSnapshot {
  runtimeId: RuntimeId;
  runtimeEpoch: RuntimeEpoch;
  stateVersion: StateVersion;
  sessionId: SessionId;
  isStreaming: boolean;
  isCompacting: boolean;
  activeMode: "normal" | "plan" | "goal" | "vibe";
  /** Effective tool approval mode of the Runtime (override layer first). */
  approvalMode: ApprovalMode;
  plan?: PlanState;
  goal?: GoalState;
  vibe?: VibeState;
  loop?: LoopState;
  pause?: PauseState;
  live?: LiveState;
  pendingMessages: number;
  pendingInteraction?: StudioPendingInteraction;
  activeCommandIds: CommandId[];
  agentsRevision: number;
  jobsRevision: number;
  agents: StudioAgentSnapshot[];
  jobs: StudioJobSnapshot[];
  telemetry?: SessionTelemetrySnapshot;
}

export interface RuntimeControlLease {
  holder: "gui" | "tui" | "system";
  generation: Generation;
  acquiredAt: string;
  expiresAt?: string;
  commandId?: CommandId;
  interactionId?: InteractionId;
}

export interface CommandLedgerEntry {
  commandId: CommandId;
  requestId: string;
  runtimeId: RuntimeId;
  runtimeEpoch: RuntimeEpoch;
  operationKind: string;
  requestedAt: string;
  status:
    | "requested"
    | "accepted"
    | "interaction_required"
    | "completed"
    | "failed"
    | "rejected"
    | "outcome_unknown";
  terminalAt?: string;
  stateVersionBefore?: StateVersion;
  stateVersionAfter?: StateVersion;
  errorCode?: string;
}

/** Force import/use of opaque job id in downstream projections without paths. */
export interface JobSelection {
  jobId: JobId;
}
