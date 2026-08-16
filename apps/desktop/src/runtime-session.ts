/**
 * Production Desktop Runtime session port.
 *
 * Spawns the trusted managed executable under the selected workspace cwd
 * (`--cwd <dir>`), performs the Bridge bootstrap/handshake and wires a
 * `StudioRuntimeSessionController`; `rebind` stops the current Runtime and
 * spawns it again under a new workspace cwd. All of this stays in the
 * Main process — the Renderer never sees an executable path, endpoint,
 * token or PID.
 *
 * Startup rules:
 * - Without a selected workspace `start` returns `undefined` (read-only).
 *   `%APPDATA%\omp-studio` is never impersonated as a project directory.
 * - Without a managed installation (`installer.currentManifest()`) the
 *   port returns `undefined` instead of throwing, so a missing runtime
 *   keeps the whole app read-only instead of killing startup.
 * - The executable path comes ONLY from `currentManifest().entrypointPath`;
 *   `RuntimeResolution` never carries one.
 * - `stop` / `rebind` fail closed: the controller is disposed, the process
 *   is stopped and the bridge is closed — a dead Runtime is never reported
 *   as connected.
 *
 * Bridge token state lives under `<profile>/bridge/` (never inside the
 * user's project directory).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";

import type { HostRuntimeHelloView } from "@omp-studio/host-client-api";
import {
  CommandLedger,
  FileSessionLeaseStore,
  HostBackend,
  NodeRuntimeProcessPort,
  StudioBridgeClient,
  StudioRuntimeSessionController,
  buildProcessProbeArgs,
  createBridgeBootstrap,
  createWindowsBridgeAclPort,
  type BridgeBootstrap,
  type RuntimeContainmentPort,
  type RuntimePublication,
  type SessionLease,
  type SessionLeaseStore,
  type WindowsBridgeAclPort,
} from "@omp-studio/studio-host";
import type {
  ApprovalMode,
  EnvironmentId,
  OperatorCommandManifest,
  RequestId,
  RuntimeEpoch,
  RuntimeId,
  SessionBinding,
  StudioHelloResponse,
  ThreadId,
  WorkspaceId,
} from "@omp-studio/studio-protocol";

import type {
  DesktopRuntimeSession,
  DesktopRuntimeSessionContext,
  DesktopRuntimeSessionPort,
} from "./host-composition.js";
import type { HostLog } from "./host-log.js";

export interface DesktopRuntimeSessionPortOptions {
  /** Bridge token state lives under `<profile>/<bridgeDirectoryName>`; defaults to `bridge`. */
  readonly bridgeDirectoryName?: string;
  /** Injectable current-user ACL provider for the bridge directory/token. */
  readonly windowsAcl?: WindowsBridgeAclPort;
  /** Injectable socket connector (tests); defaults to `node:net` createConnection. */
  readonly connectSocket?: (endpoint: string) => Socket;
  /** Injectable process spawner (tests); defaults to `node:child_process` spawn. */
  readonly spawnProcess?: typeof spawn;
  /** Host-owned diagnostic log; omitted in tests that do not care about files. */
  readonly log?: HostLog;
  /** Process containment; defaults to a plain kill-based fallback (no Job Object in P1). */
  readonly containment?: RuntimeContainmentPort;
  /** Studio protocol versions the Host supports; defaults to the protocol default. */
  readonly supportedProtocolVersions?: readonly number[];
  readonly handshakeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  /** Maximum concurrently resident Runtime Workers; omitted means no application-level cap. */
  readonly maxResidentSessions?: number;
  /** Idle lifetime for a non-active, completed Worker before automatic hibernation. */
  readonly idleWorkerTtlMs?: number;
  /** Cross-process Session writer lease store; production defaults under the profile directory. */
  readonly sessionLeaseStore?: SessionLeaseStore;
  /** Opaque Broker owner identity; production creates one per Host process. */
  readonly ownerId?: string;
  /** Injectable Worker port factory used by desktop multi-session tests. */
  readonly workerPortFactory?: (input: {
    readonly resumeSessionId?: string;
    readonly nextRuntimeEpoch: () => number;
  }) => DesktopRuntimeSessionPort;
}

/** P1 fallback containment: plain `kill()` with a force-kill fallback. */
const KILL_BASED_CONTAINMENT: RuntimeContainmentPort = {
  requestStop(process: ChildProcess): void {
    process.kill();
  },
  forceStop(process: ChildProcess): void {
    process.kill("SIGKILL");
  },
};

function helloView(hello: StudioHelloResponse, classification: SessionBinding["classification"]): HostRuntimeHelloView {
  return {
    runtimeId: hello.runtimeInstanceId,
    runtimeEpoch: Number(hello.runtimeEpoch),
    classification,
    backend: "studio-host",
    runtimeVersion: hello.runtimeVersion,
    upstreamVersion: hello.upstreamVersion,
    upstreamCommit: hello.upstreamCommit,
  };
}

/** True only for a real, non-symlink directory. Never treats process.cwd() as a fallback. */
export async function isUsableWorkspaceDirectory(cwd: string): Promise<boolean> {
  if (cwd.length === 0) {
    return false;
  }
  try {
    const metadata = await lstat(cwd);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Fail closed: a command manifest whose hash or upstream commit disagrees with hello is dropped. */
export function selectVerifiedCommandManifest(
  hello: Pick<StudioHelloResponse, "commandManifestHash" | "upstreamCommit">,
  manifest: OperatorCommandManifest,
): OperatorCommandManifest | undefined {
  if (manifest.hash !== hello.commandManifestHash) {
    return undefined;
  }
  if (manifest.upstreamCommit !== hello.upstreamCommit) {
    return undefined;
  }
  return manifest;
}

interface ResidentRuntime {
  readonly sessionId: string;
  readonly port: DesktopRuntimeSessionPort;
  readonly session: DesktopRuntimeSession;
  readonly lease: SessionLease;
  lastSelected: number;
  idleSince: number | undefined;
  heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Production multi-session coordinator. Each resident Session owns an
 * independent single-Worker port; selecting a sibling only changes the
 * active facade binding and leaves the previous Worker running.
 */
export function createDesktopRuntimeSessionPort(
  options: DesktopRuntimeSessionPortOptions = {},
): DesktopRuntimeSessionPort {
  const maxResidentSessions = options.maxResidentSessions ?? Number.POSITIVE_INFINITY;
  if (maxResidentSessions !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxResidentSessions) || maxResidentSessions < 1)) {
    throw new TypeError("maxResidentSessions must be a positive integer when provided");
  }
  const idleWorkerTtlMs = options.idleWorkerTtlMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(idleWorkerTtlMs) || idleWorkerTtlMs <= 0) {
    throw new TypeError("idleWorkerTtlMs must be a positive integer");
  }
  const ownerId = options.ownerId ?? `desktop-${process.pid}-${randomUUID()}`;
  const residents = new Map<string, ResidentRuntime>();
  let context: DesktopRuntimeSessionContext | undefined;
  let workspace: { workspaceId: string; cwd: string } | undefined;
  let activeSessionId: string | undefined;
  let leaseStore: SessionLeaseStore | undefined = options.sessionLeaseStore;
  let runtimeEpoch = 0;
  let selection = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = queue.then(operation, operation);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const nextRuntimeEpoch = (): number => {
    runtimeEpoch += 1;
    return runtimeEpoch;
  };

  const getLeaseStore = (): SessionLeaseStore => {
    if (leaseStore !== undefined) return leaseStore;
    const profileDirectory = context?.profileDirectory;
    if (profileDirectory === undefined) throw new Error("Runtime context is not initialized");
    leaseStore = new FileSessionLeaseStore({ directory: join(profileDirectory, "broker", "session-leases") });
    return leaseStore;
  };

  const workerPort = (resumeSessionId?: string): DesktopRuntimeSessionPort =>
    options.workerPortFactory?.({
      ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
      nextRuntimeEpoch,
    }) ?? createSingleDesktopRuntimeSessionPort(options, resumeSessionId, nextRuntimeEpoch);

  const stopResident = async (resident: ResidentRuntime): Promise<void> => {
    await resident.port.stop();
    if (resident.heartbeatTimer !== undefined) clearInterval(resident.heartbeatTimer);
    resident.heartbeatTimer = undefined;
    if (resident.idleTimer !== undefined) clearTimeout(resident.idleTimer);
    resident.idleTimer = undefined;
    await resident.lease.release();
    residents.delete(resident.sessionId);
    if (activeSessionId === resident.sessionId) activeSessionId = undefined;
  };

  const stopAll = async (): Promise<void> => {
    const current = [...residents.values()];
    for (const resident of current) await stopResident(resident);
  };

  const ensureCapacity = async (): Promise<void> => {
    if (maxResidentSessions === Number.POSITIVE_INFINITY) return;
    if (residents.size < maxResidentSessions) return;
    const candidate = [...residents.values()]
      .filter((resident) => resident.sessionId !== activeSessionId && sessionIsIdle(resident.session))
      .sort((left, right) => left.lastSelected - right.lastSelected)[0];
    if (candidate === undefined) {
      throw new Error("Runtime worker capacity is exhausted; no idle background Session can hibernate");
    }
    options.log?.write("info", "runtime.hibernate", `session=${candidate.sessionId}`);
    await stopResident(candidate);
  };

  const launchWorker = async (resumeSessionId?: string): Promise<DesktopRuntimeSession | undefined> => {
    const launchContext = context;
    const selected = workspace;
    if (launchContext === undefined || selected === undefined) return undefined;
    await ensureCapacity();
    let lease: SessionLease | undefined;
    const port = workerPort(resumeSessionId);
    try {
      if (resumeSessionId !== undefined) {
        lease = await getLeaseStore().acquire({ sessionId: resumeSessionId, ownerId });
      }
      const session = await port.start({ ...launchContext, workspace: selected });
      if (session === undefined) {
        await lease?.release();
        return undefined;
      }
      const snapshot = session.controller.publication()?.snapshot;
      if (snapshot === undefined || session.hello() === undefined) {
        throw new Error("Runtime Worker did not publish a ready Session snapshot");
      }
      if (resumeSessionId !== undefined && snapshot.sessionId !== resumeSessionId) {
        throw new Error("Runtime Worker authenticated a different Session identity");
      }
      if (lease === undefined) {
        lease = await getLeaseStore().acquire({ sessionId: snapshot.sessionId, ownerId });
      }
      if (residents.has(snapshot.sessionId)) {
        throw new Error("Runtime Worker returned an already-resident Session identity");
      }
      const resident: ResidentRuntime = {
        sessionId: snapshot.sessionId,
        port,
        session,
        lease,
        lastSelected: 0,
        idleSince: undefined,
        heartbeatTimer: undefined,
        idleTimer: undefined,
      };
      residents.set(snapshot.sessionId, resident);
      if (lease.heartbeat !== undefined) {
        resident.heartbeatTimer = setInterval(() => {
          void Promise.resolve(lease!.heartbeat!()).catch((error) => {
            options.log?.write("error", "runtime.worker.lease-lost", errorDetail(error));
            void serialized(() => stopResident(resident)).catch(() => undefined);
          });
        }, 10_000);
        resident.heartbeatTimer.unref?.();
      }
      setActiveSession(snapshot.sessionId);
      options.log?.write("info", "runtime.worker.resident", `session=${snapshot.sessionId} count=${residents.size}`);
      // Re-sync a previously failed approval mode on activate/rebind
      // (plan §5.3.6): the fresh worker reads the persisted global mode from
      // disk; a non-persistent override keeps it aligned when persistence
      // failed or the sibling was out of sync.
      if (pendingApprovalMode !== undefined) {
        await synchronizeApprovalMode(pendingApprovalMode);
      }
      return session;
    } catch (error) {
      try {
        await port.stop();
      } catch {
        // Preserve the launch error; containment remains fail-closed.
      }
      try {
        await lease?.release();
      } catch {
        // Preserve the launch error; a held lease blocks unsafe takeover.
      }
      throw error;
    }
  };

  const selectResident = async (sessionId: string): Promise<DesktopRuntimeSession | undefined> => {
    const existing = residents.get(sessionId);
    if (existing !== undefined) {
      if (existing.session.hello() !== undefined && existing.session.controller.publication()?.snapshot?.sessionId === sessionId) {
        setActiveSession(sessionId);
        if (pendingApprovalMode !== undefined) {
          await synchronizeApprovalMode(pendingApprovalMode);
        }
        options.log?.write("info", "runtime.worker.select", `session=${sessionId} resident=true`);
        return existing.session;
      }
      await stopResident(existing);
    }
    return await launchWorker(sessionId);
  };

  function armIdleTimer(resident: ResidentRuntime): void {
    if (resident.idleTimer !== undefined) clearTimeout(resident.idleTimer);
    resident.idleTimer = undefined;
    if (resident.sessionId === activeSessionId) {
      resident.idleSince = undefined;
      return;
    }
    const now = Date.now();
    if (sessionIsIdle(resident.session)) {
      resident.idleSince ??= now;
    } else {
      resident.idleSince = undefined;
    }
    const delay = resident.idleSince === undefined
      ? idleWorkerTtlMs
      : Math.max(1, idleWorkerTtlMs - (now - resident.idleSince));
    resident.idleTimer = setTimeout(() => {
      void serialized(async () => {
        if (!residents.has(resident.sessionId)) return;
        if (resident.sessionId === activeSessionId) {
          resident.idleSince = undefined;
          return;
        }
        if (!sessionIsIdle(resident.session)) {
          resident.idleSince = undefined;
          armIdleTimer(resident);
          return;
        }
        resident.idleSince ??= Date.now();
        if (Date.now() - resident.idleSince < idleWorkerTtlMs) {
          armIdleTimer(resident);
          return;
        }
        options.log?.write("info", "runtime.hibernate.idle", `session=${resident.sessionId}`);
        await stopResident(resident);
      }).catch((error) => {
        options.log?.write("warn", "runtime.hibernate.idle-failed", errorDetail(error));
      });
    }, delay);
    resident.idleTimer.unref?.();
  }

  function setActiveSession(sessionId: string): void {
    const previous = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
    activeSessionId = sessionId;
    if (previous !== undefined && previous.sessionId !== sessionId) armIdleTimer(previous);
    const current = residents.get(sessionId);
    if (current !== undefined) {
      current.lastSelected = ++selection;
      armIdleTimer(current);
    }
  }

  /**
   * Approval mode last requested but not confirmed on every resident
   * (plan §5.3): when a sibling fails to apply, the mode is re-applied as a
   * non-persistent override the next time a worker launches (activate /
   * rebind). Cleared once every resident confirms.
   */
  let pendingApprovalMode: ApprovalMode | undefined;

  async function invokePermissionMode(
    session: DesktopRuntimeSession,
    mode: ApprovalMode,
    persist: boolean,
  ): Promise<void> {
    const snapshot = session.controller.publication()?.snapshot;
    const hello = session.hello();
    if (snapshot === undefined || hello === undefined) {
      throw new Error("Runtime is not ready for an approval mode change");
    }
    const receipt = await session.controller.invoke({
      type: "studio.request",
      requestId: randomUUID() as RequestId,
      runtimeEpoch: snapshot.runtimeEpoch,
      expectedStateVersion: snapshot.stateVersion,
      operation: { kind: "permissions.mode.set", mode, persist },
    });
    if (receipt.status !== "completed" && receipt.status !== "accepted") {
      throw new Error(receipt.error?.message ?? `Runtime rejected the approval mode change (${receipt.status})`);
    }
  }

  async function synchronizeApprovalMode(mode: ApprovalMode): Promise<{
    mode: ApprovalMode;
    syncStatus: "complete" | "partial";
    appliedSessions: number;
    failedSessions: number;
  }> {
    const current = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
    if (current === undefined && residents.size === 0) {
      throw new Error("No Runtime session is available for an approval mode change");
    }
    let appliedSessions = 0;
    let failedSessions = 0;
    const apply = async (session: DesktopRuntimeSession, persist: boolean): Promise<void> => {
      try {
        await invokePermissionMode(session, mode, persist);
        appliedSessions += 1;
      } catch {
        failedSessions += 1;
      }
    };
    // Re-run the complete resident set on every retry. Clearing a single
    // global pending value after only one Worker succeeded could otherwise
    // leave another resident on a stale, more permissive mode indefinitely.
    if (current !== undefined) {
      await apply(current.session, true);
      if (failedSessions > 0) {
        pendingApprovalMode = mode;
        return { mode, syncStatus: "partial", appliedSessions, failedSessions };
      }
    }
    for (const resident of residents.values()) {
      if (resident === current) continue;
      await apply(resident.session, false);
    }
    pendingApprovalMode = failedSessions > 0 ? mode : undefined;
    options.log?.write(
      "info",
      "runtime.approval-mode",
      `mode=${mode} applied=${appliedSessions} failed=${failedSessions}`,
    );
    return {
      mode,
      syncStatus: failedSessions === 0 ? "complete" : "partial",
      appliedSessions,
      failedSessions,
    };
  }

  return {
    supportsConcurrentSessions: true,
    start(launchContext): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        context = launchContext;
        if (launchContext.workspace !== undefined) workspace = launchContext.workspace;
        if (workspace === undefined) {
          options.log?.write("info", "runtime.start.skip", "no-workspace");
          return undefined;
        }
        const active = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
        return active?.session ?? (await launchWorker());
      });
    },
    stop(): Promise<void> {
      return serialized(stopAll);
    },
    rebind(next): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        await stopAll();
        workspace = next;
        return await launchWorker();
      });
    },
    switchSession(intent): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        if (intent.kind === "resume") return await selectResident(intent.sessionId);
        return await launchWorker();
      });
    },
    async applyApprovalMode(mode: ApprovalMode): Promise<{
      mode: ApprovalMode;
      syncStatus: "complete" | "partial";
      appliedSessions: number;
      failedSessions: number;
    }> {
      return await serialized(() => synchronizeApprovalMode(mode));
    },
  };
}

function createSingleDesktopRuntimeSessionPort(
  options: DesktopRuntimeSessionPortOptions,
  initialResumeSessionId: string | undefined,
  nextRuntimeEpoch: () => number,
): DesktopRuntimeSessionPort {
  const containment = options.containment ?? KILL_BASED_CONTAINMENT;
  const log = options.log;
  /** The selected workspace; `undefined` until the first pick/open rebind. */
  let workspace: { workspaceId: string; cwd: string } | undefined;
  /** Start context (profile directory) captured by `start`; needed by `rebind`. */
  let context: DesktopRuntimeSessionContext | undefined;
  let processPort: NodeRuntimeProcessPort | undefined;
  let bridge: StudioBridgeClient | undefined;
  let bundle: DesktopRuntimeSession | undefined;
  let sessionController: StudioRuntimeSessionController | undefined;
  let unsubscribeProjection: (() => void) | undefined;
  let alive = false;
  let resumeSessionId: string | undefined = initialResumeSessionId;
  /** Bumped on every launch so a late socket close cannot kill the next session. */
  let generation = 0;
  /** Public start/stop/rebind/switch must not overlap; overlapping kills the live Runtime. */
  let queue: Promise<unknown> = Promise.resolve();

  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op, op);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function stopCurrent(): Promise<void> {
    log?.write(
      "info",
      "runtime.stop",
      `generation=${generation} hadSession=${bundle !== undefined} alive=${alive}`,
    );
    alive = false;
    unsubscribeProjection?.();
    unsubscribeProjection = undefined;
    const current = bundle;
    bundle = undefined;
    const controller = sessionController ?? current?.controller;
    sessionController = undefined;
    controller?.dispose();
    const port = processPort;
    processPort = undefined;
    if (port !== undefined) {
      await port.stop();
    }
    bridge?.close();
    bridge = undefined;
  }

  async function launch(): Promise<DesktopRuntimeSession | undefined> {
    const selected = workspace;
    const launchContext = context;
    if (selected === undefined || launchContext === undefined) {
      log?.write("info", "runtime.launch.skip", "no-workspace");
      return undefined;
    }
    if (launchContext.resolution.classification === "rejected") {
      log?.write("warn", "runtime.launch.skip", "resolution-rejected");
      return undefined;
    }
    if (!(await isUsableWorkspaceDirectory(selected.cwd))) {
      log?.write("warn", "runtime.launch.skip", "workspace-unusable");
      return undefined;
    }
    const backend = new HostBackend({ stateDirectory: launchContext.profileDirectory });
    await backend.initialize();
    const installed = await backend.installer.currentManifest();
    if (installed === undefined) {
      log?.write("warn", "runtime.launch.skip", "no-managed-install");
      return undefined;
    }

    const launchGeneration = ++generation;
    let becameReady = false;
    log?.write(
      "info",
      "runtime.launch.begin",
      `generation=${launchGeneration} resume=${resumeSessionId === undefined ? "no" : "yes"} classification=${launchContext.resolution.classification}`,
    );

    const bridgeBootstrap: BridgeBootstrap =
      options.windowsAcl !== undefined || process.platform !== "win32"
        ? await createBridgeBootstrap(
            join(launchContext.profileDirectory, options.bridgeDirectoryName ?? "bridge"),
            process.platform,
            options.windowsAcl,
          )
        : await createBridgeBootstrap(
            join(launchContext.profileDirectory, options.bridgeDirectoryName ?? "bridge"),
            process.platform,
            createWindowsBridgeAclPort(),
          );

    /** Filled by the readiness hook with the authenticated handshake hello. */
    let hello: StudioHelloResponse | undefined;
    let controller: StudioRuntimeSessionController | undefined;
    const publicationListeners = new Set<(publication: RuntimePublication) => void>();
    const emitPublication = (): void => {
      const current = controller?.publication();
      if (current === undefined) {
        return;
      }
      for (const listener of [...publicationListeners]) {
        try {
          listener(current);
        } catch {
          // Isolate publication consumers from the Bridge socket.
        }
      }
    };
    const client = new StudioBridgeClient({
      endpoint: bridgeBootstrap.endpoint,
      token: bridgeBootstrap.token,
      ...(options.supportedProtocolVersions === undefined
        ? {}
        : { supportedProtocolVersions: options.supportedProtocolVersions }),
      ...(options.handshakeTimeoutMs === undefined ? {} : { handshakeTimeoutMs: options.handshakeTimeoutMs }),
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
      ...(options.connectSocket === undefined ? {} : { connectSocket: options.connectSocket }),
      onDisconnect: () => {
        if (launchGeneration !== generation) {
          log?.write(
            "info",
            "runtime.disconnect.stale",
            `launch=${launchGeneration} current=${generation}`,
          );
          return;
        }
        log?.write("warn", "runtime.disconnect", `generation=${launchGeneration} alive=${alive}`);
        alive = false;
        const current = controller;
        if (current === undefined) {
          return;
        }
        try {
          const snapshot = current.publication()?.snapshot;
          if (snapshot !== undefined) {
            current.runtimeLost(snapshot.runtimeId, snapshot.runtimeEpoch);
          }
        } catch {
          // Loss fencing must not throw out of the socket close path.
        }
        emitPublication();
      },
    });
    bridge = client;

    try {
      const extra = ["--cwd", selected.cwd];
      if (resumeSessionId !== undefined) {
        extra.push("--resume", resumeSessionId);
      }
      const launchEpoch = nextRuntimeEpoch();

      const binding: SessionBinding = {
        threadId: "thread-gui-main" as ThreadId,
        environmentId: "env-gui-main" as EnvironmentId,
        workspaceId: selected.workspaceId as WorkspaceId,
        runtimeId: "runtime-pending" as RuntimeId,
        runtimeEpoch: launchEpoch as RuntimeEpoch,
        classification: launchContext.resolution.classification,
        backend: "studio-host",
        runtimeVersion: installed.manifest.runtimeVersion,
        upstreamVersion: installed.manifest.upstreamVersion,
        upstreamCommit: installed.manifest.upstreamCommit,
        capabilityHash: installed.manifest.capabilityHash,
        commandManifestHash: installed.manifest.commandManifestHash,
      };

      const port = new NodeRuntimeProcessPort({
        executable: installed.entrypointPath,
        cwd: selected.cwd,
        args: () => buildProcessProbeArgs(extra, bridgeBootstrap, launchEpoch),
        containment,
        waitUntilReady: async (child) => {
          attachRuntimeOutput(child, log);
          child.once("exit", (code, signal) => {
            log?.write(
              becameReady && launchGeneration === generation ? "error" : "info",
              "runtime.process.exit",
              `generation=${launchGeneration} code=${code} signal=${signal ?? "none"} afterReady=${becameReady}`,
            );
          });
          hello = await client.connectUntilReady({
            deadline: Date.now() + (options.handshakeTimeoutMs ?? 10_000),
            hasExited: () => child.exitCode !== null || child.signalCode !== null,
          });
          log?.write(
            "info",
            "runtime.handshake.ok",
            `generation=${launchGeneration} protocol=${hello.selectedProtocolVersion}`,
          );
        },
        requestGracefulShutdown: async () => {
          await client.shutdown();
        },
        // stdout stays ignored: studio-host still starts the interactive TUI,
        // and a piped stdout makes that TUI exit 129 right after handshake.
        spawnOptions: { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
        ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      });
      processPort = port;
      await port.start(binding);

      controller = new StudioRuntimeSessionController(client, new CommandLedger());
      sessionController = controller;
      await controller.refresh();
      if (hello === undefined) {
        throw new Error("Runtime Bridge handshake completed without a hello response");
      }
      const capability = hello.capabilityManifest;
      let command: OperatorCommandManifest | undefined;
      try {
        command = selectVerifiedCommandManifest(hello, await client.requestCommandManifest());
      } catch {
        command = undefined;
      }
      const view = helloView(hello, launchContext.resolution.classification);
      const session: DesktopRuntimeSession = {
        controller,
        hello: () => (alive ? view : undefined),
        capabilityManifest: () => (alive ? capability : undefined),
        commandManifest: () => (alive ? command : undefined),
        onPublication: (listener) => {
          publicationListeners.add(listener);
          return () => {
            publicationListeners.delete(listener);
          };
        },
      };
      unsubscribeProjection = controller.onPublication(() => emitPublication());
      bundle = session;
      alive = true;
      becameReady = true;
      log?.write("info", "runtime.launch.ready", `generation=${launchGeneration}`);
      return session;
    } catch (error) {
      log?.write("error", "runtime.launch.fail", `generation=${launchGeneration} ${errorDetail(error)}`);
      await stopCurrent();
      throw error;
    }
  }

  return {
    start(launchContext: DesktopRuntimeSessionContext): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        context = launchContext;
        if (launchContext.workspace !== undefined) {
          workspace = launchContext.workspace;
        }
        if (workspace === undefined) {
          log?.write("info", "runtime.start.skip", "no-workspace");
          return undefined;
        }
        return await launch();
      });
    },

    stop(): Promise<void> {
      return serialized(() => stopCurrent());
    },

    rebind(next: { workspaceId: string; cwd: string }): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        log?.write("info", "runtime.rebind", `generation=${generation}`);
        await stopCurrent();
        resumeSessionId = undefined;
        workspace = next;
        return await launch();
      });
    },

    switchSession(intent: { kind: "resume"; sessionId: string } | { kind: "fresh" }): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        const previousResume = resumeSessionId;
        log?.write("info", "runtime.switch.begin", `kind=${intent.kind} generation=${generation}`);
        await stopCurrent();
        resumeSessionId = intent.kind === "resume" ? intent.sessionId : undefined;
        try {
          const next = await launch();
          if (next !== undefined) {
            log?.write("info", "runtime.switch.ok", `kind=${intent.kind} generation=${generation}`);
            return next;
          }
          log?.write("warn", "runtime.switch.empty", `kind=${intent.kind}`);
        } catch (error) {
          log?.write("error", "runtime.switch.fail", errorDetail(error));
          await stopCurrent();
        }
        resumeSessionId = previousResume;
        log?.write("warn", "runtime.switch.fallback", `resume=${previousResume === undefined ? "no" : "yes"}`);
        return await launch();
      });
    },

    async applyApprovalMode(mode: ApprovalMode): Promise<{
      mode: ApprovalMode;
      syncStatus: "complete" | "partial";
      appliedSessions: number;
      failedSessions: number;
    }> {
      return await serialized(async () => {
        if (bundle === undefined) {
          throw new Error("No Runtime session is available for an approval mode change");
        }
        try {
          const snapshot = bundle.controller.publication()?.snapshot;
          const hello = bundle.hello();
          if (snapshot === undefined || hello === undefined) {
            throw new Error("Runtime is not ready for an approval mode change");
          }
          const receipt = await bundle.controller.invoke({
            type: "studio.request",
            requestId: randomUUID() as RequestId,
            runtimeEpoch: snapshot.runtimeEpoch,
            expectedStateVersion: snapshot.stateVersion,
            operation: { kind: "permissions.mode.set", mode, persist: true },
          });
          if (receipt.status !== "completed" && receipt.status !== "accepted") {
            throw new Error(receipt.error?.message ?? `Runtime rejected the approval mode change (${receipt.status})`);
          }
          return { mode, syncStatus: "complete", appliedSessions: 1, failedSessions: 0 };
        } catch {
          return { mode, syncStatus: "partial", appliedSessions: 0, failedSessions: 1 };
        }
      });
    },
  };
}

function attachRuntimeOutput(child: ChildProcess, log: HostLog | undefined): void {
  if (log === undefined) {
    return;
  }
  const pipe = (stream: NodeJS.ReadableStream | null | undefined, event: "runtime.stdout" | "runtime.stderr"): void => {
    stream?.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        log.write("info", event, trimmed);
      }
    });
  };
  pipe(child.stdout, "runtime.stdout");
  pipe(child.stderr, "runtime.stderr");
}

function sessionIsIdle(session: DesktopRuntimeSession): boolean {
  const snapshot = session.controller.publication()?.snapshot;
  return (
    snapshot !== undefined &&
    !snapshot.isStreaming &&
    !snapshot.isCompacting &&
    snapshot.pendingMessages === 0 &&
    snapshot.activeCommandIds.length === 0
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}
