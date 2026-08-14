import type {
  AuthorityEpoch,
  Brand,
  CommandId,
  EnvironmentId,
  ProjectId,
  RuntimeEpoch,
  SessionBindingId,
  ThreadId,
  WorkspaceId,
} from "./domain-types";

export type RuntimeId = Brand<string, "RuntimeId">;
export type PlanId = Brand<string, "PlanId">;

export type {
  AuthorityEpoch,
  CommandId,
  EnvironmentId,
  ProjectId,
  RuntimeEpoch,
  SessionBindingId,
  ThreadId,
  WorkspaceId,
} from "./domain-types";

export type RuntimeBackendKind = "sdk" | "rpc-ui";

export interface OmpBuildIdentity {
  version: string;
  commit?: string;
  buildId?: string;
  executablePath?: string;
  sdkPackage?: string;
  sdkVersion?: string;
}

export type OmpSessionLocator =
  | { kind: "new"; parentSessionId?: string }
  | { kind: "session-id"; sessionId: string }
  | { kind: "session-file"; absolutePath: string }
  | { kind: "branch"; sourceSessionId: string; entryId: string }
  | { kind: "handoff"; sourceSessionId: string };

/** Host-private operational expansion of the durable domain SessionBinding. */
export interface RuntimeSessionBinding {
  id: SessionBindingId;
  bindingRevision: number;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  runtimeId: RuntimeId;
  authorityEpoch: AuthorityEpoch;
  runtimeEpoch: RuntimeEpoch;
  backend: RuntimeBackendKind;
  ompBuild: OmpBuildIdentity;
  /** Host-private. Never serialized to an untrusted client. */
  ompSession: OmpSessionLocator;
  state: "launching" | "active" | "suspended" | "crashed" | "needs-rebind" | "stopped";
  createdAt: number;
  updatedAt: number;
}

export type SettingSource =
  | "schema-default"
  | "host-default"
  | "global"
  | "project"
  | "config-overlay"
  | "runtime-override"
  | "session-entry";

export interface EffectiveSetting<Value = unknown> {
  path: string;
  value: Value;
  source: SettingSource;
  explicitlyConfigured: boolean;
  sourceLocation?: string;
}

export interface TaskLaunchSettings {
  isolationMode: string;
  isolationApply: boolean;
  isolationMerge: string;
  isolationCommits: string;
  eager: string;
  batch: boolean;
  maxConcurrency: number;
  maxRecursionDepth: number;
  maxRuntimeMs: number;
  agentIdleTtlMs: number;
  disabledAgents: string[];
  agentModelOverrides: Record<string, string>;
  agentPrewalk: Record<string, string>;
}

export interface RuntimeBehaviorSettings {
  task: TaskLaunchSettings;
  advisor: {
    enabled: boolean;
    subagents: boolean;
    syncBacklog: string;
    immuneTurns: number;
  };
  memory: { backend: string; legacyMemoriesEnabled?: boolean };
  tiers: {
    openai: string;
    anthropic: string;
    google: string;
    subagent: string;
    advisor: string;
  };
  async: { enabled: boolean; maxJobs: number; pollWaitDuration: string };
  bash: { enabled: boolean; autoBackgroundEnabled: boolean; autoBackgroundThresholdMs: number };
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  fastMode?: boolean;
  approvalMode?: string;
}

export interface RuntimeLaunchPlan {
  planId: PlanId;
  planVersion: 1;
  planHash: string;
  createdAt: number;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  backend: RuntimeBackendKind;
  ompBuild: OmpBuildIdentity;
  cwd: string;
  profile?: string;
  agentDir?: string;
  argv: string[];
  /** Names or secret references only; never plaintext credentials. */
  environment: Record<string, { value?: string; secretRef?: string; redacted?: boolean }>;
  sessionIntent: OmpSessionLocator;
  writeMode: "read-only" | "writer" | "isolated-worktree";
  writerLeaseId?: string;
  writerFencingToken?: number;
  configLayers: {
    globalPath?: string;
    projectPath?: string;
    overlayPaths: string[];
  };
  effectiveSettings: EffectiveSetting[];
  behavior: RuntimeBehaviorSettings;
  extensions: {
    roots: string[];
    enabled: string[];
    companionIntrospection: boolean;
    expectedCompanionProtocol?: string;
  };
  mcp: { configuredServers: string[]; sourcePaths: string[] };
  rpc?: {
    requiredProtocol: 2;
    subagentSubscription: "off" | "progress" | "events";
    hostTools: string[];
    hostUriSchemes: string[];
  };
  containment: {
    ownerId: string;
    kind: "windows-job" | "process-group" | "in-process-sdk";
  };
  compatibilityProfile: string;
}

export interface RuntimeHandle {
  bindingId: SessionBindingId;
  runtimeId: RuntimeId;
  runtimeEpoch: RuntimeEpoch;
  planId: PlanId;
  planHash: string;
  backend: RuntimeBackendKind;
}

export interface RuntimeSnapshot {
  binding: Omit<RuntimeSessionBinding, "ompSession">;
  planId: PlanId;
  planHash: string;
  isStreaming: boolean;
  isCompacting: boolean;
  model?: { provider: string; modelId: string };
  messageCount: number;
  capturedAt: number;
}

export interface RuntimeInvocation<Input = unknown> {
  commandId: CommandId;
  bindingId: SessionBindingId;
  expectedRuntimeEpoch: RuntimeEpoch;
  capabilityId: string;
  input: Input;
  idempotencyKey?: string;
}

/** Gateway acknowledgement; lifecycle truth remains in CommandLedgerEntry. */
export interface RuntimeDispatchReceipt {
  commandId: CommandId;
  bindingId: SessionBindingId;
  runtimeEpoch: RuntimeEpoch;
  correlationId: string;
  accepted: boolean;
  errorCode?: string;
  message?: string;
}

export type RuntimeStopReason =
  | "user"
  | "suspend"
  | "host-shutdown"
  | "backend-migration"
  | "crash-recovery"
  | "compatibility-failure";
