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

import type { ClientTransport, PublicAuthorityIdentity, ArchId, PlatformId, AuthorityId, AuthorityEpoch } from "@omp-studio/client-contract";
import {
  createDefaultHostDiagnosticsFactory,
  StudioHostClientFacade,
  type HostDiagnosticsFactory,
  type HostExtensibilityService,
  type HostManifestProvider,
  type HostModelsService,
  type HostRuntimeAccess,
  type HostRuntimeHelloView,
  type HostRuntimeInstallService,
  type HostSemanticCommandService,
  type HostSessionCatalogProvider,
  type HostWorkspaceService,
  type StudioHostClientFacadeOptions,
} from "@omp-studio/host-client-api";
import { createOmpExtensibilityService } from "@omp-studio/host-client-api/extensibility";
import { createOmpModelsService } from "@omp-studio/host-client-api/models";
import type { PlatformPort, PrivateEndpoint } from "@omp-studio/platform";
import {
  HostBackend,
  StudioRuntimeSessionController,
  type RuntimePublication,
  type RuntimeResolution,
  type RuntimeResolverEnvironment,
} from "@omp-studio/studio-host";
import type { CapabilityManifest, OperatorCommandManifest, RuntimePreference } from "@omp-studio/studio-protocol";

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
}

/** Context handed to the runtime session port after a trusted resolution. */
export interface DesktopRuntimeSessionContext {
  readonly resolution: RuntimeResolution;
  readonly endpoint: PrivateEndpoint;
  readonly profileDirectory: string;
}

/**
 * Injectable Runtime start/stop port. The production implementation
 * (Main/native composition) spawns the trusted executable, performs the
 * Bridge bootstrap/handshake and wires the session controller; tests
 * substitute fakes so no untrusted file is ever executed.
 */
export interface DesktopRuntimeSessionPort {
  /**
   * Starts (or connects to) the trusted Runtime and returns a ready
   * session bundle, or `undefined` when the Runtime is not ready. Called
   * at most once per composition.
   */
  start(context: DesktopRuntimeSessionContext): Promise<DesktopRuntimeSession | undefined>;
  /** Gracefully stops the Runtime if this port started one; no-op otherwise. */
  stop(): Promise<void>;
  /**
   * Optional workspace rebind: stop the current Runtime (if any), spawn it
   * again under the given workspace cwd and return the new session bundle
   * (`undefined` when the Runtime is not available). The composition
   * rebuilds the facade's runtime access from the returned bundle. Never
   * changes the `start` contract: startup still happens at most once.
   */
  rebind?(workspace: { workspaceId: string; cwd: string }): Promise<DesktopRuntimeSession | undefined>;
}

/** Facade seam providers; every optional slot fails closed when absent. */
export interface DesktopFacadeSeams {
  readonly capabilityManifest?: HostManifestProvider<CapabilityManifest>;
  readonly commandManifest?: HostManifestProvider<OperatorCommandManifest>;
  readonly catalog?: HostSessionCatalogProvider;
  readonly diagnostics?: HostDiagnosticsFactory;
  readonly install?: HostRuntimeInstallService;
  readonly commands?: HostSemanticCommandService;
  readonly models?: HostModelsService;
  readonly extensibility?: HostExtensibilityService;
  readonly workspaces?: HostWorkspaceService;
  readonly openUrl?: (url: string) => Promise<void>;
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

interface FacadeContext {
  readonly authority: PublicAuthorityIdentity;
  readonly platform: PlatformId;
  readonly arch: ArchId;
  readonly backend: HostBackend;
  readonly seams: DesktopFacadeSeams;
  /** Live session-bundle holder; the facade's runtime access reads it. */
  readonly sessionRef: { current: DesktopRuntimeSession | undefined };
  /** Forwarder for the current bundle's publications (facade onPublication). */
  readonly publications: SessionPublicationForwarder;
}

/** Fan-out for the current Runtime bundle's publication stream. */
export interface SessionPublicationForwarder {
  subscribe(listener: (publication: RuntimePublication) => void): () => void;
}

function buildFacade(context: FacadeContext): StudioHostClientFacade {
  const seams = context.seams;
  const sessionRef = context.sessionRef;
  const runtimeCommandService = {
    resume: async () => { throw new Error("session.resume requires a session catalog command service"); },
    drop: async () => { throw new Error("session.drop requires a session catalog command service"); },
    respond: async () => { throw new Error("interaction.respond requires an interaction command service"); },
    invoke: async (operation: import("@omp-studio/studio-protocol").StudioOperation) => {
      const session = sessionRef.current;
      if (session === undefined) throw new Error("Runtime is not available");
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) throw new Error("Runtime snapshot is unavailable");
      const receipt = await session.controller.invoke({
        type: "studio.request",
        requestId: `gui-${Date.now()}-${Math.random().toString(36).slice(2)}` as import("@omp-studio/studio-protocol").RequestId,
        runtimeEpoch: snapshot.runtimeEpoch,
        expectedStateVersion: snapshot.stateVersion,
        operation,
      });
      if (receipt.status !== "completed") throw new Error(receipt.error?.message ?? `Runtime command ${receipt.status}`);
      return session.controller.publication()?.snapshot ?? snapshot;
    },
  } satisfies import("@omp-studio/host-client-api").HostSemanticCommandService;
  const session = sessionRef.current;
  const options: StudioHostClientFacadeOptions = {
    authority: context.authority,
    platform: context.platform,
    arch: context.arch,
    backend: context.backend,
    capabilityManifest: seams.capabilityManifest ?? (() => undefined),
    commandManifest: seams.commandManifest ?? (() => undefined),
    catalog: seams.catalog ?? { list: () => [] },
    diagnostics: seams.diagnostics ?? createDefaultHostDiagnosticsFactory(),
    // Refuse to fake an install: without an injected service the command
    // fails closed instead of completing with a state nothing changed.
    install:
      seams.install ??
      (async () => {
        throw new Error("no runtime install service is wired; runtime.install is not available");
      }),
    ...(seams.commands !== undefined ? { commands: seams.commands } : { commands: runtimeCommandService }),
    models: seams.models ?? createOmpModelsService(seams.openUrl === undefined ? {} : { openUrl: seams.openUrl }),
    extensibility: seams.extensibility ?? createOmpExtensibilityService(),
    ...(seams.workspaces === undefined ? {} : { workspaces: seams.workspaces }),
    // The runtime access reads the live holder, so a workspace rebind
    // re-points hello / snapshot / onPublication without replacing the
    // facade object the renderer transport is bound to.
    runtime: {
      ...(session === undefined ? {} : { session: session.controller }),
      hello: () => sessionRef.current?.hello(),
      snapshot: () => sessionRef.current?.controller.publication()?.snapshot,
      onPublication: (listener) => context.publications.subscribe(listener),
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
  readonly #status: DesktopRuntimeStatus;
  #facadeContext: FacadeContext;
  readonly #lease: DesktopAuthorityLease;
  readonly #endpointLease: DesktopEndpointLease;
  readonly #runtimeSession: DesktopRuntimeSessionPort | undefined;
  #sessionStarted: boolean;
  readonly #sessionRef: { current: DesktopRuntimeSession | undefined };
  readonly #publicationListeners = new Set<(publication: RuntimePublication) => void>();
  #unsubscribeCurrentPublication: (() => void) | undefined;
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
    this.#sessionStarted = options.sessionStarted;
    this.#sessionRef = options.facadeContext.sessionRef;
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
   * Point the publication forwarder at the current bundle and replay its
   * latest publication so the facade's runtime-changed sync fires promptly.
   */
  #attachSession(session: DesktopRuntimeSession | undefined): void {
    this.#unsubscribeCurrentPublication?.();
    this.#unsubscribeCurrentPublication = undefined;
    if (session === undefined) {
      return;
    }
    this.#unsubscribeCurrentPublication = session.onPublication((publication) => {
      for (const listener of this.#publicationListeners) {
        listener(publication);
      }
    });
    const current = session.controller.publication();
    if (current !== undefined) {
      for (const listener of this.#publicationListeners) {
        listener(current);
      }
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
    await this.#facade.close();
    this.#facade = buildFacade(this.#facadeContext);
    return this;
  }

  /**
   * Restart the Runtime under a new workspace cwd: delegates to the port's
   * optional `rebind` (stop current Runtime, spawn with the new cwd) and
   * re-points the facade's runtime access (hello / snapshot / onPublication)
   * at the returned bundle through the live holder — the facade object the
   * renderer transport is bound to stays the same, so in-flight receipts
   * keep flowing. An `undefined` bundle (Runtime not available) still
   * re-points the holder so the facade never keeps serving a dead
   * controller. Without a rebind-capable port this is a no-op.
   */
  async rebindWorkspace(workspace: { workspaceId: string; cwd: string }): Promise<void> {
    if (this.#closed || this.#shutdownStarted) {
      throw new Error("desktop host composition is closed");
    }
    const port = this.#runtimeSession;
    if (port?.rebind === undefined) {
      return;
    }
    const next = await port.rebind(workspace);
    this.#sessionStarted = this.#sessionStarted || next !== undefined;
    this.#sessionRef.current = next;
    this.#attachSession(next);
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
      // 4. HostBackend initialization.
      const backend = new HostBackend({
        stateDirectory: profileDirectory,
        ...(options.resolver === undefined ? {} : { resolver: options.resolver }),
      });
      await backend.initialize();

      // 5. Managed Runtime resolution with the injected resolver/probe.
      const resolution = await backend.resolve(options.preference ?? DEFAULT_RUNTIME_PREFERENCE);

      // 6. Session controller only after a trusted resolution. Trusted
      // means the resolver's live probe produced full-parity evidence
      // (profile, capability coverage, command manifest, smoke and shutdown
      // verified): `managed` installations and `compatible-system`
      // runtimes. Limited or rejected runtimes never get a controller.
      let session: DesktopRuntimeSession | undefined;
      const runtimeSession = options.runtimeSession;
      const classification = resolution.classification;
      if ((classification === "managed" || classification === "compatible-system") && runtimeSession !== undefined) {
        sessionStarted = true;
        session = await runtimeSession.start({
          resolution,
          endpoint: endpointLease.endpoint,
          profileDirectory,
        });
      }
      const status: DesktopRuntimeStatus = session === undefined ? "read-only" : "ready";
      const sessionRef = { current: session };
      const publicationListeners = new Set<(publication: RuntimePublication) => void>();
      const publications: SessionPublicationForwarder = {
        subscribe(listener) {
          publicationListeners.add(listener);
          return () => {
            publicationListeners.delete(listener);
          };
        },
      };
      const facadeContext: FacadeContext = {
        authority: authorityIdentityFromLease(lease),
        platform: platform.platform,
        arch,
        backend,
        seams,
        sessionRef,
        publications,
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
