/**
 * StudioHostClientFacade — the P1 presentation-neutral product API.
 *
 * Implements the exact `ClientTransport` envelopes (bootstrap/query/
 * command/subscribe/close) over injected Host seams: a public authority
 * identity, platform facts, `HostBackend`, capability/command manifest
 * providers, an optional ready `StudioRuntimeSessionController` with safe
 * hello/snapshot access, a session catalog provider, a diagnostics
 * clock/id factory, the runtime install command service and the optional
 * semantic command service.
 *
 * Contract guarantees (FRONTEND_INTEGRATION.md §§8, 9.2):
 * - `accepted` is distinct from terminal: a command is never reported as
 *   accepted unless the Host took it, and only a `command.receipt` event
 *   carries the final outcome. No fake completions.
 * - Unavailable operations fail closed: missing Runtime snapshot or
 *   missing service maps to UNAVAILABLE / CAPABILITY_UNAVAILABLE before
 *   anything is accepted.
 * - Same idempotency key + same semantic input replays the same
 *   acceptance; key reuse with different input fails.
 * - Events carry a monotonic decimal cursor, authority/runtime epochs and
 *   stateVersion, so the client reducer can detect gaps and stale epochs.
 * - `close()` severs only this client session (subscriptions); Host and
 *   Runtime keep running.
 *
 * Nothing client-facing structurally contains executable identities/paths,
 * session filesystem data, Runtime PIDs, Bridge endpoints or tokens. This
 * module never imports Electron.
 */

import type {
  ArchId,
  ClientBootstrap,
  ClientBootstrapBase,
  ClientCommandAccepted,
  ClientCommandRequest,
  ClientError,
  ClientErrorCode,
  ClientInteraction,
  ConversationTranscriptReadPage,
  ClientEvent,
  ClientQueryRequest,
  ClientQueryResponse,
  ClientSelection,
  ClientTransport,
  CommandName,
  CommandReceipt,
  CommandRequestId,
  DiagnosticEntry,
  DiagnosticReadModel,
  EnvironmentReadModel,
  ConfigWriteResult,
  ExtensibilityReadModel,
  McpReadModel,
  AgentDefinitionsReadModel,
  HomeReadModel,
  IdempotencyKey,
  InteractionId,
  ModelConfigReadModel,
  ModelDiscoveryResult,
  ModelProviderTestResult,
  PlatformId,
  PublicAuthorityIdentity,
  QueryName,
  RuntimeChannel,
  RuntimeConnection,
  RuntimeEpoch,
  RuntimeId,
  RuntimeInstallState,
  SessionHistoryEntry,
  SessionHistoryReadModel,
  SessionId,
  StateVersion,
  SubscriptionScope,
  SurfaceCapabilities,
  ThreadId,
  TokenUsageReadModel,
  Unsubscribe,
  WorkspaceId,
  WorkspaceListReadModel,
  WorkspaceFileTreeReadModel,
  WorkspaceFileMutationResult,
  OpaqueCursor,
  GitExecuteInput,
  GitHubExecuteInput,
  GitOperationResult,
  GitHubOperationResult,
} from "@omp-studio/client-contract";
import { CLIENT_CONTRACT_VERSION } from "@omp-studio/client-contract";
import type {
  CapabilityManifest,
  CommandLedgerEntry,
  ConversationTranscriptPage,
  OperatorCommandManifest,
  OperatorStateSnapshot,
  RuntimeInstallationManifest,
} from "@omp-studio/studio-protocol";
import type { StudioOperation } from "@omp-studio/studio-protocol";
import { canonicalJson, parseConversationRuntimeEvent, parseConversationTranscriptPage } from "@omp-studio/studio-protocol";
import type { HostBackend, RuntimePublication, StudioConversationForward, StudioInteractionForward, StudioTelemetryForward } from "@omp-studio/studio-host";

import {
  HostEventBus,
  receiptFromLedgerEntry,
  type HostEventContext,
} from "./events.js";
import {
  buildDiagnosticsReadModel,
  environmentIdFor,
  historyIdFor,
  neutralCapabilityManifest,
  neutralCommandManifest,
  sanitizeDisplayText,
  threadIdFor,
} from "./read-models.js";
import { mapRemoteInteractionToClient } from "./interaction-map.js";
import {
  toClientError,
  type HostCatalogEntry,
  type HostDiagnosticsFactory,
  type HostExtensibilityService,
  type HostMcpService,
  type HostAgentDefinitionsService,
  type HostManifestProvider,
  type HostModelsService,
  type HostRuntimeAccess,
  type HostRuntimeHelloView,
  type HostRuntimeInstallService,
  type HostSemanticCommandService,
  type HostSessionCatalogProvider,
  type HostSessionArchiveProvider,
  type HostUsageService,
  type HostWorkspaceService,
  type HostWorkspaceFileService,
  type HostGitService,
  type HostGitHubService,
} from "./services.js";

/** Conservative surface grants: every optional surface is off by default. */
const DEFAULT_SURFACE: SurfaceCapabilities = Object.freeze({
  terminalAttach: false,
  fileReveal: false,
  previewInput: false,
  openExternal: false,
});

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 200;
const HOME_RECENT_THREADS = 5;
const HOME_RECENT_WORKSPACES = 8;
const DEFAULT_REGISTRY_CAPACITY = 512;

/** Model-config write/test commands dispatched through the models adapter. */
type ModelsCommandName =
  | "models.provider.upsert"
  | "models.provider.delete"
  | "models.provider.setEnabled"
  | "models.roles.set"
  | "models.roles.write"
  | "models.roles.create"
  | "models.roles.delete"
  | "models.roleStorage.set"
  | "models.fallback.set"
  | "models.providerOrder.set"
  | "models.yml.write"
  | "models.login.start"
  | "models.login.logout"
  | "models.provider.test"
  | "models.provider.probe"
  | "models.discovery.refresh"
  | "models.cycleOrder.set";

type AgentDefinitionsCommandName =
  | "agents.definition.upsert"
  | "agents.definition.delete"
  | "agents.definition.configure";

/** Facade constructor inputs; every seam is explicit and injectable. */
export interface StudioHostClientFacadeOptions {
  readonly authority: PublicAuthorityIdentity;
  readonly platform: PlatformId;
  readonly arch: ArchId;
  readonly backend: HostBackend;
  readonly capabilityManifest: HostManifestProvider<CapabilityManifest>;
  readonly commandManifest: HostManifestProvider<OperatorCommandManifest>;
  /** Optional ready Runtime session controller plus safe hello/snapshot access. */
  readonly runtime?: HostRuntimeAccess;
  readonly catalog: HostSessionCatalogProvider;
  /** Optional Runtime-independent persistent transcript reader. */
  readonly archive?: HostSessionArchiveProvider;
  readonly diagnostics: HostDiagnosticsFactory;
  readonly install: HostRuntimeInstallService;
  /** Optional semantic service for session.resume/drop and interaction.respond. */
  readonly commands?: HostSemanticCommandService;
  /** Optional OMP models.yml / config / login adapter. */
  readonly models?: HostModelsService;
  /** Optional configured skills/plugins inventory adapter. */
  readonly extensibility?: HostExtensibilityService;
  /** Optional configured MCP server inventory adapter. */
  readonly mcp?: HostMcpService;
  /** Optional configured task-agent definition adapter. */
  readonly agentDefinitions?: HostAgentDefinitionsService;
  /** Optional Host workspace registry adapter (paths never leave it). */
  readonly workspaces?: HostWorkspaceService;
  /** Optional Host-owned workspace-relative file tree adapter. */
  readonly workspaceFiles?: HostWorkspaceFileService;
  /** Optional Host-owned system Git adapter. Independent of Runtime availability. */
  readonly git?: HostGitService;
  /** Optional Host-owned GitHub CLI adapter. Independent of Runtime availability. */
  readonly github?: HostGitHubService;
  /** Optional omp stats usage adapter (heatmap / native dashboard). */
  readonly usage?: HostUsageService;
  /** Bounded idempotency registry capacity (default 512). */
  readonly registryCapacity?: number;
}

interface RegistryEntry {
  readonly key: IdempotencyKey;
  readonly requestId: CommandRequestId;
  readonly commandName: CommandName;
  readonly inputJson: string;
  readonly acceptedAt: string;
  terminal: CommandReceipt | undefined;
}

/**
 * Bounded requestId+idempotencyKey registry enforcing semantic equality:
 * same key + same command + same canonical input replays; key reuse with
 * different input (or requestId reuse under a different key) fails.
 */
class CommandRegistry {
  readonly #byKey = new Map<IdempotencyKey, RegistryEntry>();
  readonly #byRequestId = new Map<CommandRequestId, RegistryEntry>();

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError("registry capacity must be a positive integer");
    }
  }

  /**
   * Returns the existing entry when the envelope repeats an idempotency
   * key with identical semantic input; throws INVALID_ARGUMENT on key
   * reuse with different input or requestId reuse under another key;
   * registers and returns undefined otherwise.
   */
  accept(
    request: {
      readonly commandName: CommandName;
      readonly input: unknown;
      readonly idempotencyKey: IdempotencyKey;
      readonly requestId: CommandRequestId;
    },
    acceptedAt: string,
  ): RegistryEntry | undefined {
    const inputJson = canonicalJson(request.input);
    const existing = this.#byKey.get(request.idempotencyKey);
    if (existing !== undefined) {
      if (existing.commandName !== request.commandName || existing.inputJson !== inputJson) {
        throw clientError("INVALID_ARGUMENT", "idempotency key reused with different semantic input");
      }
      return existing;
    }
    const tracked = this.#byRequestId.get(request.requestId);
    if (tracked !== undefined) {
      throw clientError("INVALID_ARGUMENT", "request id reused with a different idempotency key");
    }
    const entry: RegistryEntry = {
      key: request.idempotencyKey,
      requestId: request.requestId,
      commandName: request.commandName,
      inputJson,
      acceptedAt,
      terminal: undefined,
    };
    this.#byKey.set(entry.key, entry);
    this.#byRequestId.set(entry.requestId, entry);
    this.#evictOldest();
    return undefined;
  }

  getByRequestId(requestId: CommandRequestId): RegistryEntry | undefined {
    return this.#byRequestId.get(requestId);
  }

  recordTerminal(requestId: CommandRequestId, receipt: CommandReceipt): void {
    const entry = this.#byRequestId.get(requestId);
    if (entry !== undefined) {
      entry.terminal = receipt;
    }
  }

  #evictOldest(): void {
    while (this.#byKey.size > this.capacity) {
      const oldestKey = this.#byKey.keys().next().value as IdempotencyKey | undefined;
      if (oldestKey === undefined) break;
      const entry = this.#byKey.get(oldestKey);
      this.#byKey.delete(oldestKey);
      if (entry !== undefined) {
        this.#byRequestId.delete(entry.requestId);
      }
    }
  }
}

function clientError(code: ClientErrorCode, message: string): ClientError {
  return { code, message };
}

function unavailableError(message: string): ClientError {
  return { code: "UNAVAILABLE", message };
}

function validateEnvelope(request: {
  readonly requestId: CommandRequestId;
  readonly idempotencyKey: IdempotencyKey;
}): void {
  if (request.requestId.length === 0) {
    throw clientError("INVALID_ARGUMENT", "requestId must not be empty");
  }
  if (request.idempotencyKey.length === 0) {
    throw clientError("INVALID_ARGUMENT", "idempotencyKey must not be empty");
  }
}

function validateInteractionValue(value: unknown): void {
  const MAX_TEXT = 128 * 1024;
  const MAX_ITEMS = 256;
  if (value === undefined || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_TEXT) throw clientError("INVALID_ARGUMENT", "interaction.respond text value is too large");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw clientError("INVALID_ARGUMENT", "interaction.respond has too many selected values");
    if (value.every((item) => typeof item === "string" && item.length <= MAX_TEXT)) return;
    throw clientError("INVALID_ARGUMENT", "interaction.respond array value must contain only strings");
  }
  if (value !== null && typeof value === "object") {
    try {
      if (JSON.stringify(value).length <= MAX_TEXT) return;
    } catch {
      // Fall through to the same fail-closed error as non-JSON values.
    }
  }
  throw clientError("INVALID_ARGUMENT", "interaction.respond value has an unsupported shape");
}

function isThreadCommandInput(value: unknown): value is { readonly threadId: ThreadId } {
  if (value === null || typeof value !== "object" || !("threadId" in value)) return false;
  return typeof value.threadId === "string" && value.threadId.length > 0;
}

function isInteractionCommandInput(
  value: unknown,
): value is {
  readonly interactionId: InteractionId;
  readonly leaseGeneration: number;
  readonly decision: "submit" | "cancel";
  readonly value?: unknown;
} {
  if (value === null || typeof value !== "object") return false;
  if (!("interactionId" in value) || !("leaseGeneration" in value) || !("decision" in value)) return false;
  const { interactionId, leaseGeneration, decision } = value;
  if (typeof interactionId !== "string" || interactionId.length === 0) return false;
  if (typeof leaseGeneration !== "number" || !Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) return false;
  return decision === "submit" || decision === "cancel";
}

function connectionEquals(left: RuntimeConnection, right: RuntimeConnection): boolean {
  return (
    left.status === right.status &&
    left.classification === right.classification &&
    left.runtimeId === right.runtimeId &&
    left.runtimeEpoch === right.runtimeEpoch
  );
}

function validateOptions(options: StudioHostClientFacadeOptions): void {
  if (options.authority.authorityId.length === 0) {
    throw new TypeError("facade authority id is required");
  }
  if (!Number.isSafeInteger(options.authority.authorityEpoch) || options.authority.authorityEpoch < 1) {
    throw new TypeError("facade authority epoch must be a positive integer");
  }
  if (options.platform !== "win32" && options.platform !== "darwin") {
    throw new TypeError("facade platform must be 'win32' or 'darwin'");
  }
  if (options.arch !== "x64" && options.arch !== "arm64") {
    throw new TypeError("facade arch must be 'x64' or 'arm64'");
  }
  if (options.backend === null || typeof options.backend !== "object") {
    throw new TypeError("facade backend is required");
  }
  if (typeof options.capabilityManifest !== "function") {
    throw new TypeError("facade capability manifest provider is required");
  }
  if (typeof options.commandManifest !== "function") {
    throw new TypeError("facade command manifest provider is required");
  }
  if (options.catalog === null || typeof options.catalog.list !== "function") {
    throw new TypeError("facade session catalog provider is required");
  }
  if (options.archive !== undefined && typeof options.archive.readPage !== "function") {
    throw new TypeError("facade session archive provider must expose readPage");
  }
  if (options.diagnostics === null || typeof options.diagnostics.now !== "function" || typeof options.diagnostics.newEntryId !== "function") {
    throw new TypeError("facade diagnostics factory is required");
  }
  if (typeof options.install !== "function") {
    throw new TypeError("facade runtime install service is required");
  }
  const runtime = options.runtime;
  if (runtime !== undefined && typeof runtime.hello !== "function") {
    throw new TypeError("facade runtime access requires a hello accessor");
  }
  if (runtime?.onPublication !== undefined && typeof runtime.onPublication !== "function") {
    throw new TypeError("facade runtime publication hook must be a function");
  }
  if (runtime?.onConversationEvent !== undefined && typeof runtime.onConversationEvent !== "function") {
    throw new TypeError("facade runtime conversation hook must be a function");
  }
  if (runtime?.onConversationResync !== undefined && typeof runtime.onConversationResync !== "function") {
    throw new TypeError("facade runtime conversation resync hook must be a function");
  }
  if (runtime?.onTelemetryEvent !== undefined && typeof runtime.onTelemetryEvent !== "function") {
    throw new TypeError("facade runtime telemetry hook must be a function");
  }
  if (runtime?.currentSession !== undefined && typeof runtime.currentSession !== "function") {
    throw new TypeError("facade runtime currentSession must be a function");
  }
  if (runtime?.readTranscript !== undefined && typeof runtime.readTranscript !== "function") {
    throw new TypeError("facade runtime readTranscript must be a function");
  }
  if (runtime?.onInteractionEvent !== undefined && typeof runtime.onInteractionEvent !== "function") {
    throw new TypeError("facade runtime interaction hook must be a function");
  }
}

/**
 * Presentation-neutral Host facade implementing the exact client-contract
 * transport surface. See the module doc for contract guarantees.
 */
export class StudioHostClientFacade implements ClientTransport {
  readonly #options: StudioHostClientFacadeOptions;
  readonly #registry: CommandRegistry;
  readonly #bus: HostEventBus;
  readonly #terminalEmitted = new Set<CommandRequestId>();
  #unsubscribePublication: Unsubscribe | undefined;
  #unsubscribeConversation: Unsubscribe | undefined;
  #unsubscribeConversationResync: Unsubscribe | undefined;
  #unsubscribeTelemetry: Unsubscribe | undefined;
  #unsubscribeInteraction: Unsubscribe | undefined;
  #unsubscribeGitProgress: Unsubscribe | undefined;
  #unsubscribeGithubProgress: Unsubscribe | undefined;
  #closed = false;
  #lastHello: HostRuntimeHelloView | undefined;
  #lastEmittedConnection: RuntimeConnection | undefined;
  #lastPublishedVersion: StateVersion | undefined;
  #lastPublishedEpoch: RuntimeEpoch | undefined;
  #installInFlight = false;
  #lastInstallResult: RuntimeInstallState | undefined;
  /** Last workspace list seen; feeds the bootstrap selection (`projects.list` wins in the Renderer). */
  #lastWorkspaceModel: WorkspaceListReadModel | undefined;
  readonly #conversationDiagnostics: DiagnosticEntry[] = [];

  constructor(options: StudioHostClientFacadeOptions) {
    validateOptions(options);
    this.#options = options;
    this.#registry = new CommandRegistry(options.registryCapacity ?? DEFAULT_REGISTRY_CAPACITY);
    this.#bus = new HostEventBus(options.authority.authorityEpoch, () => options.diagnostics.now(), () => this.#eventContext());
    this.#lastEmittedConnection = this.#currentConnection();
    const onPublication = options.runtime?.onPublication;
    if (onPublication !== undefined) {
      this.#unsubscribePublication = onPublication((publication) => this.#onPublication(publication));
    }
    this.#bindConversation();
    this.#bindTelemetry();
    this.#bindInteraction();
    this.#unsubscribeGitProgress = options.git?.onProgress?.((progress) => {
      this.#bus.emit({ kind: "operation.progress", progress });
    });
    this.#unsubscribeGithubProgress = options.github?.onProgress?.((progress) => {
      this.#bus.emit({ kind: "operation.progress", progress });
    });
  }

  async bootstrap(): Promise<ClientBootstrap> {
    this.#assertOpen();
    // Capture the resume cursor before reading the snapshot. Events emitted
    // after this point remain strictly newer than the baseline and can be
    // replayed from StudioClient's bootstrap buffer instead of being
    // mistaken for duplicates of the snapshot.
    const bootstrapCursor = this.#bus.currentCursor();
    const now = this.#options.diagnostics.now();
    const capabilityManifest = await this.#resolveManifest(this.#options.capabilityManifest, () => neutralCapabilityManifest(now));
    const commandManifest = await this.#resolveManifest(this.#options.commandManifest, () => neutralCommandManifest(now));
    const snapshot = this.#currentSnapshot();
    const connection = this.#currentConnection();
    this.#lastEmittedConnection = connection;
    const base: ClientBootstrapBase = {
      contractVersion: CLIENT_CONTRACT_VERSION,
      authority: { ...this.#options.authority },
      runtime: connection,
      surface: DEFAULT_SURFACE,
      capabilityManifest,
      commandManifestHash: commandManifest.hash,
      selected: this.#selection(snapshot),
    };
    if (snapshot === undefined) {
      // Without-snapshot variant: the three snapshot keys stay structurally
      // absent (exactOptionalPropertyTypes) until a Runtime snapshot exists.
      return base;
    }
    const messagesCursor = this.#options.runtime?.messagesCursor?.();
    const pendingInteraction = this.#bootstrapPendingInteraction(snapshot);
    return {
      ...base,
      snapshot,
      stateVersion: snapshot.stateVersion,
      cursor: bootstrapCursor,
      ...(messagesCursor === undefined ? {} : { messagesCursor }),
      ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
    };
  }

  /**
   * Recoverable pending interaction for bootstrap (plan §1.4): read the
   * full pending from the Runtime snapshot, map through the same redacting
   * mapper. TUI-owned interactions are never exposed as submittable cards.
   */
  #bootstrapPendingInteraction(snapshot: OperatorStateSnapshot): ClientInteraction | undefined {
    const pending = snapshot.pendingInteraction;
    if (pending === undefined || pending.owner !== "gui") {
      return undefined;
    }
    return mapRemoteInteractionToClient(pending.request, snapshot.sessionId as SessionId, pending.leaseGeneration);
  }

  async query<TName extends QueryName>(request: ClientQueryRequest<TName>): Promise<ClientQueryResponse<TName>> {
    this.#assertOpen();
    try {
      const response = await this.#dispatchQuery(request);
      // The dispatch switch verified the queryName discriminant; TS cannot
      // narrow the generic type parameter itself, so the response is cast.
      return response as ClientQueryResponse<TName>;
    } catch (error) {
      return { ok: false, queryName: request.queryName, error: toClientError(error) };
    }
  }

  async #dispatchQuery(request: ClientQueryRequest): Promise<ClientQueryResponse> {
    switch (request.queryName) {
      case "environment.get": {
        const result = await this.#queryEnvironment();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "capabilities.get": {
        const result = await this.#queryCapabilities();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "commands.getManifest": {
        const result = await this.#queryCommandManifest();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "diagnostics.get": {
        const result = await this.#queryDiagnostics();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "history.list": {
        const result = await this.#queryHistory(request.input as { readonly limit?: number });
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "session.state": {
        const result = this.#querySessionState();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "home.get": {
        const result = await this.#queryHome();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "models.get": {
        const result = await this.#queryModels();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "skills.get": {
        const result = await this.#querySkills();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "mcp.get": {
        const result = await this.#queryMcp();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "agents.definitions.get": {
        const result = await this.#queryAgentDefinitions();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "projects.list": {
        const result = await this.#queryProjects();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "workspace.fileTree": {
        const service = this.#options.workspaceFiles;
        if (service === undefined) throw clientError("CAPABILITY_UNAVAILABLE", "workspace.fileTree is not available on this Host");
        const result = await service.get(request.input as { readonly workspaceId: WorkspaceId; readonly path?: string });
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "usage.get": {
        const result = await this.#queryUsage();
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "session.transcript.read": {
        const result = await this.#queryTranscript(request.input as { readonly cursor?: OpaqueCursor; readonly limit?: number });
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "session.transcript.readPage": {
        const archiveRequest = request as ClientQueryRequest<"session.transcript.readPage">;
        const result = await this.#queryArchiveTranscript(archiveRequest.input);
        return { ok: true, queryName: request.queryName, result } as ClientQueryResponse;
      }
      case "git.toolchain.get": {
        const service = this.#requireGit(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.toolchain() } as ClientQueryResponse;
      }
      case "git.repository.get": {
        const service = this.#requireGit(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.repository(request.input as { readonly workspaceId: WorkspaceId }) } as ClientQueryResponse;
      }
      case "git.diff.get": {
        const service = this.#requireGit(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.diff(request.input as never) } as ClientQueryResponse;
      }
      case "git.branches.list": {
        const service = this.#requireGit(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.branches(request.input as { readonly workspaceId: WorkspaceId }) } as ClientQueryResponse;
      }
      case "git.worktrees.list": {
        const service = this.#requireGit(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.worktrees(request.input as { readonly workspaceId: WorkspaceId }) } as ClientQueryResponse;
      }
      case "git.remotes.list": {
        const service = this.#requireGit(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.remotes(request.input as { readonly workspaceId: WorkspaceId }) } as ClientQueryResponse;
      }
      case "github.auth.get": {
        const service = this.#requireGithub(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.auth(request.input as { readonly workspaceId?: WorkspaceId }) } as ClientQueryResponse;
      }
      case "github.pr.list": {
        const service = this.#requireGithub(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.pullRequests(request.input as never) } as ClientQueryResponse;
      }
      case "github.pr.get": {
        const service = this.#requireGithub(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.pullRequest(request.input as never) } as ClientQueryResponse;
      }
      case "github.pr.checks": {
        const service = this.#requireGithub(request.queryName);
        return { ok: true, queryName: request.queryName, result: await service.checks(request.input as never) } as ClientQueryResponse;
      }
    }
  }

  async command<TName extends CommandName>(request: ClientCommandRequest<TName>): Promise<ClientCommandAccepted<TName>> {
    this.#assertOpen();
    const accepted = await this.#dispatchCommand(request);
    // The dispatch switch verified the commandName discriminant; TS cannot
    // narrow the generic type parameter itself, so the ack is cast.
    return accepted as ClientCommandAccepted<TName>;
  }

  async #dispatchCommand(request: ClientCommandRequest): Promise<ClientCommandAccepted> {
    switch (request.commandName) {
      case "runtime.install": {
        // The switch verified the discriminant; TS cannot re-narrow the envelope type.
        const installRequest = request as ClientCommandRequest<"runtime.install">;
        return this.#commandInstall(installRequest);
      }
      case "session.create": {
        const createRequest = request as ClientCommandRequest<"session.create">;
        return this.#commandCreate(createRequest);
      }
      case "session.resume": {
        const resumeRequest = request as ClientCommandRequest<"session.resume">;
        return this.#commandResume(resumeRequest);
      }
      case "session.drop": {
        const dropRequest = request as ClientCommandRequest<"session.drop">;
        return this.#commandDrop(dropRequest);
      }
      case "interaction.respond": {
        const respondRequest = request as ClientCommandRequest<"interaction.respond">;
        return this.#commandRespond(respondRequest);
      }
      case "permissions.mode.set": {
        const modeRequest = request as ClientCommandRequest<"permissions.mode.set">;
        return this.#commandSetApprovalMode(modeRequest);
      }
      case "models.provider.upsert":
      case "models.provider.delete":
      case "models.provider.setEnabled":
      case "models.roles.set":
      case "models.roles.write":
      case "models.roles.create":
      case "models.roles.delete":
      case "models.roleStorage.set":
      case "models.fallback.set":
      case "models.providerOrder.set":
      case "models.yml.write":
      case "models.login.start":
      case "models.login.logout":
      case "models.provider.test":
      case "models.provider.probe":
      case "models.discovery.refresh":
      case "models.cycleOrder.set": {
        return this.#commandModels(request as ClientCommandRequest<ModelsCommandName>);
      }
      case "workspace.open":
      case "workspace.pick": {
        return this.#commandWorkspace(request as ClientCommandRequest<"workspace.open" | "workspace.pick">);
      }
      case "workspace.file.create":
      case "workspace.directory.create": {
        return this.#commandWorkspaceFile(request as ClientCommandRequest<"workspace.file.create" | "workspace.directory.create">);
      }
      case "usage.openDashboard": {
        return this.#commandUsage(request as ClientCommandRequest<"usage.openDashboard">);
      }
      case "plugins.setEnabled":
      case "skills.setEnabled": {
        return this.#commandExtensibility(request as ClientCommandRequest<"plugins.setEnabled" | "skills.setEnabled">);
      }
      case "mcp.setEnabled": {
        return this.#commandMcp(request as ClientCommandRequest<"mcp.setEnabled">);
      }
      case "agents.definition.upsert":
      case "agents.definition.delete":
      case "agents.definition.configure": {
        return this.#commandAgentDefinitions(request as ClientCommandRequest<AgentDefinitionsCommandName>);
      }
      case "git.execute":
        return this.#commandGit(request as ClientCommandRequest<"git.execute">);
      case "github.execute":
        return this.#commandGithub(request as ClientCommandRequest<"github.execute">);
      default: {
        const p4 = request as ClientCommandRequest;
        return this.#commandP4(p4);
      }
    }
  }

  #requireGit(name: string): HostGitService {
    const service = this.#options.git;
    if (service === undefined) throw clientError("CAPABILITY_UNAVAILABLE", `${name} is not available: no Git adapter is wired`);
    return service;
  }

  #requireGithub(name: string): HostGitHubService {
    const service = this.#options.github;
    if (service === undefined) throw clientError("CAPABILITY_UNAVAILABLE", `${name} is not available: no GitHub adapter is wired`);
    return service;
  }

  async #commandGit(request: ClientCommandRequest<"git.execute">): Promise<ClientCommandAccepted> {
    return this.#commandHostOperation(request, this.#requireGit(request.commandName), "git");
  }

  async #commandGithub(request: ClientCommandRequest<"github.execute">): Promise<ClientCommandAccepted> {
    return this.#commandHostOperation(request, this.#requireGithub(request.commandName), "github");
  }

  async #commandHostOperation(
    request: ClientCommandRequest<"git.execute"> | ClientCommandRequest<"github.execute">,
    service: HostGitService | HostGitHubService,
    domain: "git" | "github",
  ): Promise<ClientCommandAccepted> {
    validateEnvelope(request as ClientCommandRequest);
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request as ClientCommandRequest, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt } as ClientCommandAccepted;
    }
    const accepted = { commandName: request.commandName, requestId: request.requestId, status: "accepted" as const, acceptedAt };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void (async () => {
      try {
        const result: GitOperationResult | GitHubOperationResult = domain === "git"
          ? await (service as HostGitService).execute(request.input as GitExecuteInput, request.requestId)
          : await (service as HostGitHubService).execute(request.input as GitHubExecuteInput, request.requestId);
        this.#emitTerminal(request.requestId, { requestId: request.requestId, commandName: request.commandName, status: "completed", result, observedAt: this.#options.diagnostics.now() } as CommandReceipt);
        const changesLocalRepository = domain === "git" || (domain === "github" && request.input.operation.kind === "pr.checkout");
        if (changesLocalRepository && request.input.workspaceId !== undefined) {
          const repository = domain === "git" ? (result as GitOperationResult).repository : undefined;
          this.#bus.emit({
            kind: "git.repository.changed",
            repository: {
              workspaceId: request.input.workspaceId,
              ...(repository?.repositoryId === undefined ? {} : { repositoryId: repository.repositoryId }),
              ...(repository?.revision === undefined ? {} : { revision: repository.revision }),
              reason: "command",
            },
          });
        }
      } catch (error) {
        this.#emitTerminal(request.requestId, { requestId: request.requestId, commandName: request.commandName, status: "failed", error: toClientError(error), observedAt: this.#options.diagnostics.now() } as CommandReceipt);
      }
    })();
    return accepted as ClientCommandAccepted;
  }

  async #commandP4(request: ClientCommandRequest): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.commands;
    if (service?.invoke === undefined) throw clientError("CAPABILITY_UNAVAILABLE", `${request.commandName} is not available on this Host`);
    if (this.#currentSnapshot() === undefined) throw unavailableError(`${request.commandName} requires a Runtime snapshot`);
    const operation = { kind: request.commandName, ...request.input } as unknown as StudioOperation;
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) { this.#replayTerminal(replay, request.requestId); return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt } as ClientCommandAccepted; }
    const accepted = { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt } as ClientCommandAccepted;
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runP4Command(() => service.invoke!(operation, request.requestId), request.requestId, request.commandName);
    return accepted;
  }

  async #runP4Command(run: () => OperatorStateSnapshot | Promise<OperatorStateSnapshot>, requestId: CommandRequestId, commandName: CommandName): Promise<void> {
    try {
      const result = await run();
      this.#emitTerminal(requestId, { requestId, commandName, status: "completed", result, observedAt: this.#options.diagnostics.now() } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(requestId, { requestId, commandName, status: "failed", error: toClientError(error), observedAt: this.#options.diagnostics.now() } as CommandReceipt);
    }
  }

  subscribe(scope: SubscriptionScope, listener: (event: ClientEvent) => void): Unsubscribe {
    if (this.#closed) {
      return () => {};
    }
    return this.#bus.subscribe(scope, listener);
  }

  /** Close the client session only: subscriptions are dropped, Host/Runtime keep running. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribePublication?.();
    this.#unsubscribePublication = undefined;
    this.#unsubscribeConversation?.();
    this.#unsubscribeConversation = undefined;
    this.#unsubscribeConversationResync?.();
    this.#unsubscribeConversationResync = undefined;
    this.#unsubscribeTelemetry?.();
    this.#unsubscribeTelemetry = undefined;
    this.#unsubscribeInteraction?.();
    this.#unsubscribeInteraction = undefined;
    this.#unsubscribeGitProgress?.();
    this.#unsubscribeGitProgress = undefined;
    this.#unsubscribeGithubProgress?.();
    this.#unsubscribeGithubProgress = undefined;
    this.#bus.close();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw clientError("TRANSPORT_ERROR", "host client facade is closed");
    }
  }

  // ------------------------------------------------------------------
  // Bootstrap helpers
  // ------------------------------------------------------------------

  #eventContext(): HostEventContext {
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) {
      return {};
    }
    return { stateVersion: snapshot.stateVersion, runtimeEpoch: snapshot.runtimeEpoch };
  }

  #selection(snapshot: OperatorStateSnapshot | undefined): ClientSelection {
    const environmentId = environmentIdFor(this.#options.authority.authorityId);
    const activeWorkspaceId = this.#lastWorkspaceModel?.activeWorkspaceId;
    return {
      environmentId,
      ...(snapshot === undefined ? {} : { sessionId: snapshot.sessionId }),
      ...(activeWorkspaceId === undefined ? {} : { workspaceId: activeWorkspaceId }),
    };
  }

  async #resolveManifest<T>(provider: HostManifestProvider<T>, fallback: () => T): Promise<T> {
    try {
      const value = await provider();
      return value === undefined ? fallback() : value;
    } catch {
      return fallback();
    }
  }

  // ------------------------------------------------------------------
  // Runtime connection / snapshot access
  // ------------------------------------------------------------------

  #deriveHello(): HostRuntimeHelloView | undefined {
    const runtime = this.#options.runtime;
    if (runtime === undefined) {
      return undefined;
    }
    const hello = runtime.hello();
    if (hello !== undefined) {
      this.#lastHello = hello;
    }
    return hello;
  }

  /**
   * Current safe snapshot, or undefined when no Runtime is ready. Once a
   * Runtime was seen, a vanished hello isolates its stale snapshot: the
   * facade never serves Runtime state that belongs to a lost epoch.
   */
  #currentSnapshot(): OperatorStateSnapshot | undefined {
    const runtime = this.#options.runtime;
    if (runtime === undefined) {
      return undefined;
    }
    if (this.#deriveHello() === undefined && this.#lastHello !== undefined) {
      return undefined;
    }
    const snapshot = runtime.snapshot?.() ?? runtime.session?.publication()?.snapshot;
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  #currentConnection(): RuntimeConnection {
    const runtime = this.#options.runtime;
    if (runtime === undefined) {
      return { status: "unavailable", classification: "unavailable" };
    }
    const hello = this.#deriveHello();
    if (hello === undefined) {
      const last = this.#lastHello;
      if (last === undefined) {
        return { status: "unavailable", classification: "unavailable" };
      }
      // Runtime lost: keep the last known identity so clients can isolate
      // its epoch; nothing else is claimed.
      const runtimeId = last.runtimeId as RuntimeId;
      const runtimeEpoch = last.runtimeEpoch as RuntimeEpoch;
      return {
        status: "disconnected",
        classification: last.classification,
        runtimeId,
        runtimeEpoch,
        ...(last.backend === undefined ? {} : { backend: last.backend }),
        ...(last.runtimeVersion === undefined ? {} : { runtimeVersion: last.runtimeVersion }),
        ...(last.upstreamVersion === undefined ? {} : { upstreamVersion: last.upstreamVersion }),
        ...(last.upstreamCommit === undefined ? {} : { upstreamCommit: last.upstreamCommit }),
      };
    }
    const snapshot = this.#currentSnapshot();
    const runtimeId = hello.runtimeId as RuntimeId;
    const runtimeEpoch = hello.runtimeEpoch as RuntimeEpoch;
    return {
      status: snapshot === undefined ? "connecting" : "connected",
      classification: hello.classification,
      runtimeId,
      runtimeEpoch,
      ...(hello.backend === undefined ? {} : { backend: hello.backend }),
      ...(hello.runtimeVersion === undefined ? {} : { runtimeVersion: hello.runtimeVersion }),
      ...(hello.upstreamVersion === undefined ? {} : { upstreamVersion: hello.upstreamVersion }),
      ...(hello.upstreamCommit === undefined ? {} : { upstreamCommit: hello.upstreamCommit }),
    };
  }

  /**
   * Detect Runtime connection transitions and mirror them as
   * `runtime.changed` events so the client reducer can mark pending
   * commands outcome_unknown on loss/epoch change (§8.3.5).
   */
  #syncRuntimeEvents(): void {
    const next = this.#currentConnection();
    const prev = this.#lastEmittedConnection;
    this.#lastEmittedConnection = next;
    if (prev === undefined || connectionEquals(prev, next)) {
      return;
    }
    this.#bus.emit({
      kind: "runtime.changed",
      connection: next,
      ...(next.runtimeEpoch === undefined ? {} : { runtimeEpoch: next.runtimeEpoch }),
    });
  }

  #onPublication(publication: RuntimePublication): void {
    const snapshot = publication.snapshot;
    // A resident Worker may be re-selected with an older per-Worker epoch.
    // Publish the connection change first so the Client resets its active
    // Runtime fence before receiving that Worker's snapshot.
    this.#syncRuntimeEvents();
    const version = snapshot.stateVersion;
    const epochChanged = this.#lastPublishedEpoch !== snapshot.runtimeEpoch;
    if (epochChanged) {
      this.#lastPublishedEpoch = snapshot.runtimeEpoch;
      this.#lastPublishedVersion = undefined;
    }
    let publishedSnapshot = false;
    if (this.#lastPublishedVersion === undefined || Number(version) > Number(this.#lastPublishedVersion)) {
      this.#lastPublishedVersion = version;
      publishedSnapshot = true;
      this.#bus.emit({
        kind: "snapshot",
        snapshot,
        runtimeEpoch: snapshot.runtimeEpoch,
        stateVersion: version,
      });
    }
    if (publishedSnapshot) {
      const pending = snapshot.pendingInteraction;
      if (pending?.owner === "gui") {
        const requestId = this.#runtimeSession()?.requestIdForCommandId?.(pending.request.commandId) as CommandRequestId | undefined;
        const mapped = mapRemoteInteractionToClient(
          pending.request,
          snapshot.sessionId as SessionId,
          pending.leaseGeneration,
          requestId,
        );
        if (mapped !== undefined) {
          this.#bus.emit({
            kind: "interaction.required",
            runtimeEpoch: snapshot.runtimeEpoch,
            stateVersion: version,
            interaction: mapped,
          });
        }
      }
    }
    for (const entry of publication.terminalOutcomes) {
      this.#emitLedgerReceipt(entry);
    }
  }

  #bindConversation(): void {
    const runtime = this.#options.runtime;
    if (runtime === undefined) {
      return;
    }
    if (runtime.onConversationEvent !== undefined) {
      this.#unsubscribeConversation = runtime.onConversationEvent((event) => this.#onConversationForward(event));
      if (runtime.onConversationResync !== undefined) {
        this.#unsubscribeConversationResync = runtime.onConversationResync((reason) => this.#onConversationResync(reason));
      }
      return;
    }
    const session = this.#runtimeSession();
    if (session === undefined) {
      return;
    }
    this.#unsubscribeConversation = session.onConversationEvent((event) => this.#onConversationForward(event));
    this.#unsubscribeConversationResync = session.onConversationResync((reason) => this.#onConversationResync(reason));
  }

  #bindTelemetry(): void {
    const runtime = this.#options.runtime;
    if (runtime === undefined) return;
    if (runtime.onTelemetryEvent !== undefined) {
      this.#unsubscribeTelemetry = runtime.onTelemetryEvent((event) => this.#onTelemetryForward(event));
      return;
    }
    const session = this.#runtimeSession();
    if (session?.onTelemetryEvent !== undefined) {
      this.#unsubscribeTelemetry = session.onTelemetryEvent((event) => this.#onTelemetryForward(event));
    }
  }

  #onTelemetryForward(forward: StudioTelemetryForward): void {
    this.#syncRuntimeEvents();
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) return;
    const envelope = forward.envelope;
    if (envelope.runtimeEpoch !== snapshot.runtimeEpoch) return;
    const event = envelope.event;
    if (event.sessionId !== snapshot.sessionId || event.telemetry.sessionId !== snapshot.sessionId) return;
    this.#bus.emit({
      kind: "telemetry.changed",
      runtimeEpoch: envelope.runtimeEpoch,
      stateVersion: envelope.stateVersion,
      occurredAt: envelope.occurredAt,
      sessionId: event.sessionId as SessionId,
      telemetry: event.telemetry,
    });
  }

  #bindInteraction(): void {
    const runtime = this.#options.runtime;
    if (runtime?.onInteractionEvent === undefined) {
      return;
    }
    this.#unsubscribeInteraction = runtime.onInteractionEvent((event) => this.#onInteractionForward(event));
  }

  #onInteractionForward(forward: StudioInteractionForward): void {
    this.#syncRuntimeEvents();
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) {
      return;
    }
    const envelope = forward.envelope;
    if (envelope.runtimeEpoch !== snapshot.runtimeEpoch) {
      return;
    }
    const event = envelope.event;
    if (event.kind === "interaction.resolved") {
      this.#bus.emit({
        kind: "interaction.resolved",
        runtimeEpoch: envelope.runtimeEpoch,
        stateVersion: envelope.stateVersion,
        occurredAt: envelope.occurredAt,
        interactionId: event.interactionId,
        leaseGeneration: event.leaseGeneration,
        outcome: event.outcome,
      });
      return;
    }
    if (event.owner === "tui") {
      this.#recordConversationDiagnostic("A terminal-owned interaction is pending; handle it in the TUI");
      return;
    }
    const requestId = forward.clientRequestId as CommandRequestId | undefined;
    const mapped = mapRemoteInteractionToClient(
      event.request,
      snapshot.sessionId as SessionId,
      event.leaseGeneration,
      requestId,
    );
    if (mapped === undefined) {
      this.#recordConversationDiagnostic("Dropped an interaction with an unsupported kind");
      return;
    }
    this.#bus.emit({
      kind: "interaction.required",
      runtimeEpoch: envelope.runtimeEpoch,
      stateVersion: envelope.stateVersion,
      occurredAt: envelope.occurredAt,
      interaction: mapped,
    });
  }

  #runtimeSession() {
    return this.#options.runtime?.currentSession?.() ?? this.#options.runtime?.session;
  }

  #onConversationResync(reason: string): void {
    this.#syncRuntimeEvents();
    this.#bus.emit({ kind: "resync.required", reason });
  }

  #onConversationForward(forward: StudioConversationForward): void {
    this.#syncRuntimeEvents();
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) {
      return;
    }
    const envelope = forward.envelope;
    if (envelope.runtimeEpoch !== snapshot.runtimeEpoch) {
      return;
    }
    let update;
    try {
      update = parseConversationRuntimeEvent(envelope.event);
    } catch {
      this.#recordConversationDiagnostic("Dropped a malformed conversation event; transcript resync is required");
      this.#bus.emit({
        kind: "resync.required",
        reason: "conversation mapping failed; re-query session.transcript.read",
      });
      return;
    }
    if (update.sessionId !== snapshot.sessionId) {
      return;
    }
    this.#bus.emit({
      kind: "conversation.changed",
      runtimeEpoch: envelope.runtimeEpoch,
      stateVersion: envelope.stateVersion,
      occurredAt: envelope.occurredAt,
      sessionId: update.sessionId as SessionId,
      eventSeq: Number(envelope.eventSeq),
      update,
    });
  }

  #recordConversationDiagnostic(message: string): void {
    this.#conversationDiagnostics.push({
      entryId: this.#options.diagnostics.newEntryId(),
      scope: "runtime",
      level: "warning",
      message,
      occurredAt: this.#options.diagnostics.now(),
    });
    if (this.#conversationDiagnostics.length > 8) {
      this.#conversationDiagnostics.shift();
    }
    this.#bus.emit({ kind: "diagnostics.changed" });
  }

  /**
   * Mirror Host ledger terminal outcomes (runtime loss, runtime-driven
   * failures) as client receipts for commands this facade issued. Only
   * statuses that need no result payload are mapped; `completed` results
   * arrive through the facade-driven command path.
   */
  #emitLedgerReceipt(entry: CommandLedgerEntry): void {
    const requestId = entry.requestId as CommandRequestId;
    if (this.#terminalEmitted.has(requestId)) {
      return;
    }
    const registration = this.#registry.getByRequestId(requestId);
    if (registration === undefined) {
      return;
    }
    const receipt = receiptFromLedgerEntry(entry, registration.commandName, this.#options.diagnostics.now());
    if (receipt === undefined) {
      return;
    }
    this.#terminalEmitted.add(requestId);
    this.#registry.recordTerminal(requestId, receipt);
    this.#bus.emit({ kind: "command.receipt", receipt, runtimeEpoch: entry.runtimeEpoch });
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  async #queryEnvironment(): Promise<EnvironmentReadModel> {
    const installed = await this.#currentInstalledManifest();
    return {
      platform: this.#options.platform,
      arch: this.#options.arch,
      authority: { ...this.#options.authority },
      runtime: this.#currentConnection(),
      installer: this.#installState(installed),
    };
  }

  async #queryCapabilities(): Promise<CapabilityManifest> {
    return this.#resolveManifest(this.#options.capabilityManifest, () =>
      neutralCapabilityManifest(this.#options.diagnostics.now()),
    );
  }

  async #queryCommandManifest(): Promise<OperatorCommandManifest> {
    return this.#resolveManifest(this.#options.commandManifest, () =>
      neutralCommandManifest(this.#options.diagnostics.now()),
    );
  }

  async #queryDiagnostics(): Promise<DiagnosticReadModel> {
    const now = this.#options.diagnostics.now();
    const connection = this.#currentConnection();
    const installed = await this.#currentInstalledManifest();
    const entries: DiagnosticEntry[] = [];
    if (installed === undefined) {
      entries.push({
        entryId: this.#options.diagnostics.newEntryId(),
        scope: "installer",
        level: "warning",
        message: "No trusted Runtime is installed",
        occurredAt: now,
      });
    } else {
      entries.push({
        entryId: this.#options.diagnostics.newEntryId(),
        scope: "installer",
        level: "info",
        message: "Trusted Runtime is installed",
        detail: { version: installed.manifest.runtimeVersion },
        occurredAt: now,
      });
    }
    switch (connection.status) {
      case "unavailable":
        entries.push({
          entryId: this.#options.diagnostics.newEntryId(),
          scope: "host",
          level: "warning",
          message: "Runtime is not available",
          occurredAt: now,
        });
        break;
      case "connecting":
        entries.push({
          entryId: this.#options.diagnostics.newEntryId(),
          scope: "host",
          level: "info",
          message: "Runtime is connecting",
          occurredAt: now,
        });
        break;
      case "disconnected":
        entries.push({
          entryId: this.#options.diagnostics.newEntryId(),
          scope: "host",
          level: "error",
          message: "Runtime connection was lost",
          occurredAt: now,
        });
        break;
      case "connected":
        entries.push({
          entryId: this.#options.diagnostics.newEntryId(),
          scope: "runtime",
          level: "info",
          message: "Runtime is connected",
          detail: {
            runtimeEpoch: Number(connection.runtimeEpoch),
            ...(connection.runtimeVersion === undefined ? {} : { runtimeVersion: connection.runtimeVersion }),
            ...(connection.upstreamVersion === undefined ? {} : { upstreamVersion: connection.upstreamVersion }),
          },
          occurredAt: now,
        });
        break;
    }
    entries.push(...this.#conversationDiagnostics);
    return buildDiagnosticsReadModel(now, { ...this.#options.authority }, entries);
  }

  async #queryHistory(input: { readonly limit?: number }): Promise<SessionHistoryReadModel> {
    const requested = input.limit ?? HISTORY_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(requested) || requested < 1) {
      throw clientError("INVALID_ARGUMENT", "history limit must be a positive integer");
    }
    const limit = Math.min(requested, HISTORY_MAX_LIMIT);
    const catalog = await this.#options.catalog.list();
    const sorted = [...catalog].sort(
      (left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.sessionId.localeCompare(right.sessionId),
    );
    const entries = sorted.map((entry) => this.#mapHistoryEntry(entry));
    return { entries: entries.slice(0, limit), total: entries.length };
  }

  #mapHistoryEntry(entry: HostCatalogEntry): SessionHistoryEntry {
    const title = sanitizeDisplayText(entry.title, 120) ?? "Untitled session";
    const summary = sanitizeDisplayText(entry.summary, 200);
    // Boundary: the catalog's opaque session identity becomes the client
    // SessionId brand; the id itself is never a path.
    const sessionId = entry.sessionId as SessionId;
    return {
      historyId: historyIdFor(entry.sessionId),
      threadId: threadIdFor(entry.sessionId),
      environmentId: environmentIdFor(this.#options.authority.authorityId),
      ...(entry.sessionId.length === 0 ? {} : { sessionId }),
      title,
      ...(summary === undefined ? {} : { summary }),
      startedAt: entry.createdAt ?? entry.modifiedAt,
      lastActiveAt: entry.modifiedAt,
      messageCount: entry.messageCount,
      status: entry.status,
    };
  }

  #querySessionState(): OperatorStateSnapshot {
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) {
      throw unavailableError("session.state requires a Runtime snapshot");
    }
    return snapshot;
  }

  async #queryHome(): Promise<HomeReadModel> {
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) {
      throw unavailableError("home.get requires a Runtime snapshot");
    }
    const catalog = await this.#options.catalog.list();
    const recentThreads = [...catalog]
      .sort(
        (left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.sessionId.localeCompare(right.sessionId),
      )
      .slice(0, HOME_RECENT_THREADS)
      .map((entry) => ({
        threadId: threadIdFor(entry.sessionId),
        title: sanitizeDisplayText(entry.title, 120) ?? "Untitled session",
        lastActiveAt: entry.modifiedAt,
      }));
    const workspaces = this.#options.workspaces;
    const recentWorkspaces =
      workspaces === undefined ? undefined : (await workspaces.list()).workspaces.slice(0, HOME_RECENT_WORKSPACES);
    return {
      authority: { ...this.#options.authority },
      runtime: this.#currentConnection(),
      snapshot,
      recentThreads,
      ...(recentWorkspaces === undefined ? {} : { recentWorkspaces }),
    };
  }

  async #queryProjects(): Promise<WorkspaceListReadModel> {
    const service = this.#options.workspaces;
    if (service === undefined) {
      return { workspaces: [] };
    }
    const model = await service.list();
    this.#lastWorkspaceModel = model;
    return model;
  }

  async #queryUsage(): Promise<TokenUsageReadModel> {
    const service = this.#options.usage;
    if (service === undefined) {
      return {
        generatedAt: this.#options.diagnostics.now(),
        days: [],
        models: [],
        byModel: [],
        hours: [],
        unavailableReason: "Host 未接入用量适配器。",
      };
    }
    return service.get();
  }

  async #queryTranscript(input: {
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): Promise<ConversationTranscriptPage> {
    const snapshot = this.#currentSnapshot();
    if (snapshot === undefined) {
      throw unavailableError("session.transcript.read requires a connected Runtime");
    }
    const reader = this.#options.runtime?.readTranscript;
    const session = this.#runtimeSession();
    if (reader === undefined && session === undefined) {
      throw unavailableError("session.transcript.read requires a connected Runtime");
    }
    const raw = reader === undefined ? await session!.readTranscript(input) : await reader(input);
    let page: ConversationTranscriptPage;
    try {
      page = parseConversationTranscriptPage(raw);
    } catch (error) {
      throw clientError(
        "INTERNAL_ERROR",
        error instanceof Error ? error.message : "malformed transcript page",
      );
    }
    const current = this.#currentSnapshot();
    if (current === undefined) {
      throw unavailableError("session.transcript.read requires a connected Runtime");
    }
    if (page.runtimeEpoch !== current.runtimeEpoch) {
      throw clientError("STALE_EPOCH", "transcript page runtime epoch does not match the current session");
    }
    if (page.sessionId !== current.sessionId) {
      throw clientError("CURSOR_STALE", "transcript page session does not match the current session");
    }
    return page;
  }

  async #queryArchiveTranscript(input: {
    readonly sessionId: SessionId;
    readonly cursor?: OpaqueCursor;
    readonly limit?: number;
  }): Promise<ConversationTranscriptReadPage> {
    const archive = this.#options.archive;
    if (archive === undefined) {
      throw unavailableError("session.transcript.readPage is not available");
    }
    try {
      return await archive.readPage(input);
    } catch (error) {
      throw toClientError(error);
    }
  }

  async #querySkills(): Promise<ExtensibilityReadModel> {
    const service = this.#options.extensibility;
    if (service === undefined) {
      return {
        skills: [],
        plugins: [],
        warnings: [],
        generatedAt: this.#options.diagnostics.now(),
        unavailableReason: "Host 未接入技能 / 插件适配器。",
      };
    }
    return service.get();
  }

  async #queryMcp(): Promise<McpReadModel> {
    const service = this.#options.mcp;
    if (service === undefined) {
      return {
        servers: [],
        warnings: [],
        generatedAt: this.#options.diagnostics.now(),
        unavailableReason: "Host 未接入 MCP 适配器。",
      };
    }
    return service.get();
  }

  async #queryAgentDefinitions(): Promise<AgentDefinitionsReadModel> {
    const service = this.#options.agentDefinitions;
    if (service === undefined) {
      return {
        agents: [],
        warnings: [],
        builtinToolNames: [],
        roleAliases: [],
        projectScopeAvailable: false,
        generatedAt: this.#options.diagnostics.now(),
        unavailableReason: "Host 未接入子代理定义适配器。",
      };
    }
    return service.get();
  }

  async #queryModels(): Promise<ModelConfigReadModel> {
    const service = this.#options.models;
    if (service === undefined) {
      return {
        providers: [],
        presets: [],
        roles: [],
        cycleOrder: [],
        availableModels: [],
        loginProviders: [],
        generatedModelsYml: "providers: {}\n",
        generatedConfigYml: "modelRoles: {}\n",
        runtimeEffectHint: "Host 未接入模型配置适配器。",
        loginAvailable: false,
        ompAvailable: false,
        unavailableReason: "Host 未接入模型配置适配器。",
        modelRoleStorage: "global",
        projectScopeAvailable: false,
        modelProviderOrder: [],
        fallbackChains: {},
        fallbackRevertPolicy: "cooldown-expiry",
      };
    }
    return service.get();
  }

  async #currentInstalledManifest(): Promise<{ readonly manifest: RuntimeInstallationManifest } | undefined> {
    try {
      return await this.#options.backend.installer.currentManifest();
    } catch {
      return undefined;
    }
  }

  #installState(installed: { readonly manifest: RuntimeInstallationManifest } | undefined): RuntimeInstallState {
    if (this.#installInFlight) {
      return { status: "installing", signature: "unknown" };
    }
    // The install service is the Host's authoritative install path: its
    // latest report is fresher than the persisted manifest snapshot.
    if (this.#lastInstallResult !== undefined) {
      return this.#lastInstallResult;
    }
    if (installed !== undefined) {
      return { status: "installed", version: installed.manifest.runtimeVersion, signature: "verified" };
    }
    return { status: "not-installed", signature: "unknown" };
  }

  // ------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------

  async #commandInstall(request: ClientCommandRequest<"runtime.install">): Promise<ClientCommandAccepted<"runtime.install">> {
    validateEnvelope(request);
    const channel = request.input.channel;
    if (channel !== undefined && channel !== "stable" && channel !== "canary") {
      throw clientError("INVALID_ARGUMENT", "runtime.install channel must be 'stable' or 'canary'");
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: "runtime.install", requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted: ClientCommandAccepted<"runtime.install"> = {
      commandName: "runtime.install",
      requestId: request.requestId,
      status: "accepted",
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runInstall(channel, request.requestId);
    return accepted;
  }

  async #commandResume(request: ClientCommandRequest<"session.resume">): Promise<ClientCommandAccepted<"session.resume">> {
    return this.#commandSemantic(request, "session.resume");
  }

  async #commandCreate(request: ClientCommandRequest<"session.create">): Promise<ClientCommandAccepted<"session.create">> {
    return this.#commandSemantic(request, "session.create");
  }

  async #commandDrop(request: ClientCommandRequest<"session.drop">): Promise<ClientCommandAccepted<"session.drop">> {
    return this.#commandSemantic(request, "session.drop");
  }

  async #commandRespond(request: ClientCommandRequest<"interaction.respond">): Promise<ClientCommandAccepted<"interaction.respond">> {
    return this.#commandSemantic(request, "interaction.respond");
  }

  /**
   * `permissions.mode.set`: session-exclusive approval mode sync (plan §5.4).
   * Requires a live Runtime snapshot and the injected semantic service;
   * streaming / pending-interaction rejection happens in the desktop
   * service. The receipt carries the sync statistics — never a fabricated
   * "complete".
   */
  async #commandSetApprovalMode(
    request: ClientCommandRequest<"permissions.mode.set">,
  ): Promise<ClientCommandAccepted<"permissions.mode.set">> {
    validateEnvelope(request);
    const service = this.#options.commands;
    if (service?.setApprovalMode === undefined) {
      throw clientError(
        "CAPABILITY_UNAVAILABLE",
        "permissions.mode.set is not available: no semantic command service is wired",
      );
    }
    if (this.#currentSnapshot() === undefined) {
      throw unavailableError("permissions.mode.set requires a Runtime snapshot");
    }
    const mode = request.input.mode;
    if (mode !== "always-ask" && mode !== "write" && mode !== "yolo") {
      throw clientError("INVALID_ARGUMENT", "permissions.mode.set mode must be always-ask, write or yolo");
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: "permissions.mode.set", requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted: ClientCommandAccepted<"permissions.mode.set"> = {
      commandName: "permissions.mode.set",
      requestId: request.requestId,
      status: "accepted",
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runSetApprovalMode(() => service.setApprovalMode!({ mode }), request.requestId);
    return accepted;
  }

  async #runSetApprovalMode(
    run: () =>
      | {
          readonly mode: "always-ask" | "write" | "yolo";
          readonly syncStatus: "complete" | "partial";
          readonly appliedSessions: number;
          readonly failedSessions: number;
        }
      | Promise<{
          readonly mode: "always-ask" | "write" | "yolo";
          readonly syncStatus: "complete" | "partial";
          readonly appliedSessions: number;
          readonly failedSessions: number;
        }>,
    requestId: CommandRequestId,
  ): Promise<void> {
    try {
      const result = await run();
      this.#emitTerminal(requestId, {
        requestId,
        commandName: "permissions.mode.set",
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(requestId, {
        requestId,
        commandName: "permissions.mode.set",
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  async #commandModels(
    request: ClientCommandRequest<ModelsCommandName>,
  ): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.models;
    if (service === undefined) {
      throw clientError("CAPABILITY_UNAVAILABLE", `${request.commandName} is not available: no models adapter is wired`);
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted = {
      commandName: request.commandName,
      requestId: request.requestId,
      status: "accepted" as const,
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runModelsCommand(request, service);
    return accepted;
  }

  async #runModelsCommand(
    request: ClientCommandRequest<ModelsCommandName>,
    service: HostModelsService,
  ): Promise<void> {
    try {
      let result: ConfigWriteResult | ModelProviderTestResult | ModelDiscoveryResult;
      switch (request.commandName) {
        case "models.provider.upsert":
          result = await service.upsertProvider(request.input as never);
          break;
        case "models.provider.delete":
          result = await service.deleteProvider(request.input as { readonly id: string; readonly expectedHash?: string });
          break;
        case "models.provider.setEnabled":
          result = await service.setProviderEnabled(request.input as never);
          break;
        case "models.roles.set":
          result = await service.setRole(request.input as { readonly roleId: string; readonly selector: string });
          break;
        case "models.roles.write":
          result = await service.writeRoles(request.input as never);
          break;
        case "models.roles.create":
          result = await service.createRole(request.input as never);
          break;
        case "models.roles.delete":
          result = await service.deleteRole(request.input as { readonly roleId: string });
          break;
        case "models.roleStorage.set":
          result = await service.setRoleStorage(request.input as { readonly storage: "global" | "project" });
          break;
        case "models.fallback.set":
          result = await service.setFallback(request.input as never);
          break;
        case "models.providerOrder.set":
          result = await service.setProviderOrder(request.input as { readonly order: ReadonlyArray<string> });
          break;
        case "models.yml.write":
          result = await service.writeModelsYml(request.input as never);
          break;
        case "models.login.start":
          result = await service.startLogin(request.input as { readonly providerId: string });
          break;
        case "models.login.logout":
          result = await service.logout(request.input as { readonly providerId: string });
          break;
        case "models.provider.test":
          result = await service.testProvider(request.input as { readonly providerId?: string; readonly api?: string; readonly endpointUrl?: string; readonly apiKey?: string });
          break;
        case "models.provider.probe":
          result = await service.probeProvider(request.input as never);
          break;
        case "models.discovery.refresh":
          result = await service.refreshDiscovery();
          break;
        case "models.cycleOrder.set":
          result = await service.setCycleOrder(request.input as { readonly order: ReadonlyArray<string> });
          break;
      }
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  /**
   * Shared gate for the whole-package/whole-skill toggles: an explicit
   * injected extensibility service is required before anything is accepted;
   * a missing seam fails closed with CAPABILITY_UNAVAILABLE and no fake
   * completion is ever published. Like `models.*`, these are Host-owned
   * disk mutations and never require a Runtime snapshot.
   */
  async #commandExtensibility(
    request: ClientCommandRequest<"plugins.setEnabled" | "skills.setEnabled">,
  ): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.extensibility;
    if (service?.setEnabled === undefined || service.setSkillEnabled === undefined) {
      throw clientError("CAPABILITY_UNAVAILABLE", `${request.commandName} is not available: no extensibility adapter is wired`);
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt } as ClientCommandAccepted;
    }
    const accepted = {
      commandName: request.commandName,
      requestId: request.requestId,
      status: "accepted" as const,
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runExtensibilityCommand(request, service);
    return accepted;
  }

  async #runExtensibilityCommand(
    request: ClientCommandRequest<"plugins.setEnabled" | "skills.setEnabled">,
    service: HostExtensibilityService,
  ): Promise<void> {
    try {
      const result =
        request.commandName === "plugins.setEnabled"
          ? await service.setEnabled(request.input as never)
          : await service.setSkillEnabled(request.input as never);
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  /**
   * MCP enable/disable: Host-owned mcp.json mutation; no Runtime required.
   */
  async #commandMcp(request: ClientCommandRequest<"mcp.setEnabled">): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.mcp;
    if (service === undefined) {
      throw clientError("CAPABILITY_UNAVAILABLE", "mcp.setEnabled is not available: no MCP adapter is wired");
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt } as ClientCommandAccepted;
    }
    const accepted = {
      commandName: request.commandName,
      requestId: request.requestId,
      status: "accepted" as const,
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runMcpCommand(request, service);
    return accepted;
  }

  async #runMcpCommand(request: ClientCommandRequest<"mcp.setEnabled">, service: HostMcpService): Promise<void> {
    try {
      const result = await service.setEnabled(request.input);
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  /**
   * Shared gate for task-agent definition mutations: an explicit injected
   * service is required before anything is accepted; a missing seam fails
   * closed with CAPABILITY_UNAVAILABLE. These are Host-owned disk writes
   * and never require a Runtime snapshot.
   */
  async #commandAgentDefinitions(
    request: ClientCommandRequest<AgentDefinitionsCommandName>,
  ): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.agentDefinitions;
    if (service === undefined) {
      throw clientError(
        "CAPABILITY_UNAVAILABLE",
        `${request.commandName} is not available: no agent-definitions adapter is wired`,
      );
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt } as ClientCommandAccepted;
    }
    const accepted = {
      commandName: request.commandName,
      requestId: request.requestId,
      status: "accepted" as const,
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runAgentDefinitionsCommand(request, service);
    return accepted;
  }

  async #runAgentDefinitionsCommand(
    request: ClientCommandRequest<AgentDefinitionsCommandName>,
    service: HostAgentDefinitionsService,
  ): Promise<void> {
    try {
      let result: ConfigWriteResult;
      switch (request.commandName) {
        case "agents.definition.upsert":
          result = await service.upsert(request.input as never);
          break;
        case "agents.definition.delete":
          result = await service.delete(request.input as never);
          break;
        case "agents.definition.configure":
          result = await service.configure(request.input as never);
          break;
      }
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  /**
   * Shared gate for the two workspace commands: an explicit injected
   * service is required before anything is accepted; a missing seam fails
   * closed with CAPABILITY_UNAVAILABLE and no fake completion is published.
   * User cancellation of `workspace.pick` surfaces as a failed receipt,
   * never as a fabricated success.
   */
  async #commandWorkspace(
    request: ClientCommandRequest<"workspace.open" | "workspace.pick">,
  ): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.workspaces;
    if (service === undefined) {
      throw clientError(
        "CAPABILITY_UNAVAILABLE",
        `${request.commandName} is not available: no workspaces adapter is wired`,
      );
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted = {
      commandName: request.commandName,
      requestId: request.requestId,
      status: "accepted" as const,
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runWorkspaceCommand(request, service);
    return accepted;
  }

  async #commandWorkspaceFile(
    request: ClientCommandRequest<"workspace.file.create" | "workspace.directory.create">,
  ): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.workspaceFiles;
    if (service === undefined) {
      throw clientError("CAPABILITY_UNAVAILABLE", `${request.commandName} is not available: no workspace file adapter is wired`);
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted = { commandName: request.commandName, requestId: request.requestId, status: "accepted" as const, acceptedAt };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runWorkspaceFileCommand(request, service);
    return accepted;
  }

  async #runWorkspaceFileCommand(
    request: ClientCommandRequest<"workspace.file.create" | "workspace.directory.create">,
    service: HostWorkspaceFileService,
  ): Promise<void> {
    try {
      const input = request.input as { readonly workspaceId: WorkspaceId; readonly path: string };
      const result: WorkspaceFileMutationResult = request.commandName === "workspace.file.create"
        ? await service.createFile(input)
        : await service.createDirectory(input);
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  async #runWorkspaceCommand(
    request: ClientCommandRequest<"workspace.open" | "workspace.pick">,
    service: HostWorkspaceService,
  ): Promise<void> {
    try {
      const result =
        request.commandName === "workspace.open"
          ? await service.open(request.input as { readonly workspaceId: WorkspaceId })
          : await service.pick(request.input as { readonly name?: string });
      this.#lastWorkspaceModel = result;
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  async #commandUsage(request: ClientCommandRequest<"usage.openDashboard">): Promise<ClientCommandAccepted> {
    validateEnvelope(request);
    const service = this.#options.usage;
    if (service === undefined) {
      throw clientError(
        "CAPABILITY_UNAVAILABLE",
        `${request.commandName} is not available: no usage adapter is wired`,
      );
    }
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName: request.commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted = {
      commandName: request.commandName,
      requestId: request.requestId,
      status: "accepted" as const,
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    void this.#runUsageCommand(request, service);
    return accepted;
  }

  async #runUsageCommand(
    request: ClientCommandRequest<"usage.openDashboard">,
    service: HostUsageService,
  ): Promise<void> {
    try {
      const result = await service.openDashboard();
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    } catch (error) {
      this.#emitTerminal(request.requestId, {
        requestId: request.requestId,
        commandName: request.commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      } as CommandReceipt);
    }
  }

  /**
   * Shared gate for the semantic session/interaction commands: an explicit injected
   * service is required before anything is accepted. `session.drop` and
   * `interaction.respond` also need a live Runtime snapshot.
   * `session.create` / `session.resume` must not: they start or rebind a
   * Runtime even when no snapshot exists yet.
   * Missing pieces fail closed with CAPABILITY_UNAVAILABLE / UNAVAILABLE
   * and no fake completion is ever published.
   */
  async #commandSemantic<TName extends "session.create" | "session.resume" | "session.drop" | "interaction.respond">(
    request: ClientCommandRequest<TName>,
    commandName: TName,
  ): Promise<ClientCommandAccepted<TName>> {
    validateEnvelope(request);
    const service = this.#options.commands;
    if (service === undefined) {
      throw clientError("CAPABILITY_UNAVAILABLE", `${commandName} is not available: no semantic command service is wired`);
    }
    if (commandName === "session.create" && service.create === undefined) {
      throw clientError("CAPABILITY_UNAVAILABLE", "session.create is not available");
    }
    if (commandName !== "session.create" && commandName !== "session.resume" && this.#currentSnapshot() === undefined) {
      throw unavailableError(`${commandName} requires a Runtime snapshot`);
    }
    this.#validateSemanticInput(commandName, request.input);
    const acceptedAt = this.#options.diagnostics.now();
    const replay = this.#registry.accept(request, acceptedAt);
    if (replay !== undefined) {
      this.#replayTerminal(replay, request.requestId);
      return { commandName, requestId: request.requestId, status: "accepted", acceptedAt: replay.acceptedAt };
    }
    const accepted: ClientCommandAccepted<TName> = {
      commandName,
      requestId: request.requestId,
      status: "accepted",
      acceptedAt,
    };
    this.#bus.emit({ kind: "command.accepted", accepted });
    const input = request.input;
    switch (commandName) {
      case "session.create":
        void this.#runSemanticCommand(() => service.create!(), request.requestId, commandName);
        break;
      case "session.resume":
      case "session.drop": {
        // Re-narrow with the same guard used for validation so the typed
        // fields become readable (TS cannot narrow CommandInput<TName>).
        if (!isThreadCommandInput(input)) {
          throw clientError("INVALID_ARGUMENT", `${commandName} threadId must not be empty`);
        }
        const threadId = input.threadId;
        if (commandName === "session.resume") {
          void this.#runSemanticCommand(() => service.resume({ threadId }), request.requestId, commandName);
        } else {
          void this.#runSemanticCommand(
            () => service.drop({ threadId, requestId: request.requestId }),
            request.requestId,
            commandName,
          );
        }
        break;
      }
      case "interaction.respond": {
        if (!isInteractionCommandInput(input)) {
          throw clientError("INVALID_ARGUMENT", "interaction.respond interactionId/decision are invalid");
        }
        const interactionId = input.interactionId;
        const leaseGeneration = input.leaseGeneration;
        const decision = input.decision;
        void this.#runSemanticCommand(
          () =>
            service.respond({
              interactionId,
              leaseGeneration,
              decision,
              ...(input.value === undefined ? {} : { value: input.value }),
            }),
          request.requestId,
          commandName,
        );
        break;
      }
    }
    return accepted;
  }

  #validateSemanticInput(
    commandName: "session.create" | "session.resume" | "session.drop" | "interaction.respond",
    input: unknown,
  ): void {
    if (commandName === "session.create") {
      if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 0) {
        throw clientError("INVALID_ARGUMENT", "session.create input must be empty");
      }
      return;
    }
    if (commandName === "session.resume" || commandName === "session.drop") {
      if (!isThreadCommandInput(input)) {
        throw clientError("INVALID_ARGUMENT", `${commandName} threadId must not be empty`);
      }
      return;
    }
    if (!isInteractionCommandInput(input)) {
      throw clientError("INVALID_ARGUMENT", "interaction.respond interactionId/decision are invalid");
    }
    validateInteractionValue(input.value);
  }

  async #runInstall(channel: RuntimeChannel | undefined, requestId: CommandRequestId): Promise<void> {
    this.#installInFlight = true;
    try {
      const state = await this.#options.install(channel);
      const result = { ...state };
      this.#lastInstallResult = result;
      this.#emitTerminal(requestId, {
        requestId,
        commandName: "runtime.install",
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      });
    } catch (error) {
      const err = toClientError(error);
      this.#lastInstallResult = { status: "failed", signature: "unknown", message: err.message };
      this.#emitTerminal(requestId, {
        requestId,
        commandName: "runtime.install",
        status: "failed",
        error: err,
        observedAt: this.#options.diagnostics.now(),
      });
    } finally {
      this.#installInFlight = false;
    }
  }

  async #runSemanticCommand(
    run: () => OperatorStateSnapshot | Promise<OperatorStateSnapshot>,
    requestId: CommandRequestId,
    commandName: "session.create" | "session.resume" | "session.drop" | "interaction.respond",
  ): Promise<void> {
    try {
      const result = await run();
      this.#emitTerminal(requestId, {
        requestId,
        commandName,
        status: "completed",
        result,
        observedAt: this.#options.diagnostics.now(),
      });
    } catch (error) {
      this.#emitTerminal(requestId, {
        requestId,
        commandName,
        status: "failed",
        error: toClientError(error),
        observedAt: this.#options.diagnostics.now(),
      });
    }
  }

  /** Publish a terminal receipt exactly once per requestId. */
  #emitTerminal(requestId: CommandRequestId, receipt: CommandReceipt): void {
    if (this.#terminalEmitted.has(requestId)) {
      return;
    }
    this.#terminalEmitted.add(requestId);
    this.#registry.recordTerminal(requestId, receipt);
    this.#bus.emit({ kind: "command.receipt", receipt });
  }

  /** Replay a stored terminal receipt under the caller's new correlation id. */
  #replayTerminal(entry: RegistryEntry, requestId: CommandRequestId): void {
    const terminal = entry.terminal;
    if (terminal === undefined) {
      return;
    }
    const receipt: CommandReceipt = { ...terminal, requestId };
    this.#bus.emit({ kind: "command.receipt", receipt });
  }
}
