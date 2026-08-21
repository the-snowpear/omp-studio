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
  title?: string;
  body?: string;
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

export interface FastState {
  /** User-facing toggle (`/fast on`). */
  enabled: boolean;
  /** Whether the active model currently realizes priority/fast. */
  active?: boolean;
}

export interface PrewalkState {
  status: "off" | "armed" | "active";
  target?: string;
}

/**
 * Session thinking selectors the Runtime accepts and reports. `auto` is a
 * session-only mode (per-turn classification) and is never a `provider/model`
 * suffix; `inherit` is excluded because it resolves back to the provider
 * default instead of expressing an operator selection.
 */
export const SESSION_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type SessionThinkingLevel = (typeof SESSION_THINKING_LEVELS)[number];

export const SESSION_THINKING_SELECTORS = [...SESSION_THINKING_LEVELS, "auto"] as const;

export type SessionThinkingSelector = (typeof SESSION_THINKING_SELECTORS)[number];

/** Active model of the shared session. Never carries provider credentials. */
export interface SessionModelState {
  /** Canonical `provider/id` selector. */
  selector: string;
  provider: string;
  id: string;
  /** Effective level for the next request; absent when reasoning is disabled. */
  thinking?: SessionThinkingLevel;
  /** What the operator selected: a concrete level or `auto`. */
  configuredThinking?: SessionThinkingSelector;
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
  /** Active session model; absent before the first model resolves. */
  model?: SessionModelState;
  fast?: FastState;
  prewalk?: PrewalkState;
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
  /**
   * Runtime's own failure text for this command, kept beside `errorCode`.
   *
   * The ledger mirror is the only path some failures take to the client (the
   * facade-driven path returns the receipt directly), and a code alone cannot
   * say *which* argument the Runtime rejected — `INVALID_ARGUMENT` covers both
   * "Model is not available: x/y" and "Unsupported thinking level: z". Host
   * ledger entries never leave the Host process except as the message of a
   * `CommandReceipt`, so this carries no more than the direct path already does.
   */
  errorMessage?: string;
}

/** Force import/use of opaque job id in downstream projections without paths. */
export interface JobSelection {
  jobId: JobId;
}
