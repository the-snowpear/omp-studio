/**
 * Desktop Host composition (FRONTEND_INTEGRATION.md §9.2).
 *
 * Testable, Electron-free orchestration that brings the Host up in the
 * exact P1 order:
 *
 *   current-user profile/state directory (injected PlatformPort)
 *     -> Win32AuthorityLock acquisition (before any HostBackend use)
 *     -> current-user-only private endpoint (Win32PrivateEndpoint)
 *     -> HostBackend construction + initialize
 *     -> managed Runtime resolution (injected resolver environment/probe)
 *     -> optional StudioRuntimeSessionController, created ONLY after a
 *        trusted resolution
 *     -> sender-bound StudioHostClientFacade (ClientTransport)
 *
 * Trusted resolution means a live-verified full-parity runtime
 * (`managed` or `compatible-system` per the resolver's probe evidence).
 * Rejected, limited, unavailable or not-ready runtimes never execute: the
 * composition fails closed to a read-only facade whose bootstrap reports
 * `runtime.status: "unavailable"` without snapshot keys and never claims a
 * fake ready state.
 *
 * A second owner fails closed: when the injected authority lock reports an
 * already-live owner, `createDesktopHostComposition` rejects and no second
 * lock, endpoint, backend or runtime is ever created.
 *
 * `reload()` re-binds a fresh client session over the SAME Host, authority
 * lease, endpoint and Runtime session — a renderer reload never stops the
 * Runtime. `shutdown()` orders facade client-session close -> Runtime
 * graceful stop (only when this composition started one) -> endpoint
 * release -> authority lease release; any failure stops the chain (fail
 * closed) and never releases a lease this composition does not own.
 *
 * Secrets policy: only opaque identities and the ClientTransport cross
 * this module's public surface. No Bridge token, endpoint, process
 * handle/PID or executable/session path ever reaches the facade or the
 * renderer contract.
 */

import type {
  ArchId,
  AuthorityEpoch,
  AuthorityId,
  ClientTransport,
  ConversationTranscriptReadPage,
  PublicAuthorityIdentity,
  ResidentsReadModel,
  PlatformId,
} from "@omp-studio/client-contract";
import {
  createDefaultHostDiagnosticsFactory,
  StudioHostClientFacade,
  redactText,
  threadIdFor,
  type HostAgentDefinitionsService,
  type HostDiagnosticsFactory,
  type HostExtensibilityService,
  type HostGitHubService,
  type HostGitService,
  type HostMcpService,
  type HostManifestProvider,
  type HostModelsService,
  type HostRuntimeAccess,
  type HostRuntimeDisconnect,
  type HostRuntimeHelloView,
  type HostRuntimeUnavailable,
  type HostRuntimeInstallProbe,
  type HostRuntimeInstallService,
  type HostResidentsService,
  type HostSemanticCommandService,
  type HostSessionCatalogProvider,
  type HostSessionArchiveProvider,
  type HostSessionTelemetryProbePort,
  type HostSessionTelemetryStorePort,
  type HostUsageService,
  type HostWorkspaceService,
  type HostWorkspaceFileService,
  type StudioHostClientFacadeOptions,
} from "@omp-studio/host-client-api";
import { createOmpAgentDefinitionsService } from "@omp-studio/host-client-api/agent-definitions";
import { createOmpExtensibilityService } from "@omp-studio/host-client-api/extensibility";
import { createOmpMcpService } from "@omp-studio/host-client-api/mcp";
import { createOmpModelsService } from "@omp-studio/host-client-api/models";
import { createOmpUsageService } from "@omp-studio/host-client-api/usage";
import type { PlatformPort, PrivateEndpoint } from "@omp-studio/platform";
import {
  HostBackend,
  type HostBackendOptions,
  createNodeSessionTelemetryProbe,
  createPathLocator,
  type RuntimePublication,
  type RuntimeResolution,
  type RuntimeResolverEnvironment,
  SessionTelemetryStore,
  type StudioBtwForward,
  type StudioConversationForward,
  type StudioTelemetryForward,
  type StudioRuntimeSessionController,
  StudioSessionArchiveReader,
  StudioSessionArchiveService,
  StudioSessionDeleteService,
  FileSessionLeaseStore,
  defaultOmpAgentDir,
  type SessionArchiveReadInput,
  type SessionPersistedAgentRecord,
} from "@omp-studio/studio-host";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ApprovalMode,
  CapabilityManifest,
  CommandLedgerEntry,
  OperatorCommandManifest,
  RuntimePreference,
  StudioAgentSnapshot,
} from "@omp-studio/studio-protocol";

import { DesktopInteractionHost, IsolatedForwarder } from "./interaction-host.js";
import {
  createDesktopRuntimeInstallProbe,
  createDesktopRuntimeInstallService,
  createManagedArtifactLocator,
  defaultRuntimeKeysDirectory,
  loadInstallerTrustedKeys,
  resolveManagedRuntimeInstallDirectory,
  seedManagedRuntimeFromArtifact,
  type DesktopManagedInstallOptions,
} from "./runtime-install.js";
import { createDesktopSemanticCommands, createWorkspaceSessionCatalog } from "./session-commands.js";
import type { DesktopHostComposition, DesktopRuntimeStatus } from "./types.js";

/** Default Runtime resolution preference for the P1 managed slice. */
const DEFAULT_RUNTIME_PREFERENCE: RuntimePreference = { kind: "managed" };

/** Opaque authority lease; structurally satisfied by Win32AuthorityLock's lease. */
export interface DesktopAuthorityLease {
  readonly authorityId: string;
  readonly epoch: string;
  release(): Promise<void>;
}

/** Injected single-owner lock port; structurally satisfied by Win32AuthorityLock. */
export interface DesktopAuthorityLock {
  acquire(): Promise<DesktopAuthorityLease>;
}

/** Opaque private-endpoint lease; structurally satisfied by Win32PrivateEndpoint's lease. */
export interface DesktopEndpointLease {
  readonly endpoint: PrivateEndpoint;
  release(): Promise<void>;
}

/** Injected current-user-only endpoint port; structurally satisfied by Win32PrivateEndpoint. */
export interface DesktopPrivateEndpoint {
  createCurrentUserOnly(profileDirectory: string): Promise<DesktopEndpointLease>;
}

/** Ready Runtime session bundle produced only after a trusted resolution. */
export interface DesktopRuntimeSession {
  readonly controller: StudioRuntimeSessionController;
  /** Safe current hello; `undefined` once the Runtime is lost. */
  hello(): HostRuntimeHelloView | undefined;
  /** Subscribe to publication advances (Bridge projection changes). */
  onPublication(listener: (publication: RuntimePublication) => void): () => void;
  /** Authenticated hello capability manifest; `undefined` when disconnected or fail-closed. */
  capabilityManifest(): CapabilityManifest | undefined;
  /** Hash-verified operator command manifest; `undefined` when disconnected or fail-closed. */
  commandManifest(): OperatorCommandManifest | undefined;
}

/** Internal Main-process change payload for the residents read model. */
export interface DesktopResidentsChange extends ResidentsReadModel {
  /** Background terminal outcomes use a Main-only side channel. Never attach
   * a background snapshot/publication to the current client projection. */
  readonly terminalOutcomes?: ReadonlyArray<CommandLedgerEntry>;
}

/** Context handed to the runtime session port after a trusted resolution. */
export interface DesktopRuntimeSessionContext {
  readonly resolution: RuntimeResolution;
  readonly endpoint: PrivateEndpoint;
  readonly profileDirectory: string;
  /**
   * Managed Runtime tree used to spawn `omp.exe`. Packaged: `$INSTDIR\runtime`.
   * Unpackaged / tests: `%APPDATA%\omp-studio\runtimes` (or the temp profile).
   */
  readonly runtimeInstallDirectory: string;
  /** Installer trust material, so the launch path can verify what it resolves. */
  readonly installer?: HostBackendOptions["installer"];
  /** Persisted or newly selected workspace; absent means honest read-only. */
  readonly workspace?: { workspaceId: string; cwd: string };
}

/**
 * Injectable Runtime start/stop port. The production implementation
 * (Main/native composition) spawns the trusted executable, performs the
 * Bridge bootstrap/handshake and wires the session controller; tests
 * substitute fakes so no untrusted file is ever executed.
 */
export interface DesktopRuntimeSessionPort {
  /** True when switching the active view keeps sibling Runtime Workers resident. */
  readonly supportsConcurrentSessions?: boolean;
  /**
   * Starts (or connects to) the trusted Runtime and returns a ready
   * session bundle, or `undefined` when the Runtime is not ready. Called
   * at most once per composition.
   */
  start(context: DesktopRuntimeSessionContext): Promise<DesktopRuntimeSession | undefined>;
  /** Gracefully stops the Runtime if this port started one; no-op otherwise. */
  stop(): Promise<void>;
  /** Stop idle workers for an installation, then restore their sessions using
   * the activated executable. Serialized with all other lifecycle changes. */
  withRuntimeMaintenance?<T>(operation: () => Promise<T>, expectedVersion?: () => string | undefined,
    refreshContext?: () => Promise<DesktopRuntimeSessionContext>,
    recoverPrevious?: () => Promise<string | undefined>): Promise<T>;
  /**
   * Optional workspace rebind: select a Worker for the given workspace and,
   * unless `launchIfMissing` is false, spawn one when absent. Returns its
   * session bundle (`undefined` for a deliberate read-only bind or when the
   * Runtime is unavailable). Workers of other workspaces stay resident. The
   * composition rebuilds the facade's runtime access from the returned bundle.
   * Never changes the `start` contract: startup still happens at most once.
   */
  rebind?(
    workspace: { workspaceId: string; cwd: string },
    options?: { readonly launchIfMissing?: boolean },
  ): Promise<DesktopRuntimeSession | undefined>;
  /**
   * True when a live Worker already holds this workspace, i.e. a rebind to it
   * is a binding switch rather than a Runtime restart. Ports without a
   * resident pool omit this and every rebind counts as a restart.
   */
  hasResidentForWorkspace?(workspaceId: string): boolean;
  /** Current authority-level resident projection (safe, path-free facts). */
  listResidents?(): ResidentsReadModel;
  /**
   * Subscribe to resident projection changes. The returned disposer is
   * required so a composition reload/close cannot retain Host listeners.
   */
  attachResidentsSink?(listener: (change: DesktopResidentsChange) => void): () => void;
  /**
   * Stop the current Runtime and launch it against another session file
   * (`resume`) or a fresh process (`fresh`). Increments the Runtime epoch.
   * On launch failure the port restores the previous session when possible.
   */
  switchSession?(intent: { kind: "resume"; sessionId: string } | { kind: "fresh" }): Promise<DesktopRuntimeSession | undefined>;
  /**
   * Apply the tool approval mode across resident Runtimes (plan §5.3): the
   * active Runtime persists the mode to the OMP global configuration, every
   * sibling resident Runtime receives a non-persistent override. Returns
   * per-session statistics; failures surface as `syncStatus: "partial"`
   * and are re-applied on the next activate/rebind.
   */
  applyApprovalMode?(mode: ApprovalMode): Promise<{
    mode: ApprovalMode;
    syncStatus: "complete" | "partial";
    appliedSessions: number;
    failedSessions: number;
  }>;
  /** True when a Runtime Worker currently holds this session file. */
  isResident?(sessionId: string): boolean;
  /**
   * Abort a streaming turn if needed, stop that Worker, and launch a
   * replacement when it was the active view. Background residents are
   * stopped without changing the active binding.
   */
  evacuateResident?(sessionId: string): Promise<{
    readonly found: boolean;
    readonly active?: DesktopRuntimeSession;
  }>;
  /**
   * Last skip/fail reason when `start`/`rebind` returned `undefined` or
   * threw. Cleared after a ready session. Pre-redacted; never a path.
   */
  lastUnavailable?(): HostRuntimeUnavailable | undefined;
  /**
   * Last observed drop after a ready hello. Cleared after a ready session.
   */
  lastDisconnect?(): HostRuntimeDisconnect | undefined;
  /**
   * Start or restart under the current workspace. No-op when already
   * connected unless `force` is true. Used by diagnostics `runtime.ensure`
   * and session recovery.
   */
  ensure?(input?: { force?: boolean }): Promise<DesktopRuntimeSession | undefined>;
  /**
   * Composition binds here so an automatic relaunch can replace the live
   * session holder without a user command.
   */
  attachSessionSink?(listener: (session: DesktopRuntimeSession | undefined) => void): void;
  /**
   * Composition binds here so selecting a Worker of another project moves the
   * Host's active workspace with it: cwd-derived reads (session catalog,
   * archive, models / MCP scope) must agree with the bound Session.
   */
  attachWorkspaceSink?(listener: (workspace: { workspaceId: string; cwd: string }) => void): () => void;
}

/** Facade seam providers; every optional slot fails closed when absent. */
export interface DesktopFacadeSeams {
  readonly capabilityManifest?: HostManifestProvider<CapabilityManifest>;
  readonly commandManifest?: HostManifestProvider<OperatorCommandManifest>;
  readonly catalog?: HostSessionCatalogProvider;
  /** Optional authority-level resident Runtime projection. */
  readonly residents?: HostResidentsService;
  readonly archive?: HostSessionArchiveProvider;
  /** Overrides the persisted "last observed" telemetry store (tests). */
  readonly telemetryStore?: HostSessionTelemetryStorePort;
  /** Overrides the one-shot archived-session telemetry probe (tests). */
  readonly telemetryProbe?: HostSessionTelemetryProbePort;
  /** Optional Host log for coarse probe diagnostics (no paths or session ids). */
  readonly hostLog?: { write(level: "info" | "warn" | "error", event: string, detail?: string): void };
  readonly diagnostics?: HostDiagnosticsFactory;
  readonly install?: HostRuntimeInstallService;
  readonly installProbe?: HostRuntimeInstallProbe;
  readonly commands?: HostSemanticCommandService;
  readonly models?: HostModelsService;
  readonly extensibility?: HostExtensibilityService;
  readonly mcp?: HostMcpService;
  readonly agentDefinitions?: HostAgentDefinitionsService;
  readonly getWorkspaceCwd?: () => string | undefined;
  readonly workspaces?: HostWorkspaceService;
  readonly workspaceFiles?: HostWorkspaceFileService;
  readonly git?: HostGitService;
  readonly github?: HostGitHubService;
  readonly usage?: HostUsageService;
  readonly openUrl?: (url: string) => Promise<void>;
  /** Main-injected Explorer open for Host-owned skill directories. */
  readonly revealDirectory?: (absDir: string) => Promise<void>;
  /** Active workspace for Runtime start; never falls back to process.cwd(). */
  readonly getActiveWorkspace?: () => { workspaceId: string; cwd: string } | undefined;
  /** Stops Host-owned Git/gh child processes during final app shutdown. */
  readonly disposeHostOperations?: () => void;
}

/** Inputs for {@link createDesktopHostComposition}; every port is explicit. */
export interface DesktopCompositionOptions {
  /** Platform port; `appDataDirectory()` is the profile/state directory. */
  readonly platform: PlatformPort;
  /** Authority lock acquired before HostBackend is created or used. */
  readonly authorityLock: DesktopAuthorityLock;
  /** Current-user-only private endpoint creator. */
  readonly privateEndpoint: DesktopPrivateEndpoint;
  /** Optional Runtime start/stop port; absent means read-only is the only outcome. */
  readonly runtimeSession?: DesktopRuntimeSessionPort;
  /** Resolver environment injected into HostBackend (probe included); the managed lookup stays HostBackend-owned. */
  readonly resolver?: Omit<RuntimeResolverEnvironment, "managedLookup">;
  /** Runtime resolution preference; defaults to `{ kind: "managed" }`. */
  readonly preference?: RuntimePreference;
  /** Client-visible arch; defaults from the running process. */
  readonly arch?: ArchId;
  /** Installer trusted keys; required for `runtime.install` signature verification. */
  readonly installer?: HostBackendOptions["installer"];
  /**
   * When set, composition wires a real `runtime.install` service that
   * copies a local signed artifact into the managed Runtime tree
   * (`installDirectory`, or `%APPDATA%\omp-studio\runtimes`).
   * Absent means the command stays fail-closed (`not wired`).
   */
  readonly managedInstall?: DesktopManagedInstallOptions;
  /** Facade seam providers; absent slots fail closed. */
  readonly facade?: DesktopFacadeSeams;
}

/**
 * The authority lease's epoch is an opaque string; the client contract
 * needs a numeric brand that is stable for one authority generation and
 * different across generations. FNV-1a over the opaque epoch gives a
 * deterministic positive integer with both properties.
 */
function authorityEpochFromOpaque(opaque: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < opaque.length; index += 1) {
    hash ^= opaque.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 2_147_483_647) + 1;
}

function authorityIdentityFromLease(lease: DesktopAuthorityLease): PublicAuthorityIdentity {
  return {
    authorityId: lease.authorityId as AuthorityId,
    authorityEpoch: authorityEpochFromOpaque(lease.epoch) as AuthorityEpoch,
  };
}

function unavailableFromError(error: unknown): HostRuntimeUnavailable {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const reason = redactText(message);
  if (/handshake timed out/iu.test(message)) return { code: "handshake-timeout", reason };
  if (/exited before ready/iu.test(message)) return { code: "exited-before-ready", reason };
  if (/ENOENT/u.test(message)) return { code: "spawn-failed", reason };
  return { code: "launch-failed", reason };
}

function classificationUnavailable(resolution: RuntimeResolution): HostRuntimeUnavailable {
  if (resolution.classification === "limited-system") {
    return {
      code: "resolution-limited",
      reason: redactText(resolution.rejectionReason ?? "limited runtime was not started"),
    };
  }
  return {
    code: "resolution-rejected",
    reason: redactText(resolution.rejectionReason ?? "runtime was not accepted"),
  };
}

function rememberUnavailable(
  holder: { current: HostRuntimeUnavailable | undefined },
  session: DesktopRuntimeSession | undefined,
  port: DesktopRuntimeSessionPort | undefined,
  fallback?: HostRuntimeUnavailable,
): void {
  if (session !== undefined) {
    holder.current = undefined;
    return;
  }
  holder.current = port?.lastUnavailable?.() ?? fallback ?? holder.current;
}

function rememberDisconnect(
  holder: { current: HostRuntimeDisconnect | undefined },
  port: DesktopRuntimeSessionPort | undefined,
  fallback?: HostRuntimeDisconnect,
): void {
  holder.current = port?.lastDisconnect?.() ?? fallback ?? holder.current;
}

function clearDisconnect(holder: { current: HostRuntimeDisconnect | undefined }): void {
  holder.current = undefined;
}

interface FacadeContext {
  readonly authority: PublicAuthorityIdentity;
  readonly platform: PlatformId;
  readonly arch: ArchId;
  readonly backend: HostBackend;
  readonly seams: DesktopFacadeSeams;
  /** Live session-bundle holder; the facade's runtime access reads it. */
  readonly sessionRef: { current: DesktopRuntimeSession | undefined };
  /** Last skip/fail reason while no Runtime hello exists. */
  readonly lastUnavailable: { current: HostRuntimeUnavailable | undefined };
  /** Last drop reason after a Runtime hello was observed. */
  readonly lastDisconnect: { current: HostRuntimeDisconnect | undefined };
  /** Single publication channel; Facade subscribe and session attach share it. */
  readonly publications: DesktopPublicationForwarder;
  /** Authority-level resident projection and change fan-out. */
  readonly residents: IsolatedForwarder<DesktopResidentsChange>;
  /** Background terminal ledger outcomes; never publishes snapshots. */
  readonly residentTerminalOutcomes: IsolatedForwarder<ReadonlyArray<CommandLedgerEntry>>;
  readonly conversationEvents: IsolatedForwarder<StudioConversationForward>;
  readonly telemetryEvents: IsolatedForwarder<StudioTelemetryForward>;
  readonly btwEvents: IsolatedForwarder<StudioBtwForward>;
  readonly conversationResync: IsolatedForwarder<string>;
  readonly interaction: DesktopInteractionHost;
  readonly bindSession: { current: (session: DesktopRuntimeSession | undefined) => void };
  readonly runtimeSession: DesktopRuntimeSessionPort | undefined;
  /** Active workspace cwd for project-scoped disk adapters. */
  readonly workspaceCwd: { current: string | undefined };
  readonly profileDirectory: string;
  readonly runtimeInstallDirectory: string;
  readonly endpoint: PrivateEndpoint;
  readonly managedInstall?: DesktopManagedInstallOptions;
  readonly hasTrustedKey: boolean;
  /**
   * Trust material for the managed installer, forwarded to the launch path so
   * the `HostBackend` it builds verifies the installed manifest with the same
   * keys the composition installer uses. Without it that backend would resolve
   * an unverifiable installation.
   */
  readonly installerOptions?: HostBackendOptions["installer"];
}

/** Fan-out for the current Runtime bundle's publication stream. */
export interface SessionPublicationForwarder {
  subscribe(listener: (publication: RuntimePublication) => void): () => void;
}

/**
 * One publication channel for the composition lifetime. Facade subscribe,
 * session attach replay, reload replay and rebind all use this object.
 * Listener exceptions are isolated so a UI consumer cannot break Bridge
 * socket handling or sibling subscribers.
 */
class DesktopPublicationForwarder implements SessionPublicationForwarder {
  readonly #listeners = new Set<(publication: RuntimePublication) => void>();

  subscribe(listener: (publication: RuntimePublication) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  publish(publication: RuntimePublication): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(publication);
      } catch {
        // Isolate consumer failures from the Runtime publication path.
      }
    }
  }
}

async function ensureInstalledRuntime(
  context: FacadeContext,
  input?: { force?: boolean },
): Promise<DesktopRuntimeSession | undefined> {
  const port = context.runtimeSession;
  if (port?.ensure !== undefined) {
    try {
      const next = await port.ensure(input);
      rememberUnavailable(
        context.lastUnavailable,
        next,
        port,
        unavailableFromError(new Error("Runtime did not become ready")),
      );
      if (next !== undefined) {
        clearDisconnect(context.lastDisconnect);
        context.bindSession.current(next);
        return next;
      }
      rememberDisconnect(context.lastDisconnect, port);
      if (context.sessionRef.current !== undefined || port.lastUnavailable?.()?.code === "no-workspace") {
        return undefined;
      }
    } catch (error) {
      rememberUnavailable(context.lastUnavailable, undefined, port, unavailableFromError(error));
      rememberDisconnect(context.lastDisconnect, port);
      throw error;
    }
  }
  return startInstalledRuntime(context);
}

async function installedRuntimeContext(context: FacadeContext): Promise<DesktopRuntimeSessionContext> {
  const resolution: RuntimeResolution = await context.backend.resolve({ kind: "managed" });
  context.seams.hostLog?.write(
    resolution.classification === "managed" ? "info" : "warn",
    "runtime.resolve",
    `classification=${resolution.classification}${resolution.rejectionReason === undefined ? "" : ` reason=${resolution.rejectionReason}`}`,
  );
  if (resolution.classification !== "managed") {
    rememberUnavailable(context.lastUnavailable, undefined, undefined, classificationUnavailable(resolution));
    throw new Error(resolution.rejectionReason ?? "Installed Runtime was not accepted as managed");
  }
  const workspace = context.seams.getActiveWorkspace?.();
  return {
    resolution,
    endpoint: context.endpoint,
    profileDirectory: context.profileDirectory,
    runtimeInstallDirectory: context.runtimeInstallDirectory,
    ...(context.installerOptions === undefined ? {} : { installer: context.installerOptions }),
    ...(workspace === undefined ? {} : { workspace }),
  };
}

async function startInstalledRuntime(context: FacadeContext): Promise<DesktopRuntimeSession | undefined> {
  const launchContext = await installedRuntimeContext(context);
  const port = context.runtimeSession;
  if (port === undefined) {
    rememberUnavailable(context.lastUnavailable, undefined, undefined, {
      code: "not-wired",
      reason: "runtime session port is not wired",
    });
    return undefined;
  }
  const workspace = context.seams.getActiveWorkspace?.();
  if (context.sessionRef.current !== undefined && port.rebind !== undefined && workspace !== undefined) {
    const rebound = await port.rebind(workspace);
    rememberUnavailable(
      context.lastUnavailable,
      rebound,
      port,
      unavailableFromError(new Error("Runtime did not become ready")),
    );
    if (rebound !== undefined) {
      context.bindSession.current(rebound);
      return rebound;
    }
  }
  const next = await port.start(launchContext);
  rememberUnavailable(
    context.lastUnavailable,
    next,
    port,
    workspace === undefined
      ? { code: "no-workspace", reason: "no workspace is selected" }
      : unavailableFromError(new Error("Runtime did not become ready")),
  );
  if (next !== undefined) {
    context.bindSession.current(next);
  }
  return next;
}

function toPersistedStudioAgent(record: SessionPersistedAgentRecord): StudioAgentSnapshot {
  return {
    agentId: record.agentId as StudioAgentSnapshot["agentId"],
    generation: 1 as StudioAgentSnapshot["generation"],
    ...(record.parentAgentId === undefined
      ? {}
      : { parentAgentId: record.parentAgentId as StudioAgentSnapshot["parentAgentId"] }),
    kind: "sub",
    displayName: record.displayName,
    status: record.status,
    ...(record.assignment === undefined ? {} : { assignment: record.assignment }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    updatedAt: record.updatedAt,
    hasLiveSession: false,
    hasTranscript: record.hasTranscript,
    unreadCount: 0,
    activeJobIds: [],
    ...(record.usage === undefined ? {} : { usage: { ...record.usage } }),
    ...(record.modelRole === undefined ? {} : { modelRole: record.modelRole }),
    ...(record.resolvedModel === undefined ? {} : { resolvedModel: record.resolvedModel }),
  };
}

function managedRuntimeInstallService(context: FacadeContext): HostRuntimeInstallService {
  if (context.managedInstall === undefined) {
    return async () => { throw new Error("no runtime install service is wired; runtime.install is not available"); };
  }
  const managed = context.managedInstall;
  const maintenance = context.runtimeSession?.withRuntimeMaintenance;
  const install = createDesktopRuntimeInstallService({
    backend: context.backend,
    platform: `${context.platform}-${context.arch}`,
    hasTrustedKey: context.hasTrustedKey,
    ...(managed.pendingArtifact === undefined ? {} : { pendingArtifact: managed.pendingArtifact }),
    locateArtifact: createManagedArtifactLocator(managed),
    ...(managed.activateOptions === undefined ? {} : { activateOptions: managed.activateOptions }),
    ...(maintenance === undefined ? {} : { installOptions: { allowReferencedRepair: true } }),
    afterActivate: managed.afterActivate ?? (maintenance === undefined
      ? async () => {
          const next = await startInstalledRuntime(context);
          if (next === undefined && context.seams.getActiveWorkspace?.() !== undefined) {
            throw new Error("Runtime did not become ready after installation");
          }
        }
      : async () => undefined),
  });
  if (maintenance === undefined) return install;
  return async (channel) => {
    let version: string | undefined;
    let previousVersion: string | undefined;
    const result = await maintenance(async () => {
      previousVersion = (await context.backend.installer.current())?.runtimeVersion;
      const result = await install(channel);
      if (result.status === "failed") throw new Error(result.message ?? "Runtime installation failed");
      version = result.version;
      return result;
    }, () => version, () => installedRuntimeContext(context), async () => {
      if (previousVersion === undefined || previousVersion === version) throw new Error("No distinct previous Runtime is available for recovery");
      await context.backend.activate(previousVersion, managed.activateOptions);
      return previousVersion;
    });
    // A first installation may start from a port that never received its
    // launch context because no managed executable existed at bootstrap.
    if (context.sessionRef.current?.hello() === undefined && context.seams.getActiveWorkspace?.() !== undefined) {
      const next = await startInstalledRuntime(context);
      if (next?.hello()?.runtimeVersion !== version) throw new Error("Installed Runtime did not become ready with the expected version");
    }
    return result;
  };
}

function buildFacade(context: FacadeContext): StudioHostClientFacade {
  const seams = context.seams;
  const sessionRef = context.sessionRef;
  const catalog = seams.catalog ?? createWorkspaceSessionCatalog(() => context.workspaceCwd.current);
  const residents: HostResidentsService = seams.residents ?? {
    list: () =>
      context.runtimeSession?.listResidents?.() ?? {
        residents: [],
        generatedAt: new Date().toISOString(),
      },
    onChanged: (listener) => context.residents.subscribe(listener),
    onTerminalOutcomes: (listener) => context.residentTerminalOutcomes.subscribe(listener),
  };
  let archiveCwd: string | undefined;
  let archiveReader: StudioSessionArchiveReader | undefined;
  const currentArchiveReader = (): StudioSessionArchiveReader => {
    const cwd = context.workspaceCwd.current;
    if (cwd === undefined) throw new Error("Persistent transcript requires an active workspace");
    if (archiveReader === undefined || archiveCwd !== cwd) {
      archiveCwd = cwd;
      archiveReader = new StudioSessionArchiveReader({ allowedCwd: cwd });
    }
    return archiveReader;
  };
  let archiveServiceCwd: string | undefined;
  let archiveService: StudioSessionArchiveService | undefined;
  const currentArchiveService = (): StudioSessionArchiveService => {
    const cwd = context.workspaceCwd.current;
    if (cwd === undefined) throw new Error("Session archive requires an active workspace");
    if (archiveService === undefined || archiveServiceCwd !== cwd) {
      archiveServiceCwd = cwd;
      // The default crash-writer grace stays on: a dormant session written
      // moments ago may come from a crashed writer whose tail must not be
      // frozen into the cold archive. Sessions the desktop itself just
      // evacuated skip it explicitly via skipWriteGrace.
      archiveService = new StudioSessionArchiveService({
        allowedCwd: cwd,
        isResident: (sessionId) =>
          context.runtimeSession?.isResident?.(sessionId) === true
          || sessionRef.current?.controller.publication()?.snapshot?.sessionId === sessionId,
      });
    }
    return archiveService;
  };
  let deleteServiceCwd: string | undefined;
  let deleteService: StudioSessionDeleteService | undefined;
  const currentDeleteService = (): StudioSessionDeleteService => {
    const cwd = context.workspaceCwd.current;
    if (cwd === undefined) throw new Error("Session deletion requires an active workspace");
    if (deleteService === undefined || deleteServiceCwd !== cwd) {
      deleteServiceCwd = cwd;
      deleteService = new StudioSessionDeleteService({
        allowedCwd: cwd,
        isResident: (sessionId) =>
          context.runtimeSession?.isResident?.(sessionId) === true
          || sessionRef.current?.controller.publication()?.snapshot?.sessionId === sessionId,
      });
    }
    return deleteService;
  };
  // Durable single-writer lease store mirrors the one created in runtime-session.ts.
  const sessionLeaseCleanup = new FileSessionLeaseStore({
    directory: join(context.profileDirectory, "broker", "session-leases"),
  });
  const archive = seams.archive ?? {
    readPage: async (input: {
      readonly sessionId: string;
      readonly agentId?: string;
      readonly cursor?: string;
      readonly limit?: number;
    }) => {
      const page = await currentArchiveReader().readPage(input as unknown as SessionArchiveReadInput);
      return page as unknown as ConversationTranscriptReadPage;
    },
    listPersistedAgents: async (sessionId: string) =>
      (await currentArchiveReader().listPersistedAgents(sessionId)).map(toPersistedStudioAgent),
    readRevision: async (sessionId: string) => await currentArchiveReader().readRevision(sessionId),
    createProbeCopy: async (sessionId: string, destinationDirectory: string) =>
      await currentArchiveReader().createProbeCopy(sessionId, destinationDirectory),
  } satisfies HostSessionArchiveProvider;
  // Archived-session telemetry: persisted "last observed" records plus the
  // one-shot OMP probe. The probe scratch dir lives under the Host profile.
  const telemetryStore =
    seams.telemetryStore ??
    new SessionTelemetryStore({
      rootDirectory: join(context.profileDirectory, "session-telemetry", "v1"),
      resolveRevision: async (sessionId) => {
        if (context.workspaceCwd.current === undefined) return undefined;
        try {
          return (await currentArchiveReader().readRevision(sessionId)).transcriptRevision;
        } catch {
          return undefined;
        }
      },
    });
  const probeExecutable = async (): Promise<string | undefined> => {
    const installed = await context.backend.installer.currentManifest().catch(() => undefined);
    if (installed !== undefined && installed.entrypointPath.length > 0) return installed.entrypointPath;
    return await createPathLocator().locate(context.platform, context.arch);
  };
  const telemetryProbe =
    seams.telemetryProbe ??
    createNodeSessionTelemetryProbe({
      executablePath: probeExecutable,
      ...(seams.hostLog === undefined
        ? {}
        : {
            onDiagnostic: (info) => {
              seams.hostLog?.write(
                info.result === "ok" ? "info" : "warn",
                "telemetry.probe",
                JSON.stringify(info),
              );
            },
          }),
    });
  const telemetryProbeWorkspace = {
    create: async (): Promise<string> => {
      await mkdir(join(context.profileDirectory, "tmp"), { recursive: true });
      return await mkdtemp(join(context.profileDirectory, "tmp", "telemetry-probe-"));
    },
    remove: async (path: string): Promise<void> => {
      await rm(path, { recursive: true, force: true }).catch(() => {});
    },
  };
  const runtimeCommandService =
    seams.commands ??
    createDesktopSemanticCommands({
      sessionRef,
      catalog,
      resolveResidentSessionId: (threadId) => {
        const residents = context.runtimeSession?.listResidents?.().residents;
        if (residents !== undefined) {
          const match = residents.find((r) => threadIdFor(r.sessionId) === threadId);
          if (match !== undefined) return match.sessionId;
        }
        return undefined;
      },
      archive: currentArchiveService,
      deleteService: currentDeleteService,
      telemetryStore: () => telemetryStore,
      bindings: context.backend.bindings,
      leaseStore: sessionLeaseCleanup,
      agentDir: () => defaultOmpAgentDir(),
      ...(context.runtimeSession?.switchSession === undefined
        ? {}
        : { switchSession: (intent) => context.runtimeSession!.switchSession!(intent) }),
      ...(context.runtimeSession?.applyApprovalMode === undefined
        ? {}
        : { applyApprovalMode: (mode) => context.runtimeSession!.applyApprovalMode!(mode) }),
      ...(context.runtimeSession?.evacuateResident === undefined
        ? {}
        : { evacuateResident: (sessionId) => context.runtimeSession!.evacuateResident!(sessionId) }),
      supportsConcurrentSessions: context.runtimeSession?.supportsConcurrentSessions === true,
      bindSession: (session) => context.bindSession.current(session),
      interaction: context.interaction,
      ensureRuntime: () => ensureInstalledRuntime(context),
      runtimeMissing: () => {
        const unavailable = context.lastUnavailable.current;
        const disconnect = context.lastDisconnect.current ?? context.runtimeSession?.lastDisconnect?.();
        return {
          ...(unavailable === undefined ? {} : { unavailable }),
          ...(disconnect === undefined ? {} : { disconnect }),
        };
      },
    });
  const options: StudioHostClientFacadeOptions = {
    authority: context.authority,
    platform: context.platform,
    arch: context.arch,
    backend: context.backend,
    capabilityManifest: seams.capabilityManifest ?? (() => sessionRef.current?.capabilityManifest()),
    commandManifest: seams.commandManifest ?? (() => sessionRef.current?.commandManifest()),
    catalog,
    residents,
    archive,
    telemetryStore,
    telemetryProbe,
    telemetryProbeWorkspace,
    workspaceCwd: () => context.workspaceCwd.current,
    diagnostics: seams.diagnostics ?? createDefaultHostDiagnosticsFactory(),
    install: seams.install ?? managedRuntimeInstallService(context),
    ...(seams.installProbe !== undefined
      ? { installProbe: seams.installProbe }
      : context.managedInstall === undefined
        ? {}
        : {
            installProbe: createDesktopRuntimeInstallProbe({
              backend: context.backend,
              platform: `${context.platform}-${context.arch}`,
              locateArtifact: createManagedArtifactLocator(context.managedInstall),
            }),
          }),
    commands: runtimeCommandService,
    models:
      seams.models ??
      createOmpModelsService({
        ...(seams.openUrl === undefined ? {} : { openUrl: seams.openUrl }),
        getCwd: () => seams.getWorkspaceCwd?.() ?? context.workspaceCwd.current,
      }),
    extensibility:
      seams.extensibility ??
      createOmpExtensibilityService({
        getCwd: () => seams.getWorkspaceCwd?.() ?? context.workspaceCwd.current,
        ...(seams.revealDirectory === undefined ? {} : { revealDirectory: seams.revealDirectory }),
      }),
    mcp:
      seams.mcp ??
      createOmpMcpService({
        getCwd: () => seams.getWorkspaceCwd?.() ?? context.workspaceCwd.current,
      }),
    agentDefinitions:
      seams.agentDefinitions ??
      createOmpAgentDefinitionsService({
        getCwd: () => seams.getWorkspaceCwd?.() ?? context.workspaceCwd.current,
      }),
    ...(seams.workspaces === undefined ? {} : { workspaces: seams.workspaces }),
    ...(seams.workspaceFiles === undefined ? {} : { workspaceFiles: seams.workspaceFiles }),
    ...(seams.git === undefined ? {} : { git: seams.git }),
    ...(seams.github === undefined ? {} : { github: seams.github }),
    usage: seams.usage ?? createOmpUsageService(seams.openUrl === undefined ? {} : { openUrl: seams.openUrl }),
    // Live accessors follow workspace/runtime rebind. Conversation and
    // interaction events are not buffered; reload never replays old deltas.
    runtime: {
      currentSession: () => sessionRef.current?.controller,
      hello: () => sessionRef.current?.hello(),
      unavailable: () => context.lastUnavailable.current,
      disconnect: () => context.lastDisconnect.current ?? context.runtimeSession?.lastDisconnect?.(),
      ensure: async (input) => {
        await ensureInstalledRuntime(context, input);
      },
      snapshot: () => sessionRef.current?.controller.publication()?.snapshot,
      messagesCursor: () => sessionRef.current?.controller.messagesCursor?.(),
      onPublication: (listener) => context.publications.subscribe(listener),
      onConversationEvent: (listener) => context.conversationEvents.subscribe(listener),
      onConversationResync: (listener) => context.conversationResync.subscribe(listener),
      onTelemetryEvent: (listener) => context.telemetryEvents.subscribe(listener),
      onBtwEvent: (listener) => context.btwEvents.subscribe(listener),
      onInteractionEvent: (listener) => context.interaction.subscribe(listener),
    } satisfies HostRuntimeAccess,
  };
  return new StudioHostClientFacade(options);
}

function assertCompositionOptions(options: DesktopCompositionOptions): void {
  if (options.platform === null || typeof options.platform !== "object" || typeof options.platform.appDataDirectory !== "function") {
    throw new TypeError("desktop composition platform port is required");
  }
  if (options.authorityLock === null || typeof options.authorityLock !== "object" || typeof options.authorityLock.acquire !== "function") {
    throw new TypeError("desktop composition authority lock is required");
  }
  if (
    options.privateEndpoint === null ||
    typeof options.privateEndpoint !== "object" ||
    typeof options.privateEndpoint.createCurrentUserOnly !== "function"
  ) {
    throw new TypeError("desktop composition private endpoint is required");
  }
  const session = options.runtimeSession;
  if (session !== undefined && (typeof session.start !== "function" || typeof session.stop !== "function")) {
    throw new TypeError("desktop composition runtime session port must provide start and stop");
  }
  const arch = options.arch;
  if (arch !== undefined && arch !== "x64" && arch !== "arm64") {
    throw new TypeError("desktop composition arch must be 'x64' or 'arm64'");
  }
  const preference = options.preference;
  if (
    preference !== undefined &&
    (preference === null || typeof preference !== "object" || !("kind" in preference) || typeof preference.kind !== "string")
  ) {
    throw new TypeError("desktop composition runtime preference is invalid");
  }
}

class DesktopHostCompositionImpl implements DesktopHostComposition {
  #facade: StudioHostClientFacade;
  #status: DesktopRuntimeStatus;
  #facadeContext: FacadeContext;
  readonly #lease: DesktopAuthorityLease;
  readonly #endpointLease: DesktopEndpointLease;
  readonly #runtimeSession: DesktopRuntimeSessionPort | undefined;
  readonly #unsubscribeResidents: (() => void) | undefined;
  readonly #unsubscribeWorkspace: (() => void) | undefined;
  #sessionStarted: boolean;
  readonly #sessionRef: { current: DesktopRuntimeSession | undefined };
  #unsubscribeCurrentPublication: (() => void) | undefined;
  #unsubscribeConversation: (() => void) | undefined;
  #unsubscribeConversationResync: (() => void) | undefined;
  #unsubscribeTelemetry: (() => void) | undefined;
  #unsubscribeBtw: (() => void) | undefined;
  #closed = false;
  #shutdownStarted = false;

  constructor(options: {
    readonly facade: StudioHostClientFacade;
    readonly status: DesktopRuntimeStatus;
    readonly facadeContext: FacadeContext;
    readonly lease: DesktopAuthorityLease;
    readonly endpointLease: DesktopEndpointLease;
    readonly runtimeSession: DesktopRuntimeSessionPort | undefined;
    readonly sessionStarted: boolean;
  }) {
    this.#facade = options.facade;
    this.#status = options.status;
    this.#facadeContext = options.facadeContext;
    this.#lease = options.lease;
    this.#endpointLease = options.endpointLease;
    this.#runtimeSession = options.runtimeSession;
    this.#unsubscribeResidents = this.#runtimeSession?.attachResidentsSink?.((change) => {
      const { terminalOutcomes, ...residents } = change;
      this.#facadeContext.residents.publish(residents);
      if (terminalOutcomes !== undefined && terminalOutcomes.length > 0) {
        this.#facadeContext.residentTerminalOutcomes.publish(terminalOutcomes);
      }
    });
    this.#sessionStarted = options.sessionStarted;
    this.#sessionRef = options.facadeContext.sessionRef;
    this.#facadeContext.bindSession.current = (session) => {
      this.#sessionRef.current = session;
      this.#sessionStarted = this.#sessionStarted || session !== undefined;
      this.#status = session === undefined ? "read-only" : "ready";
      rememberUnavailable(this.#facadeContext.lastUnavailable, session, this.#runtimeSession);
      if (session !== undefined) {
        clearDisconnect(this.#facadeContext.lastDisconnect);
      } else {
        rememberDisconnect(this.#facadeContext.lastDisconnect, this.#runtimeSession);
      }
      this.#attachSession(session, true);
    };
    this.#runtimeSession?.attachSessionSink?.((session) => {
      this.#facadeContext.bindSession.current(session);
    });
    this.#unsubscribeWorkspace = this.#runtimeSession?.attachWorkspaceSink?.((workspace) => {
      this.#facadeContext.workspaceCwd.current = workspace.cwd;
    });
    const residents = this.#runtimeSession?.listResidents?.();
    if (residents !== undefined) {
      this.#facadeContext.residents.publish(residents);
    }
    this.#attachSession(this.#sessionRef.current);
  }

  get facade(): StudioHostClientFacade {
    return this.#facade;
  }

  get transport(): ClientTransport {
    return this.#facade;
  }

  get status(): DesktopRuntimeStatus {
    return this.#status;
  }

  /**
   * Residents read model is authoritative when available (same convention
   * as the renderer thread badges); fall back to the current session
   * snapshot when the port has no broker view.
   */
  isBusy(): boolean {
    if (this.#facade.runtimeInstallInProgress) return true;
    const residents = this.#runtimeSession?.listResidents?.().residents;
    if (residents !== undefined) {
      return residents.some((row) => row.phase === "running" || row.phase === "compacting");
    }
    const snapshot = this.#sessionRef.current?.controller.publication()?.snapshot;
    return snapshot?.isStreaming === true || snapshot?.isCompacting === true;
  }

  async rollbackRuntime(): Promise<void> {
    if (this.#closed || this.isBusy()) throw new Error("Finish active sessions before rolling back Runtime");
    const context = this.#facadeContext;
    const current = await context.backend.installer.current();
    if (current?.previousRuntimeVersion === undefined) throw new Error("No previous Runtime is available for rollback");
    // Activation re-verifies the signed tree and runs the smoke test before
    // changing the pointer. Main then restarts the app to release old workers.
    await context.backend.activate(current.previousRuntimeVersion, context.managedInstall?.activateOptions);
  }

  async pruneRuntimes(): Promise<void> {
    if (this.#closed || this.isBusy()) throw new Error("Finish active sessions before cleaning Runtime versions");
    await this.#facadeContext.backend.installer.prune({ retainStable: 2 });
  }

  /**
   * Point the single publication channel at the current bundle and replay
   * its latest publication so the facade's runtime-changed sync fires
   * promptly. Old session listeners are cancelled first.
   */
  #attachSession(session: DesktopRuntimeSession | undefined, replayConversation = false): void {
    this.#unsubscribeCurrentPublication?.();
    this.#unsubscribeCurrentPublication = undefined;
    this.#unsubscribeConversation?.();
    this.#unsubscribeConversation = undefined;
    this.#unsubscribeConversationResync?.();
    this.#unsubscribeConversationResync = undefined;
    this.#unsubscribeTelemetry?.();
    this.#unsubscribeTelemetry = undefined;
    this.#unsubscribeBtw?.();
    this.#unsubscribeBtw = undefined;
    this.#facadeContext.interaction.attach(session?.controller);
    if (session === undefined) {
      return;
    }
    this.#unsubscribeCurrentPublication = session.onPublication((publication) => {
      this.#facadeContext.publications.publish(publication);
    });
    const controller = session.controller;
    if (typeof controller.onConversationEvent === "function") {
      this.#unsubscribeConversation = controller.onConversationEvent((event) => {
        this.#facadeContext.conversationEvents.publish(event);
      });
    }
    if (typeof controller.onConversationResync === "function") {
      this.#unsubscribeConversationResync = controller.onConversationResync((reason) => {
        this.#facadeContext.conversationResync.publish(reason);
      });
    }
    if (typeof controller.onTelemetryEvent === "function") {
      this.#unsubscribeTelemetry = controller.onTelemetryEvent((event) => {
        this.#facadeContext.telemetryEvents.publish(event);
      });
    }
    if (typeof controller.onBtwEvent === "function") {
      this.#unsubscribeBtw = controller.onBtwEvent((event) => {
        this.#facadeContext.btwEvents.publish(event);
      });
    }
    this.#replayCurrentPublication();
    const selectedSessionId = controller.publication()?.snapshot.sessionId;
    if (replayConversation && selectedSessionId !== undefined) {
      controller.replayConversationEvents(selectedSessionId, (event) => {
        this.#facadeContext.conversationEvents.publish(event);
      });
    }
  }

  #replayCurrentPublication(): void {
    const current = this.#sessionRef.current?.controller.publication();
    if (current !== undefined) {
      this.#facadeContext.publications.publish(current);
    }
  }

  /**
   * Re-binds a fresh client session over the same Host, authority lease,
   * endpoint and Runtime session. The previous facade's client session is
   * closed (dropping its bus subscriptions and publication hook); Host and
   * Runtime stay alive and the same composition object is returned.
   */
  async reload(): Promise<DesktopHostComposition> {
    if (this.#closed || this.#shutdownStarted) {
      throw new Error("desktop host composition is closed");
    }
    // Keep the installation gate and its receipt registry alive while the
    // Renderer reboots. Replacing the facade here would reopen write access.
    if (this.#facade.runtimeInstallInProgress) return this;
    await this.#facade.close();
    this.#facade = buildFacade(this.#facadeContext);
    this.#replayCurrentPublication();
    return this;
  }

  /**
   * Bind the view to another workspace: delegates to the port's optional
   * `rebind`, which selects a Worker already resident for that workspace and,
   * when requested, spawns one. It then re-points the facade's runtime access (hello / snapshot /
   * onPublication) at the returned bundle through the live holder — the facade
   * object the renderer transport is bound to stays the same, so in-flight
   * receipts keep flowing. Workers of other workspaces are left running.
   *
   * When the port reports a live resident for the target workspace this is a
   * binding switch, not a Runtime restart: the fallback cold start is skipped
   * so a transient selection failure cannot silently respawn the process.
   * An `undefined` bundle (Runtime unavailable or a deliberate read-only
   * workspace selection) still re-points the holder so the facade never keeps
   * serving a controller from another workspace. Without a
   * rebind-capable port this is a no-op.
   */
  async rebindWorkspace(
    workspace: { workspaceId: string; cwd: string },
    options?: { readonly launchIfMissing?: boolean },
  ): Promise<void> {
    if (this.#closed || this.#shutdownStarted) {
      throw new Error("desktop host composition is closed");
    }
    this.#facadeContext.workspaceCwd.current = workspace.cwd;
    const port = this.#runtimeSession;
    if (port?.rebind === undefined) {
      return;
    }
    const launchIfMissing = options?.launchIfMissing !== false;
    const hadResident = port.hasResidentForWorkspace?.(workspace.workspaceId) === true;
    let next = await port.rebind(workspace, { launchIfMissing });
    if (next === undefined && !hadResident && launchIfMissing) {
      next = await startInstalledRuntime(this.#facadeContext);
    }
    rememberUnavailable(
      this.#facadeContext.lastUnavailable,
      next,
      port,
      launchIfMissing ? unavailableFromError(new Error("Runtime did not become ready")) : undefined,
    );
    if (next !== undefined) {
      clearDisconnect(this.#facadeContext.lastDisconnect);
    } else {
      rememberDisconnect(this.#facadeContext.lastDisconnect, port);
    }
    this.#sessionStarted = this.#sessionStarted || next !== undefined;
    this.#sessionRef.current = next;
    this.#status = next === undefined ? "read-only" : "ready";
    this.#attachSession(next, true);
  }

  /**
   * Graceful close sequence, invoked only on app quit: facade client-session
   * close, Runtime graceful stop (when this composition started one),
   * endpoint release, authority lease release. Any failure stops the chain
   * (fail closed) so no lease is released while its resources may still be
   * in use. Idempotent: subsequent calls are no-ops.
   */
  async shutdown(): Promise<void> {
    if (this.#shutdownStarted) {
      return;
    }
    this.#shutdownStarted = true;
    await this.#facade.close();
    // Unlike reload(), shutdown is terminal: detach the Runtime-facing sinks
    // so the composition cannot retain listeners after its facade is gone.
    this.#unsubscribeResidents?.();
    this.#unsubscribeWorkspace?.();
    this.#facadeContext.seams.disposeHostOperations?.();
    if (this.#sessionStarted && this.#runtimeSession !== undefined) {
      await this.#runtimeSession.stop();
    }
    await this.#endpointLease.release();
    await this.#lease.release();
    this.#closed = true;
  }
}

/**
 * Brings the Host composition up in the P1 order (module doc). Rejects
 * without side effects on lock failure (second owner fails closed); returns
 * a read-only composition when the Runtime is unavailable, untrusted or not
 * ready.
 */
export async function createDesktopHostComposition(options: DesktopCompositionOptions): Promise<DesktopHostComposition> {
  assertCompositionOptions(options);
  const seams = options.facade ?? {};
  const arch = options.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
  const platform = options.platform;

  // 1. Current-user profile/state directory, via the injected PlatformPort.
  const profileDirectory = await platform.appDataDirectory();

  // 2. Authority lock, acquired BEFORE any HostBackend creation/use.
  const lease = await options.authorityLock.acquire();

  let endpointLease: DesktopEndpointLease | undefined;
  let sessionStarted = false;
  try {
    // 3. Current-user-only private endpoint.
    endpointLease = await options.privateEndpoint.createCurrentUserOnly(profileDirectory);
    try {
      const installerOptions =
        options.installer ??
        (options.managedInstall === undefined
          ? undefined
          : await loadInstallerTrustedKeys(
              options.managedInstall.trustedKeysDirectory === undefined
                ? defaultRuntimeKeysDirectory()
                : [options.managedInstall.trustedKeysDirectory, defaultRuntimeKeysDirectory()],
            ));
      const runtimeInstallDirectory = resolveManagedRuntimeInstallDirectory({
        stateDirectory: profileDirectory,
        ...(options.managedInstall?.installDirectory === undefined
          ? {}
          : { installDirectory: options.managedInstall.installDirectory }),
      });
      // 4. HostBackend initialization.
      const backend = new HostBackend({
        stateDirectory: profileDirectory,
        runtimeInstallDirectory,
        ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
        ...(installerOptions === undefined ? {} : { installer: installerOptions }),
      });
      await backend.initialize();

      if (options.managedInstall?.seedOnStart === true) {
        const hasTrustedKey =
          installerOptions?.trustedKeys !== undefined && Object.keys(installerOptions.trustedKeys).length > 0;
        try {
          const seeded = await seedManagedRuntimeFromArtifact({
            backend,
            platform: `${platform.platform}-${arch}`,
            hasTrustedKey,
            locateArtifact: createManagedArtifactLocator(options.managedInstall),
            ...(options.managedInstall.activateOptions === undefined
              ? {}
              : { activateOptions: options.managedInstall.activateOptions }),
          });
          if (seeded === "seeded") {
            seams.hostLog?.write("info", "runtime.seed", "seeded managed runtime from shipped artifact");
          }
        } catch (error) {
          seams.hostLog?.write("warn", "runtime.seed.fail", errorDetailForLog(error));
        }
      }

      // 5. Managed Runtime resolution with the injected resolver/probe.
      const resolution = await backend.resolve(options.preference ?? DEFAULT_RUNTIME_PREFERENCE);
      seams.hostLog?.write(
        resolution.classification === "managed" || resolution.classification === "compatible-system" ? "info" : "warn",
        "runtime.resolve",
        `classification=${resolution.classification}${resolution.rejectionReason === undefined ? "" : ` reason=${resolution.rejectionReason}`}`,
      );

      // 6. Session controller only after a trusted resolution. Trusted
      // means the resolver's live probe produced full-parity evidence
      // (profile, capability coverage, command manifest, smoke and shutdown
      // verified): `managed` installations and `compatible-system`
      // runtimes. Limited or rejected runtimes never get a controller.
      let session: DesktopRuntimeSession | undefined;
      const runtimeSession = options.runtimeSession;
      const classification = resolution.classification;
      const activeWorkspace = seams.getActiveWorkspace?.();
      let lastUnavailable: HostRuntimeUnavailable | undefined;
      if ((classification === "managed" || classification === "compatible-system") && runtimeSession !== undefined) {
        sessionStarted = true;
        try {
          session = await runtimeSession.start({
            resolution,
            endpoint: endpointLease.endpoint,
            profileDirectory,
            runtimeInstallDirectory,
            ...(installerOptions === undefined ? {} : { installer: installerOptions }),
            ...(activeWorkspace === undefined ? {} : { workspace: activeWorkspace }),
          });
          // A cold preview can race the first Runtime process with Windows
          // Defender/Bun startup. Retry once through the same serialized
          // session port before exposing a read-only shell; manual reconnect
          // should not be required for a transient launch failure.
          if (
            session === undefined &&
            activeWorkspace !== undefined &&
            runtimeSession.ensure !== undefined &&
            runtimeSession.lastUnavailable?.()?.code !== "no-workspace" &&
            runtimeSession.lastUnavailable?.()?.code !== "workspace-unusable" &&
            runtimeSession.lastUnavailable?.()?.code !== "not-installed" &&
            runtimeSession.lastUnavailable?.()?.code !== "resolution-rejected"
          ) {
            seams.hostLog?.write("warn", "runtime.start.retry", "retrying transient Runtime startup failure");
            session = await runtimeSession.ensure();
          }
          lastUnavailable = session === undefined
            ? runtimeSession.lastUnavailable?.() ??
              (activeWorkspace === undefined
                ? { code: "no-workspace", reason: "no workspace is selected" }
                : unavailableFromError(new Error("Runtime did not become ready")))
            : undefined;
        } catch (error) {
          // Runtime start is not Host identity. Keep a read-only facade so
          // bootstrap/install/workspace still work; never null the IPC host.
          seams.hostLog?.write("error", "runtime.start.fail", errorDetailForLog(error));
          await bestEffort(() => runtimeSession.stop());
          sessionStarted = false;
          session = undefined;
          lastUnavailable = runtimeSession.lastUnavailable?.() ?? unavailableFromError(error);
        }
      } else if (classification !== "managed" && classification !== "compatible-system") {
        lastUnavailable = classificationUnavailable(resolution);
      } else {
        lastUnavailable = { code: "not-wired", reason: "runtime session port is not wired" };
      }
      const status: DesktopRuntimeStatus = session === undefined ? "read-only" : "ready";
      const sessionRef = { current: session };
      const publications = new DesktopPublicationForwarder();
      const residents = new IsolatedForwarder<DesktopResidentsChange>();
      const residentTerminalOutcomes = new IsolatedForwarder<ReadonlyArray<CommandLedgerEntry>>();
      const interaction = new DesktopInteractionHost(sessionRef);
      const facadeContext: FacadeContext = {
        authority: authorityIdentityFromLease(lease),
        platform: platform.platform,
        arch,
        backend,
        seams,
        sessionRef,
        lastUnavailable: { current: lastUnavailable },
        lastDisconnect: { current: runtimeSession?.lastDisconnect?.() },
        publications,
        residents,
        residentTerminalOutcomes,
        conversationEvents: new IsolatedForwarder<StudioConversationForward>(),
        telemetryEvents: new IsolatedForwarder<StudioTelemetryForward>(),
        btwEvents: new IsolatedForwarder<StudioBtwForward>(),
        conversationResync: new IsolatedForwarder<string>(),
        interaction,
        bindSession: { current: (next) => {
          sessionRef.current = next;
        } },
        runtimeSession,
        workspaceCwd: { current: activeWorkspace?.cwd ?? seams.getWorkspaceCwd?.() },
        profileDirectory,
        runtimeInstallDirectory,
        endpoint: endpointLease.endpoint,
        hasTrustedKey: installerOptions?.trustedKeys !== undefined && Object.keys(installerOptions.trustedKeys).length > 0,
        ...(installerOptions === undefined ? {} : { installerOptions }),
        ...(options.managedInstall === undefined ? {} : { managedInstall: options.managedInstall }),
      };
      return new DesktopHostCompositionImpl({
        facade: buildFacade(facadeContext),
        status,
        facadeContext,
        lease,
        endpointLease,
        runtimeSession,
        sessionStarted,
      });
    } catch (error) {
      // Fail closed: stop a Runtime this port may have started, release the
      // endpoint reservation and the authority lease, then propagate the
      // original failure (cleanup must not mask it).
      const sessionPort = options.runtimeSession;
      if (sessionStarted && sessionPort !== undefined) {
        await bestEffort(() => sessionPort.stop());
      }
      const endpoint = endpointLease;
      if (endpoint !== undefined) {
        await bestEffort(() => endpoint.release());
      }
      throw error;
    }
  } catch (error) {
    await bestEffort(() => lease.release());
    throw error;
  }
}

async function bestEffort(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    // Cleanup failures never mask the original failure; the resource stays
    // held and the next owner fails closed instead of racing.
  }
}

function errorDetailForLog(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
