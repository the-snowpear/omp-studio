/**
 * Injected service ports consumed by {@link StudioHostClientFacade}.
 *
 * The facade is presentation-neutral: it never imports Electron and never
 * touches process/Bridge internals. Every Host capability it exposes is
 * injected as an explicit port, so the composition root (Electron Main in
 * P1) supplies the real seams and tests supply fakes. Ports carry only
 * safe public facts — opaque identities, epochs, versions and pre-redacted
 * text. Nothing here may structurally contain executable paths, Bridge
 * endpoints/tokens, PIDs or session filesystem data.
 */

import { randomUUID } from "node:crypto";

import type {
  ClientError,
  ClientErrorCode,
  ConversationTranscriptReadPage,
  ConfigWriteResult,
  DiagnosticEntryId,
  ExtensibilityReadModel,
  McpLogsReadModel,
  McpReadModel,
  McpTestResult,
  AgentDefinitionConfigureInput,
  AgentDefinitionDeleteInput,
  AgentDefinitionsReadModel,
  AgentDefinitionUpsertInput,
  CommandRequestId,
  IdempotencyKey,
  InteractionId,
  InteractionResponseValue,
  ModelConfigReadModel,
  ModelDiscoveryResult,
  ModelFallbackSetInput,
  ModelProviderProbeInput,
  ModelProviderSetEnabledInput,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleCreateInput,
  ModelRolesWriteInput,
  BtwAskOutcome,
  BtwBranchOutcome,
  OperatorInvokeOutcome,
  OpaqueCursor,
  SessionTreeCommandOutcome,
  RuntimeChannel,
  RuntimeInstallState,
  RuntimeDisconnectCode,
  RuntimeUnavailableCode,
  ResidentsReadModel,
  SessionHistoryStatus,
  ThreadId,
  WorkspaceId,
  WorkspaceListReadModel,
  WorkspaceFileTreeReadModel,
  WorkspaceFileMutationResult,
  TokenUsageReadModel,
  GitToolchainReadModel,
  GitRepositoryReadModel,
  GitDiffReadModel,
  GitBranchListReadModel,
  GitWorktreeListReadModel,
  GitRemoteListReadModel,
  GitLogListReadModel,
  GitCommitChangesReadModel,
  GitCommitDiffReadModel,
  GitExecuteInput,
  GitOperationResult,
  GitHubAuthReadModel,
  GitHubPullRequestListReadModel,
  GitHubPullRequestDetailReadModel,
  GitHubChecksReadModel,
  GitHubExecuteInput,
  GitHubOperationResult,
  StudioPlanSaveAndQuitResult,
  StudioRuntimeSettingsGetResult,
  StudioRuntimeSettingsSetResult,
  OperationProgress,
} from "@omp-studio/client-contract";
import type {
  ApprovalMode,
  CommandLedgerEntry,
  CapabilityManifest,
  ConversationTranscriptPage,
  AgentTranscriptPage,
  OperatorCommandManifest,
  OperatorStateSnapshot,
  RuntimeBackend,
  RuntimeClassification,
  RuntimeEpoch,
  RuntimeId,
  SessionTelemetrySnapshot,
  StudioAgentSnapshot,
} from "@omp-studio/studio-protocol";
import {
  StudioHostError,
  type HostBackend,
  type RuntimePublication,
  type StudioBtwForward,
  type StudioConversationForward,
  type StudioInteractionForward,
  type StudioTelemetryForward,
  type StudioRuntimeSessionController,
} from "@omp-studio/studio-host";
import type { StudioOperation } from "@omp-studio/studio-protocol";
import { redactText } from "./read-models.js";

/**
 * Provider of a manifest (capability or operator command). Returning
 * `undefined` means "no Runtime evidence right now"; the facade fails
 * closed to its neutral empty manifest instead of claiming capabilities it
 * cannot prove. Provider errors are treated the same way.
 */
export type HostManifestProvider<T> = () => T | Promise<T> | undefined | Promise<undefined>;

/**
 * Safe public view of the negotiated Runtime hello. Supplied by the
 * composition root from the authenticated handshake; never contains the
 * executable identity/path, endpoint, token, PID or process handle.
 */
export interface HostRuntimeHelloView {
  readonly runtimeId: string;
  readonly runtimeEpoch: number;
  readonly classification: Exclude<RuntimeClassification, "unavailable">;
  readonly backend?: RuntimeBackend;
  readonly runtimeVersion?: string;
  readonly upstreamVersion?: string;
  readonly upstreamCommit?: string;
}

/**
 * Last observed reason the Runtime never connected. Pre-redacted; never a
 * path, PID or endpoint. The facade copies this onto `RuntimeConnection`
 * when `hello()` is still undefined.
 */
export interface HostRuntimeUnavailable {
  readonly code: RuntimeUnavailableCode;
  readonly reason: string;
}

/**
 * Last observed reason a previously connected Runtime dropped. Pre-redacted;
 * never a path, PID or endpoint. The facade copies this onto
 * `RuntimeConnection` when `hello()` becomes undefined after a prior hello.
 */
export interface HostRuntimeDisconnect {
  readonly code: RuntimeDisconnectCode;
  readonly reason: string;
  /** ISO timestamp of the drop; stamped when the Host first observes it. */
  readonly occurredAt?: string;
  /** Automatic relaunch outcome after an unexpected drop. */
  readonly autoRespawn?: "scheduled" | "failed" | "exhausted";
}

/** English Host sentence for an unavailable code; the Renderer maps to Chinese. */
export function formatRuntimeUnavailableMessage(facts: HostRuntimeUnavailable): string {
  const reason = redactText(facts.reason).trim();
  switch (facts.code) {
    case "no-workspace":
      return "Runtime is not available: no workspace is selected";
    case "workspace-unusable":
      return reason.length > 0
        ? `Runtime is not available: workspace directory is unusable (${reason})`
        : "Runtime is not available: workspace directory is unusable";
    case "not-installed":
      return reason.length > 0
        ? `Runtime is not available: managed runtime is not installed (${reason})`
        : "Runtime is not available: managed runtime is not installed";
    case "resolution-rejected":
      return reason.length > 0 ? `Runtime was rejected: ${reason}` : "Runtime was rejected";
    case "resolution-limited":
      return reason.length > 0 ? `Runtime is limited: ${reason}` : "Runtime is limited and was not started";
    case "handshake-timeout":
      return reason.length > 0 ? `Runtime handshake timed out: ${reason}` : "Runtime handshake timed out";
    case "spawn-failed":
      return reason.length > 0 ? `Runtime failed to spawn: ${reason}` : "Runtime failed to spawn";
    case "exited-before-ready":
      return reason.length > 0
        ? `Runtime exited before it became ready: ${reason}`
        : "Runtime exited before it became ready";
    case "launch-failed":
      return reason.length > 0 ? `Runtime failed to start: ${reason}` : "Runtime failed to start";
    case "not-wired":
      return "Runtime is not available: session port is not wired";
  }
}

/** English Host sentence for a disconnect code; the Renderer maps to Chinese. */
export function formatRuntimeDisconnectMessage(facts: HostRuntimeDisconnect): string {
  const reason = redactText(facts.reason).trim();
  switch (facts.code) {
    case "process-exit":
      return reason.length > 0 ? `Runtime process exited: ${reason}` : "Runtime process exited";
    case "pipe-closed":
      return reason.length > 0 ? `Runtime connection was lost: ${reason}` : "Runtime connection was lost";
    case "lease-lost":
      return reason.length > 0 ? `Runtime session lease was lost: ${reason}` : "Runtime session lease was lost";
    case "host-stop":
      return reason.length > 0 ? `Runtime was stopped: ${reason}` : "Runtime was stopped";
  }
}

/**
 * Command-path copy when a live Runtime is required. Prefers a disconnect
 * reason (the process was up) over a never-connected skip/fail.
 */
export function formatRuntimeMissingMessage(input: {
  readonly unavailable?: HostRuntimeUnavailable;
  readonly disconnect?: HostRuntimeDisconnect;
}): string {
  if (input.disconnect !== undefined) return formatRuntimeDisconnectMessage(input.disconnect);
  if (input.unavailable !== undefined) return formatRuntimeUnavailableMessage(input.unavailable);
  return "Runtime is not available";
}

/**
 * Optional Runtime access bundle: the ready session controller plus safe
 * current hello/snapshot access and a projection observation hook.
 *
 * - `hello` is required when the bundle is present; `undefined` from the
 *   accessor means "no Runtime negotiated yet". The facade tracks the last
 *   known hello so a later `undefined` is read as a disconnect, not as a
 *   never-seen Runtime.
 * - `snapshot` defaults to `session.publication()?.snapshot` when the
 *   session controller is wired; an explicit accessor wins.
 * - `onPublication` lets the facade mirror Host projection changes (state
 *   version advances, terminal ledger outcomes) as ClientEvents. Wire it
 *   to whatever drives the controller (e.g. the Bridge projection
 *   listener).
 */
export interface HostRuntimeAccess {
  readonly session?: StudioRuntimeSessionController;
  /** Live session holder so transcript reads follow workspace/runtime rebind. */
  readonly currentSession?: () => StudioRuntimeSessionController | undefined;
  /**
   * Optional test/composition seam. When omitted, the facade calls
   * `currentSession()?.readTranscript` / `session.readTranscript`.
   */
  readonly readTranscript?: (input: {
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }) => Promise<ConversationTranscriptPage>;
  /**
   * Per-agent transcript read from the Runtime Agent Hub. When omitted, the
   * facade calls `currentSession()?.readAgentTranscript` / `session.readAgentTranscript`.
   */
  readonly readAgentTranscript?: (input: {
    readonly agentId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }) => Promise<AgentTranscriptPage>;
  /**
   * Per-agent ConversationItem page from the Runtime. When omitted, the
   * facade calls `currentSession()?.readAgentConversation`.
   */
  readonly readAgentConversation?: (input: {
    readonly agentId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }) => Promise<ConversationTranscriptPage>;
  readonly hello: () => HostRuntimeHelloView | undefined;
  /**
   * Why the Runtime never connected. Read when `hello()` is undefined and
   * no previous hello was observed. Optional: tests and read-only Hosts
   * may omit it and the facade stays at the generic unavailable sentence.
   */
  readonly unavailable?: () => HostRuntimeUnavailable | undefined;
  /**
   * Why a previously connected Runtime dropped. Read when `hello()` is
   * undefined after a prior hello. Optional: omitted means the generic
   * disconnected sentence.
   */
  readonly disconnect?: () => HostRuntimeDisconnect | undefined;
  /**
   * Start or restart the managed Runtime under the current workspace.
   * No-op when already connected unless `force` is true. Optional:
   * diagnostics `runtime.ensure` fails closed when omitted.
   */
  readonly ensure?: (input?: { readonly force?: boolean }) => Promise<void>;
  readonly snapshot?: () => OperatorStateSnapshot | undefined;
  /** Opaque transcript head hint for bootstrap; never message bodies. */
  readonly messagesCursor?: () => OpaqueCursor | undefined;
  readonly onPublication?: (listener: (publication: RuntimePublication) => void) => () => void;
  readonly onConversationEvent?: (listener: (event: StudioConversationForward) => void) => () => void;
  readonly onConversationResync?: (listener: (reason: string) => void) => () => void;
  readonly onTelemetryEvent?: (listener: (event: StudioTelemetryForward) => void) => () => void;
  readonly onInteractionEvent?: (listener: (event: StudioInteractionForward) => void) => () => void;
  readonly onBtwEvent?: (listener: (event: StudioBtwForward) => void) => () => void;
}

/** Authority-level resident Runtime projection supplied by the Host broker. */
export interface HostResidentsService {
  list(): ResidentsReadModel | Promise<ResidentsReadModel>;
  /** Live broker summary updates; the disposer is optional for read-only seams. */
  onChanged?(listener: (residents: ResidentsReadModel) => void): () => void;
  /** Background Worker ledger outcomes; snapshots stay scoped to the active Worker. */
  onTerminalOutcomes?(listener: (outcomes: readonly CommandLedgerEntry[]) => void): () => void;
}

/**
 * Every shape a Host `invoke` may return. Most operations resolve to the
 * post-command snapshot; the exceptions carry extra facts that only exist on
 * the receipt (operator output lines, editor fill-back, BTW branch token).
 */
export type HostInvokeOutcome =
  | OperatorStateSnapshot
  | OperatorInvokeOutcome
  | SessionTreeCommandOutcome
  | BtwAskOutcome
  | BtwBranchOutcome
  | StudioRuntimeSettingsGetResult
  | StudioRuntimeSettingsSetResult
  | StudioPlanSaveAndQuitResult;

/** One session-history row as supplied by the Host-side catalog provider. */
export interface HostCatalogEntry {
  /** Opaque OMP session identity; the facade derives all public ids from it deterministically. */
  readonly sessionId: string;
  /** Safe display title; the facade bounds and sanitizes it again. */
  readonly title?: string;
  /** Safe summary snippet; the facade bounds and sanitizes it again. */
  readonly summary?: string;
  readonly createdAt?: string;
  readonly modifiedAt: string;
  readonly messageCount: number;
  readonly status: SessionHistoryStatus;
  /** OMP v18 global session pin state; absent is treated as unpinned for old providers. */
  readonly pinned?: boolean;
}

/**
 * Session catalog provider (SessionCatalog + Studio Thread metadata in the
 * integration plan). Never returns filesystem paths; the facade maps each
 * entry to opaque branded ids and bounded safe text.
 */
export interface HostSessionCatalogProvider {
  /** Omit workspaceId to retain the active-workspace compatibility path. */
  list(input?: { readonly workspaceId?: WorkspaceId }): HostCatalogEntry[] | Promise<HostCatalogEntry[]>;
}

/** Runtime-independent persistent transcript reader owned by the Host/Broker. */
export interface HostSessionArchiveProvider {
  readPage(input: {
    readonly sessionId: string;
    readonly agentId?: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): ConversationTranscriptReadPage | Promise<ConversationTranscriptReadPage>;
  /** Optional persisted child roster for a parent session. */
  listPersistedAgents?(sessionId: string): Promise<readonly StudioAgentSnapshot[]> | readonly StudioAgentSnapshot[];
  /** Optional current-revision lookup for archived-session telemetry. */
  readRevision?(sessionId: string): Promise<{ sessionId: string; transcriptRevision: string }> | { sessionId: string; transcriptRevision: string };
  /**
   * Optional validated transcript copy for the one-shot telemetry probe.
   * The returned `temporarySessionFile` is Host-internal and must never
   * reach the Client Contract, events, the Renderer, or logs.
   */
  createProbeCopy?(sessionId: string, destinationDirectory: string): Promise<{
    sessionId: string;
    transcriptRevision: string;
    temporarySessionFile: string;
  }>;
}

/** Minimal "last observed" telemetry persistence surface consumed by the facade. */
export interface HostSessionTelemetryStorePort {
  record(sessionId: string, telemetry: SessionTelemetrySnapshot): void;
  /** Returns the persisted telemetry only when the archive revision matches exactly. */
  read(sessionId: string, revision: string): Promise<{ telemetry: SessionTelemetrySnapshot } | undefined>;
  flush(): Promise<void>;
  dispose(): void;
  /** Drop every trace of one session; used by `session.delete` residue cleanup. */
  remove?(sessionId: string): Promise<void>;
}

/** One-shot archived-session telemetry probe owned by the Host. */
export interface HostSessionTelemetryProbePort {
  run(input: {
    readonly sessionId: string;
    readonly sessionFile: string;
    readonly allowedCwd: string;
    readonly transcriptRevision: string;
  }): Promise<{ readonly ok: true; readonly telemetry: SessionTelemetrySnapshot } | { readonly ok: false; readonly reason: "UNAVAILABLE" }>;
}

/** Creates and cleans up Host-owned scratch directories for probe copies. */
export interface HostTelemetryProbeWorkspacePort {
  create(): Promise<string>;
  remove(path: string): Promise<void>;
}

/**
 * Diagnostics clock/id factory. Injected so tests get deterministic entry
 * ids and timestamps; the facade stamps every diagnostic and event with it.
 */
export interface HostDiagnosticsFactory {
  now(): string;
  newEntryId(): DiagnosticEntryId;
}

/**
 * Runtime install command service. Returns the safe installer read model;
 * the facade publishes `command.accepted` before delegating and the
 * terminal receipt from the returned state (or a mapped failure).
 */
export type HostRuntimeInstallService = (
  channel?: RuntimeChannel,
) => RuntimeInstallState | Promise<RuntimeInstallState>;

/**
 * Read-only local-artifact version probe for `environment.get`.
 * Compares the installed runtime against the newest signed artifact on
 * disk. Never downloads. Paths stay in the Host.
 */
export type HostRuntimeInstallProbe = () => RuntimeInstallState | Promise<RuntimeInstallState>;

/**
 * Host-owned model/provider/role adapter. Paths and secrets stay here;
 * the facade only publishes the public read model and write receipts.
 */
export interface HostModelsService {
  get(): ModelConfigReadModel | Promise<ModelConfigReadModel>;
  upsertProvider(input: ModelProviderUpsertInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  deleteProvider(input: { readonly id: string; readonly expectedHash?: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  setProviderEnabled(input: ModelProviderSetEnabledInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  setRole(input: { readonly roleId: string; readonly selector: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  writeRoles(input: ModelRolesWriteInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  createRole(input: ModelRoleCreateInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  deleteRole(input: { readonly roleId: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  setRoleStorage(input: { readonly storage: "global" | "project" }): ConfigWriteResult | Promise<ConfigWriteResult>;
  setFallback(input: ModelFallbackSetInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  setProviderOrder(input: { readonly order: ReadonlyArray<string> }): ConfigWriteResult | Promise<ConfigWriteResult>;
  writeModelsYml(input: {
    readonly text: string;
    readonly expectedHash?: string;
    readonly overlay?: ModelProviderUpsertInput;
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  startLogin(input: { readonly providerId: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  logout(input: { readonly providerId: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  testProvider(input: { readonly providerId?: string; readonly api?: string; readonly endpointUrl?: string; readonly apiKey?: string }): ModelProviderTestResult | Promise<ModelProviderTestResult>;
  probeProvider(input: ModelProviderProbeInput): ModelDiscoveryResult | Promise<ModelDiscoveryResult>;
  refreshDiscovery(): ConfigWriteResult | Promise<ConfigWriteResult>;
  setCycleOrder(input: { readonly order: ReadonlyArray<string> }): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned configured skills/plugins inventory. Paths stay in the
 * adapter; the facade only publishes the public read model.
 */
export interface HostExtensibilityService {
  get(): ExtensibilityReadModel | Promise<ExtensibilityReadModel>;
  /**
   * Whole-package plugin enable/disable (OMP-native files, no uninstall).
   * `scope` selects the user vs project inventory; the adapter resolves it
   * when omitted. Throws a ClientError-shaped error for unknown plugins.
   */
  setEnabled(input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  /**
   * Whole-skill enable/disable: toggles the winning SKILL.md frontmatter
   * `enabled` field. `scope` maps user → global, project → workspace;
   * builtin skills are rejected.
   */
  setSkillEnabled(input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  /**
   * Open the winning skill directory in the system file manager. Paths stay
   * in the adapter; the Renderer only supplies the skill name.
   */
  revealSkill(input: {
    readonly name: string;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  /**
   * Open the native OMP skills root (user or project). Creates it if missing.
   */
  revealSkillRoot(input?: {
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned configured MCP server inventory. Paths stay in the adapter;
 * the facade only publishes the public read model.
 */
export interface HostMcpService {
  get(): McpReadModel | Promise<McpReadModel>;
  setEnabled(input: {
    readonly name: string;
    readonly enabled: boolean;
    readonly scope?: "user" | "project";
  }): ConfigWriteResult | Promise<ConfigWriteResult>;
  refresh(input?: { readonly name?: string }): ConfigWriteResult | Promise<ConfigWriteResult>;
  test(input: {
    readonly name: string;
    readonly scope?: "user" | "project";
  }): McpTestResult | Promise<McpTestResult>;
  logs(input: { readonly name: string }): McpLogsReadModel | Promise<McpLogsReadModel>;
}

/**
 * Host-owned task-agent definition inventory. Paths stay in the adapter;
 * the facade only publishes the public read model and write receipts.
 */
export interface HostAgentDefinitionsService {
  get(): AgentDefinitionsReadModel | Promise<AgentDefinitionsReadModel>;
  upsert(input: AgentDefinitionUpsertInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  delete(input: AgentDefinitionDeleteInput): ConfigWriteResult | Promise<ConfigWriteResult>;
  configure(input: AgentDefinitionConfigureInput): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/**
 * Host-owned workspace registry service. Paths live only in the Host
 * registry; the facade publishes the path-free workspace list.
 */
export interface HostWorkspaceService {
  list(): WorkspaceListReadModel | Promise<WorkspaceListReadModel>;
  open(input: { readonly workspaceId: WorkspaceId }): Promise<WorkspaceListReadModel>;
  pick(input?: { readonly name?: string }): Promise<WorkspaceListReadModel>;
}

/** Host-owned workspace-relative file tree and mutation adapter. */
export interface HostWorkspaceFileService {
  get(input: { readonly workspaceId: WorkspaceId; readonly path?: string }): WorkspaceFileTreeReadModel | Promise<WorkspaceFileTreeReadModel>;
  createFile(input: { readonly workspaceId: WorkspaceId; readonly path: string }): WorkspaceFileMutationResult | Promise<WorkspaceFileMutationResult>;
  createDirectory(input: { readonly workspaceId: WorkspaceId; readonly path: string }): WorkspaceFileMutationResult | Promise<WorkspaceFileMutationResult>;
}

/** Host-owned system Git adapter. Repository paths and process details never cross this port. */
export interface HostGitService {
  toolchain(): GitToolchainReadModel | Promise<GitToolchainReadModel>;
  repository(input: { readonly workspaceId: WorkspaceId }): GitRepositoryReadModel | Promise<GitRepositoryReadModel>;
  diff(input: { readonly workspaceId: WorkspaceId; readonly path: string; readonly target: "working" | "staged" }): GitDiffReadModel | Promise<GitDiffReadModel>;
  branches(input: { readonly workspaceId: WorkspaceId }): GitBranchListReadModel | Promise<GitBranchListReadModel>;
  worktrees(input: { readonly workspaceId: WorkspaceId }): GitWorktreeListReadModel | Promise<GitWorktreeListReadModel>;
  remotes(input: { readonly workspaceId: WorkspaceId }): GitRemoteListReadModel | Promise<GitRemoteListReadModel>;
  log(input: { readonly workspaceId: WorkspaceId; readonly limit?: number; readonly skip?: number }): GitLogListReadModel | Promise<GitLogListReadModel>;
  commitChanges(input: { readonly workspaceId: WorkspaceId; readonly oid: string }): GitCommitChangesReadModel | Promise<GitCommitChangesReadModel>;
  commitDiff(input: { readonly workspaceId: WorkspaceId; readonly oid: string; readonly path: string }): GitCommitDiffReadModel | Promise<GitCommitDiffReadModel>;
  execute(input: GitExecuteInput, requestId: CommandRequestId): GitOperationResult | Promise<GitOperationResult>;
  cancelAll?(): void | Promise<void>;
  onProgress?(listener: (progress: OperationProgress) => void): () => void;
  /**
   * Optional: repository mutations the Host detected outside `execute`
   * (the agent or an external tool ran git). The facade forwards these as
   * `git.repository.changed` with reason "external".
   */
  onExternalRepositoryChange?(listener: (change: { readonly workspaceId: WorkspaceId }) => void): () => void;
  /** Optional: release Host-side resources (watchers, timers). */
  dispose?(): void;
}

/** Host-owned GitHub CLI adapter. Tokens and gh configuration never cross this port. */
export interface HostGitHubService {
  auth(input: { readonly workspaceId?: WorkspaceId }): GitHubAuthReadModel | Promise<GitHubAuthReadModel>;
  pullRequests(input: { readonly workspaceId: WorkspaceId; readonly state?: "open" | "closed" | "merged" | "all" }): GitHubPullRequestListReadModel | Promise<GitHubPullRequestListReadModel>;
  pullRequest(input: { readonly workspaceId: WorkspaceId; readonly number: number }): GitHubPullRequestDetailReadModel | Promise<GitHubPullRequestDetailReadModel>;
  checks(input: { readonly workspaceId: WorkspaceId; readonly number: number }): GitHubChecksReadModel | Promise<GitHubChecksReadModel>;
  execute(input: GitHubExecuteInput, requestId: CommandRequestId): GitHubOperationResult | Promise<GitHubOperationResult>;
  cancelAll?(): void | Promise<void>;
  onProgress?(listener: (progress: OperationProgress) => void): () => void;
}

/**
 * Host-owned token-usage adapter. Syncs via `omp stats --summary` and reads
 * aggregates from stats.db. Paths never appear on the public read model.
 */
export interface HostUsageService {
  get(): TokenUsageReadModel | Promise<TokenUsageReadModel>;
  openDashboard(): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/** Input accepted by the semantic interaction responder. */
export interface HostInteractionRespondInput {
  readonly interactionId: InteractionId;
  /** Lease generation captured by the client-visible interaction card. */
  readonly leaseGeneration: number;
  readonly decision: "submit" | "cancel";
  readonly value?: InteractionResponseValue;
}

/**
 * Explicit semantic command service for `session.create`, `session.resume`, `session.drop`
 * and `interaction.respond`. Absent service means the facade returns
 * CAPABILITY_UNAVAILABLE. `session.drop` / `interaction.respond` still
 * need a live Runtime snapshot. `session.create` / `session.resume` may run
 * without one so they can start a fresh or catalog-bound Runtime. Never
 * fabricates a completion.
 */
export interface HostSemanticCommandService {
  create?(): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  resume(input: { readonly threadId: ThreadId }): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  drop(input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandRequestId;
  }): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  respond(input: HostInteractionRespondInput): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
  /**
   * Apply the tool approval mode across resident Runtimes (plan §5.3): the
   * active Runtime persists the mode, siblings receive non-persistent
   * overrides. Accepted during a live turn; Runtime applies the write on the
   * next user turn. Failures surface as `syncStatus: "partial"`, never faked.
   */
  setApprovalMode?(input: {
    readonly mode: ApprovalMode;
  }):
    | {
        readonly mode: ApprovalMode;
        readonly syncStatus: "complete" | "partial";
        readonly appliedSessions: number;
        readonly failedSessions: number;
      }
    | Promise<{
        readonly mode: ApprovalMode;
        readonly syncStatus: "complete" | "partial";
        readonly appliedSessions: number;
        readonly failedSessions: number;
      }>;
  /**
   * P4 Runtime primitive bridge. Pass the client `requestId` so ledger
   * rejected / outcome_unknown rows stay aligned with the same command.
   * The Host remains the sole operation owner. `operator.invoke` returns
   * an `OperatorInvokeOutcome` (command output beside the snapshot);
   * `session.tree.navigate` / `session.tree.branch` return the snapshot plus
   * editor fill-back; `btw.ask` returns the ephemeral id and branch token,
   * `btw.branch` the branch outcome; every other operation returns the
   * post-command snapshot.
   */
  invoke?(
    operation: StudioOperation,
    requestId?: CommandRequestId,
  ):
    | HostInvokeOutcome
    | Promise<HostInvokeOutcome>;
  /**
   * Archive a thread: the Host moves the session JSONL (gzip) and artifacts
   * into the OMP cold-archive tree, mirroring `omp gc`. A live resident
   * session is aborted (if streaming) and switched off the file first.
   */
  archive?(input: { readonly threadId: ThreadId }): ConfigWriteResult | Promise<ConfigWriteResult>;
  /** Restore an archived thread back into the active sessions tree. */
  unarchive?(input: { readonly threadId: ThreadId }): ConfigWriteResult | Promise<ConfigWriteResult>;
  /**
   * Permanently delete a thread: the Host evacuates a resident Runtime off the
   * file, then removes the transcript, artifacts dir, and every related local
   * record (telemetry, thread binding, session lease, pin entry).
   */
  delete?(input: { readonly threadId: ThreadId }): ConfigWriteResult | Promise<ConfigWriteResult>;
}

/** Default diagnostics factory: real timestamps and random opaque entry ids. */
export function createDefaultHostDiagnosticsFactory(): HostDiagnosticsFactory {
  return {
    now: () => new Date().toISOString(),
    newEntryId: () => randomUUID() as DiagnosticEntryId,
  };
}

const CLIENT_ERROR_CODES: Record<ClientErrorCode, true> = {
  UNAVAILABLE: true,
  INVALID_ARGUMENT: true,
  STALE_EPOCH: true,
  STATE_VERSION_CONFLICT: true,
  CAPABILITY_UNAVAILABLE: true,
  RESYNC_REQUIRED: true,
  TRANSPORT_ERROR: true,
  INTERNAL_ERROR: true,
  CURSOR_STALE: true,
};

/** Narrow check for an already-shaped ClientError (e.g. thrown by a service). */
export function isClientError(value: unknown): value is ClientError {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("code" in value) || !("message" in value)) return false;
  const { code, message } = value;
  if (typeof code !== "string" || typeof message !== "string") return false;
  return code in CLIENT_ERROR_CODES;
}

/** Idempotency-key sentinel helper; non-empty or invalid. */
export function isValidKey(value: IdempotencyKey): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * Map a thrown value to a safe ClientError. ClientError-shaped throws pass
 * through unchanged (their message is already pre-redacted); everything
 * else is wrapped with a redacted message and the given fallback code.
 */
export function toClientError(error: unknown, fallbackCode: ClientErrorCode = "INTERNAL_ERROR"): ClientError {
  if (isClientError(error)) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof StudioHostError) {
    return mapStudioHostError(error);
  }
  if (error instanceof Error && error.message.length > 0) {
    return { code: fallbackCode, message: redactText(error.message) };
  }
  return { code: fallbackCode, message: "Host rejected the request" };
}

function mapStudioHostError(error: StudioHostError): ClientError {
  switch (error.code) {
    case "INVALID_ARGUMENT":
      return { code: "INVALID_ARGUMENT", message: error.message };
    case "CURSOR_STALE":
      return { code: "CURSOR_STALE", message: error.message };
    case "RUNTIME_EPOCH_STALE":
      return { code: "STALE_EPOCH", message: error.message };
    case "STATE_VERSION_CONFLICT":
      return { code: "STATE_VERSION_CONFLICT", message: error.message };
    case "CAPABILITY_UNAVAILABLE":
      return { code: "CAPABILITY_UNAVAILABLE", message: error.message };
    case "BUSY_STREAMING":
    case "COMMAND_BLOCKED":
    case "INTERACTION_STALE":
    case "NOT_OWNER":
      return { code: "INVALID_ARGUMENT", message: error.message };
    default:
      return { code: "INTERNAL_ERROR", message: redactText(error.message) };
  }
}
