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
  McpReadModel,
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
  OpaqueCursor,
  RuntimeChannel,
  RuntimeInstallState,
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
  GitExecuteInput,
  GitOperationResult,
  GitHubAuthReadModel,
  GitHubPullRequestListReadModel,
  GitHubPullRequestDetailReadModel,
  GitHubChecksReadModel,
  GitHubExecuteInput,
  GitHubOperationResult,
  OperationProgress,
} from "@omp-studio/client-contract";
import type {
  ApprovalMode,
  CapabilityManifest,
  ConversationTranscriptPage,
  OperatorCommandManifest,
  OperatorStateSnapshot,
  RuntimeBackend,
  RuntimeClassification,
  RuntimeEpoch,
  RuntimeId,
} from "@omp-studio/studio-protocol";
import {
  StudioHostError,
  type HostBackend,
  type RuntimePublication,
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
  readonly hello: () => HostRuntimeHelloView | undefined;
  readonly snapshot?: () => OperatorStateSnapshot | undefined;
  /** Opaque transcript head hint for bootstrap; never message bodies. */
  readonly messagesCursor?: () => OpaqueCursor | undefined;
  readonly onPublication?: (listener: (publication: RuntimePublication) => void) => () => void;
  readonly onConversationEvent?: (listener: (event: StudioConversationForward) => void) => () => void;
  readonly onConversationResync?: (listener: (reason: string) => void) => () => void;
  readonly onTelemetryEvent?: (listener: (event: StudioTelemetryForward) => void) => () => void;
  readonly onInteractionEvent?: (listener: (event: StudioInteractionForward) => void) => () => void;
}

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
}

/**
 * Session catalog provider (SessionCatalog + Studio Thread metadata in the
 * integration plan). Never returns filesystem paths; the facade maps each
 * entry to opaque branded ids and bounded safe text.
 */
export interface HostSessionCatalogProvider {
  list(): HostCatalogEntry[] | Promise<HostCatalogEntry[]>;
}

/** Runtime-independent persistent transcript reader owned by the Host/Broker. */
export interface HostSessionArchiveProvider {
  readPage(input: {
    readonly sessionId: string;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): ConversationTranscriptReadPage | Promise<ConversationTranscriptReadPage>;
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
  execute(input: GitExecuteInput, requestId: CommandRequestId): GitOperationResult | Promise<GitOperationResult>;
  cancelAll?(): void | Promise<void>;
  onProgress?(listener: (progress: OperationProgress) => void): () => void;
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
   * overrides. Rejected while the Runtime is streaming or an interaction is
   * pending. Failures surface as `syncStatus: "partial"`, never faked.
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
   * The Host remains the sole operation owner.
   */
  invoke?(
    operation: StudioOperation,
    requestId?: CommandRequestId,
  ): OperatorStateSnapshot | Promise<OperatorStateSnapshot>;
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
