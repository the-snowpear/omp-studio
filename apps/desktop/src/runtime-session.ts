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
 * - The executable path comes ONLY from `currentManifest().entrypointPath`
 *   under the Host installer root (packaged: `$INSTDIR\runtime`);
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

import { redactText, type HostRuntimeHelloView, type HostRuntimeDisconnect, type HostRuntimeUnavailable } from "@omp-studio/host-client-api";
import {
  CommandLedger,
  FileSessionLeaseStore,
  HostBackend,
  NodeRuntimeProcessPort,
  StudioBridgeClient,
  StudioBridgeHandshakeError,
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
  CommandLedgerEntry,
  EnvironmentId,
  OperatorCommandManifest,
  OperatorStateSnapshot,
  RequestId,
  RuntimeEpoch,
  RuntimeId,
  SessionBinding,
  StudioHelloResponse,
  ThreadId,
  WorkspaceId,
} from "@omp-studio/studio-protocol";
import type {
  ResidentSessionPhase,
  ResidentSessionRow,
  ResidentWaitKind,
  ResidentsReadModel,
  RuntimeUnavailableCode,
} from "@omp-studio/client-contract";

import type {
  DesktopResidentsChange,
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
  /** Automatic relaunch after an unexpected drop; default 1. Zero disables. */
  readonly autoRespawnLimit?: number;
  /** Delay before an automatic relaunch; default 500ms. */
  readonly autoRespawnDelayMs?: number;
  /** Maximum concurrently resident Runtime Workers. Omitted means no application-level cap. */
  readonly maxResidentSessions?: number;
  /** @deprecated Worker parking is owned by the Runtime; this option is retained for test/API compatibility. */
  readonly idleWorkerTtlMs?: number;
  /** Cross-process Session writer lease store; production defaults under the profile directory. */
  readonly sessionLeaseStore?: SessionLeaseStore;
  /** Session writer lease heartbeat interval; injectable for lifecycle tests. */
  readonly leaseHeartbeatIntervalMs?: number;
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
  /**
   * The workspace this Worker was spawned under. A Runtime process binds its
   * cwd at spawn time (`--cwd`), so this never changes for a resident: opening
   * another project selects (or launches) a different Worker instead.
   */
  readonly workspace: { workspaceId: string; cwd: string };
  port: DesktopRuntimeSessionPort;
  session: DesktopRuntimeSession;
  readonly lease: SessionLease;
  lastSelected: number;
  idleSince: number | undefined;
  lastActivityAt: string;
  lastCommitSeq: number;
  unsubscribePublication: (() => void) | undefined;
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
  // Runtime 进程不由桌面空闲计时器回收。Runtime 内部的 Worker 由 OMP
  // AgentLifecycleManager 负责停驻/唤醒，避免把 Worker 的内存维护误变成
  // Bridge/Runtime 断开。`idleWorkerTtlMs` 仅保留为兼容字段，不再驱动进程。
  const leaseHeartbeatIntervalMs = options.leaseHeartbeatIntervalMs ?? 10_000;
  if (!Number.isSafeInteger(leaseHeartbeatIntervalMs) || leaseHeartbeatIntervalMs <= 0) {
    throw new TypeError("leaseHeartbeatIntervalMs must be a positive integer");
  }
  const ownerId = options.ownerId ?? `desktop-${process.pid}-${randomUUID()}`;
  const residents = new Map<string, ResidentRuntime>();
  let context: DesktopRuntimeSessionContext | undefined;
  /**
   * The workspace new Workers are launched under, i.e. the active project.
   * Residents of other workspaces stay alive and keep streaming; switching
   * projects only moves this pointer and the active session binding.
   */
  let workspace: { workspaceId: string; cwd: string } | undefined;
  let activeSessionId: string | undefined;
  let leaseStore: SessionLeaseStore | undefined = options.sessionLeaseStore;
  let runtimeEpoch = 0;
  let selection = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let lastUnavailable: HostRuntimeUnavailable | undefined;
  let lastDisconnect: HostRuntimeDisconnect | undefined;
  let sessionSink: ((session: DesktopRuntimeSession | undefined) => void) | undefined;
  const residentSinks = new Set<(change: DesktopResidentsChange) => void>();
  /**
   * Several owners follow the active project (the composition's facade context
   * and the Main-process workspace cwd used by chrome), so this is a set
   * rather than the single-listener shape `attachSessionSink` uses.
   */
  const workspaceSinks = new Set<(workspace: { workspaceId: string; cwd: string }) => void>();

  const residentWaitKind = (snapshot: OperatorStateSnapshot | undefined): ResidentWaitKind | undefined => {
    // The GUI-owned interaction is the strongest waiting signal. A plan
    // review remains visible as waiting even after the Runtime has stopped
    // streaming, and therefore must win over the idle fallback.
    if (snapshot !== undefined && snapshot.pendingInteraction?.owner === "gui") {
      const kind = snapshot.pendingInteraction.request.kind;
      return kind === "approval" || kind === "confirm" ? "approval" : "ask";
    }
    if (snapshot?.plan?.status === "review") return "plan";
    return undefined;
  };

  const residentRow = (resident: ResidentRuntime): ResidentSessionRow => {
    const snapshot = resident.session.controller.publication()?.snapshot;
    const waitKind = residentWaitKind(snapshot);
    const phase: ResidentSessionPhase = waitKind !== undefined
      ? "waiting"
      : snapshot?.isCompacting === true
        ? "compacting"
        : snapshot?.isStreaming === true
          ? "running"
          : "idle";
    return {
      sessionId: (snapshot?.sessionId ?? resident.sessionId) as ResidentSessionRow["sessionId"],
      workspaceId: resident.workspace.workspaceId as ResidentSessionRow["workspaceId"],
      phase,
      pendingMessages: snapshot?.pendingMessages ?? 0,
      ...(waitKind === undefined ? {} : { waitKind }),
      lastActivityAt: resident.lastActivityAt,
    };
  };

  const listResidents = (): ResidentsReadModel => ({
    residents: [...residents.values()]
      .sort((left, right) => right.lastSelected - left.lastSelected || left.sessionId.localeCompare(right.sessionId))
      .map(residentRow),
    ...(activeSessionId === undefined
      ? {}
      : { activeSessionId: activeSessionId as NonNullable<ResidentsReadModel["activeSessionId"]> }),
    generatedAt: new Date().toISOString(),
  });

  let lastResidentsFingerprint: string | undefined;
  let residentPublicationDepth = 0;
  let deferredResidentTerminalOutcomes: CommandLedgerEntry[] = [];
  const emitResidents = (terminalOutcomes: readonly CommandLedgerEntry[] = []): void => {
    if (residentPublicationDepth > 0) {
      deferredResidentTerminalOutcomes.push(...terminalOutcomes);
      return;
    }
    const model = listResidents();
    const fingerprint = JSON.stringify({
      residents: model.residents,
      activeSessionId: model.activeSessionId,
    });
    if (terminalOutcomes.length === 0 && fingerprint === lastResidentsFingerprint) return;
    lastResidentsFingerprint = fingerprint;
    const change = {
      ...model,
      ...(terminalOutcomes.length === 0
        ? {}
        : { terminalOutcomes }),
    } as DesktopResidentsChange;
    for (const sink of [...residentSinks]) {
      try {
        sink(change);
      } catch {
        // A read-model consumer must never interfere with Runtime I/O.
      }
    }
  };

  /** Hold intermediate broker states until a planned active-Worker handoff
   * has either committed to its replacement or failed. Runtime loss remains
   * observable on failure; successful handoffs publish only the stable model. */
  const batchResidentPublications = (): (() => void) => {
    residentPublicationDepth += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      residentPublicationDepth -= 1;
      if (residentPublicationDepth > 0) return;
      const terminalOutcomes = deferredResidentTerminalOutcomes;
      deferredResidentTerminalOutcomes = [];
      emitResidents(terminalOutcomes);
    };
  };

  const trackResidentPublication = (resident: ResidentRuntime, session: DesktopRuntimeSession): void => {
    resident.unsubscribePublication?.();
    resident.unsubscribePublication = undefined;
    resident.session = session;
    const current = session.controller.publication();
    resident.lastCommitSeq = current?.commitSeq ?? resident.lastCommitSeq;
    resident.lastActivityAt = current?.publishedAt ?? new Date().toISOString();
    resident.unsubscribePublication = session.onPublication((publication) => {
      if (publication.commitSeq <= resident.lastCommitSeq) return;
      resident.lastCommitSeq = publication.commitSeq;
      resident.lastActivityAt = publication.publishedAt;
      emitResidents(publication.terminalOutcomes);
      // A publication is Runtime activity even when its resulting snapshot is
      // idle (for example a completed setting command). Start the idle window
      // from this publication rather than an older selection timestamp.
      resident.idleSince = sessionIsIdle(resident.session) ? Date.now() : undefined;
      armIdleTimer(resident);
    });
  };

  /**
   * Move the active-project pointer and tell every follower, so cwd-derived
   * reads (session catalog, archive, models/mcp scope) follow the selected
   * Worker. A no-op when the pointer already names this workspace.
   */
  const adoptWorkspace = (next: { workspaceId: string; cwd: string }): void => {
    if (workspace?.workspaceId === next.workspaceId && workspace.cwd === next.cwd) return;
    workspace = next;
    for (const sink of [...workspaceSinks]) {
      try {
        sink(next);
      } catch {
        // Isolate followers from the selection path.
      }
    }
  };

  const rememberUnavailable = (facts: HostRuntimeUnavailable | undefined): void => {
    lastUnavailable = facts;
  };

  const rememberDisconnect = (facts: HostRuntimeDisconnect | undefined): void => {
    lastDisconnect = facts === undefined ? undefined : {
      code: facts.code,
      reason: redactText(facts.reason),
      occurredAt: facts.occurredAt ?? lastDisconnect?.occurredAt ?? new Date().toISOString(),
      ...(facts.autoRespawn === undefined ? {} : { autoRespawn: facts.autoRespawn }),
    };
  };

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

  const workerPort = (resumeSessionId?: string): DesktopRuntimeSessionPort => {
    const port =
      options.workerPortFactory?.({
        ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
        nextRuntimeEpoch,
      }) ?? createSingleDesktopRuntimeSessionPort(options, resumeSessionId, nextRuntimeEpoch);
    port.attachSessionSink?.((session) => {
      if (session !== undefined) {
        const snapshot = session.controller.publication()?.snapshot;
        const resident = snapshot === undefined ? undefined : residents.get(snapshot.sessionId);
        if (resident !== undefined) {
          resident.port = port;
          trackResidentPublication(resident, session);
          emitResidents();
        }
        rememberDisconnect(undefined);
        rememberUnavailable(undefined);
      }
      sessionSink?.(session);
    });
    return port;
  };

  const stopResident = async (resident: ResidentRuntime): Promise<void> => {
    await resident.port.stop();
    resident.unsubscribePublication?.();
    resident.unsubscribePublication = undefined;
    if (resident.heartbeatTimer !== undefined) clearInterval(resident.heartbeatTimer);
    resident.heartbeatTimer = undefined;
    if (resident.idleTimer !== undefined) clearTimeout(resident.idleTimer);
    resident.idleTimer = undefined;
    // The Worker is already gone; a leftover lease file only delays a future
    // takeover (stale after 30s) and must not wedge this resident in the map.
    // try/catch (not .catch): release() may throw synchronously.
    try {
      await resident.lease.release();
    } catch (error) {
      options.log?.write("warn", "runtime.worker.lease-release-failed", errorDetail(error));
    }
    residents.delete(resident.sessionId);
    if (activeSessionId === resident.sessionId) activeSessionId = undefined;
    emitResidents();
  };

  const stopAll = async (): Promise<void> => {
    const current = [...residents.values()];
    for (const resident of current) await stopResident(resident);
  };

  /** Residents spawned under one workspace, most recently selected first. */
  const residentsOfWorkspace = (workspaceId: string): ResidentRuntime[] =>
    [...residents.values()]
      .filter((resident) => resident.workspace.workspaceId === workspaceId)
      .sort((left, right) => right.lastSelected - left.lastSelected);

  const ensureCapacity = async (): Promise<void> => {
    if (maxResidentSessions === Number.POSITIVE_INFINITY) return;
    if (residents.size < maxResidentSessions) return;
    // Capacity admission must never stop an existing Runtime. A Runtime owns
    // the Bridge and its in-process Worker lifecycle; desktop-side eviction
    // would turn memory maintenance into a visible Runtime disconnect.
    throw new Error("Runtime worker capacity is exhausted; no Runtime Worker may be evicted");
  };

  /**
   * Spawn one Worker. `launchWorkspace` overrides the active project for
   * relaunches that must land back in the workspace the previous Worker was
   * bound to (lease loss, evacuation) — a Runtime cwd is fixed at spawn, so
   * reusing the active pointer there would silently migrate a Session.
   */
  const launchWorker = async (
    resumeSessionId?: string,
    launchWorkspace?: { workspaceId: string; cwd: string },
  ): Promise<DesktopRuntimeSession | undefined> => {
    const launchContext = context;
    const selected = launchWorkspace ?? workspace;
    if (launchContext === undefined || selected === undefined) {
      options.log?.write(
        "warn",
        "runtime.launch.skip",
        launchContext === undefined ? "no-context" : "no-workspace",
      );
      rememberUnavailable(
        unavailableFacts(
          selected === undefined ? "no-workspace" : "launch-failed",
          selected === undefined ? "no workspace is selected" : "runtime session context is not initialized",
        ),
      );
      return undefined;
    }
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
        rememberUnavailable(port.lastUnavailable?.() ?? unavailableFacts("launch-failed", "Runtime did not become ready"));
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
        workspace: selected,
        port,
        session,
        lease,
        lastSelected: 0,
        idleSince: undefined,
        lastActivityAt: new Date().toISOString(),
        lastCommitSeq: 0,
        unsubscribePublication: undefined,
        heartbeatTimer: undefined,
        idleTimer: undefined,
      };
      residents.set(snapshot.sessionId, resident);
      trackResidentPublication(resident, session);
      emitResidents();
      if (lease.heartbeat !== undefined) {
        resident.heartbeatTimer = setInterval(() => {
          void Promise.resolve(lease!.heartbeat!()).catch((error) => {
            options.log?.write("error", "runtime.worker.lease-lost", errorDetail(error));
            rememberDisconnect({ code: "lease-lost", reason: "session writer lease was lost" });
            void serialized(async () => {
              const sessionId = resident.sessionId;
              const wasActive = activeSessionId === sessionId;
              // Fence the dead writer before process shutdown/relaunch. Otherwise
              // the facade retains a stale Session whose hello/snapshot already
              // vanished, and Composer core.abort races into UNAVAILABLE.
              if (wasActive) {
                sessionSink?.(undefined);
                // Wake facade lifecycle observers immediately; process stop can
                // take seconds and must not leave a clickable stale snapshot.
                emitResidents();
              }
              await stopResident(resident);
              if (!wasActive) return;
              const next = await launchWorker(sessionId, resident.workspace);
              sessionSink?.(next);
            }).catch((error) => {
              options.log?.write("error", "runtime.worker.relaunch-failed", errorDetail(error));
            });
          });
        }, leaseHeartbeatIntervalMs);
        resident.heartbeatTimer.unref?.();
      }
      setActiveSession(snapshot.sessionId);
      options.log?.write("info", "runtime.worker.resident", `session=${snapshot.sessionId} count=${residents.size}`);
      rememberUnavailable(undefined);
      rememberDisconnect(undefined);
      // Re-sync a previously failed approval mode on activate/rebind
      // (plan §5.3.6): the fresh worker reads the persisted global mode from
      // disk; a non-persistent override keeps it aligned when persistence
      // failed or the sibling was out of sync.
      if (pendingApprovalMode !== undefined) {
        await synchronizeApprovalMode(pendingApprovalMode);
      }
      return session;
    } catch (error) {
      rememberUnavailable(port.lastUnavailable?.() ?? launchFailedFacts(error));
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
        // Resuming a Session of another project follows its Worker: the active
        // workspace moves with the selection so later `fresh` launches and
        // cwd-derived Host reads (catalog, archive) agree with the view.
        adoptWorkspace(existing.workspace);
        setActiveSession(sessionId);
        if (pendingApprovalMode !== undefined) {
          await synchronizeApprovalMode(pendingApprovalMode);
        }
        options.log?.write(
          "info",
          "runtime.worker.select",
          `session=${sessionId} resident=true workspace=${existing.workspace.workspaceId}`,
        );
        return existing.session;
      }
      // A dead resident is replaced in its own workspace, not the active one.
      const previousWorkspace = existing.workspace;
      await stopResident(existing);
      adoptWorkspace(previousWorkspace);
      return await launchWorker(sessionId, previousWorkspace);
    }
    return await launchWorker(sessionId);
  };

  function armIdleTimer(resident: ResidentRuntime): void {
    if (resident.idleTimer !== undefined) clearTimeout(resident.idleTimer);
    resident.idleTimer = undefined;
    resident.idleSince = undefined;
  }

  function setActiveSession(sessionId: string): void {
    const previous = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
    activeSessionId = sessionId;
    if (previous !== undefined && previous.sessionId !== sessionId) armIdleTimer(previous);
    const current = residents.get(sessionId);
    if (current !== undefined) {
      current.lastSelected = ++selection;
      current.lastActivityAt = new Date().toISOString();
      armIdleTimer(current);
    }
    emitResidents();
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
    const failedBackground: ResidentRuntime[] = [];
    const apply = async (resident: ResidentRuntime, persist: boolean): Promise<void> => {
      try {
        await invokePermissionMode(resident.session, mode, persist);
        appliedSessions += 1;
      } catch {
        failedSessions += 1;
        if (resident !== current) failedBackground.push(resident);
      }
    };
    // Re-run the complete resident set on every retry. Clearing a single
    // global pending value after only one Worker succeeded could otherwise
    // leave another resident on a stale, more permissive mode indefinitely.
    if (current !== undefined) {
      await apply(current, true);
      if (failedSessions > 0) {
        pendingApprovalMode = mode;
        return { mode, syncStatus: "partial", appliedSessions, failedSessions };
      }
    }
    for (const resident of residents.values()) {
      if (resident === current) continue;
      await apply(resident, false);
    }
    for (const resident of failedBackground) {
      options.log?.write(
        "warn",
        "runtime.approval-mode.stop-stale",
        `session=${resident.sessionId} mode=${mode}`,
      );
      await stopResident(resident);
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
          rememberUnavailable(unavailableFacts("no-workspace", "no workspace is selected"));
          return undefined;
        }
        const active = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
        if (active?.session !== undefined) {
          rememberUnavailable(undefined);
          return active.session;
        }
        return await launchWorker();
      });
    },
    stop(): Promise<void> {
      return serialized(stopAll);
    },
    hasResidentForWorkspace(workspaceId: string): boolean {
      return residentsOfWorkspace(workspaceId).some(
        (resident) => resident.session.hello() !== undefined,
      );
    },
    listResidents(): ResidentsReadModel {
      return structuredClone(listResidents());
    },
    attachResidentsSink(listener) {
      residentSinks.add(listener);
      try {
        listener(listResidents());
      } catch {
        // Isolate the initial projection delivery from the Runtime port.
      }
      return () => {
        residentSinks.delete(listener);
      };
    },
    rebind(next, input): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        // Opening another project must not disturb the Workers of the project
        // being left: they keep their Bridge, their lease and any running
        // turn. Switching back later re-selects a live Worker instead of
        // paying a cold start.
        adoptWorkspace(next);
        const resident = residentsOfWorkspace(next.workspaceId).find(
          (candidate) => candidate.session.hello() !== undefined,
        );
        if (resident !== undefined) {
          setActiveSession(resident.sessionId);
          rememberUnavailable(undefined);
          rememberDisconnect(undefined);
          if (pendingApprovalMode !== undefined) {
            await synchronizeApprovalMode(pendingApprovalMode);
          }
          options.log?.write(
            "info",
            "runtime.rebind.resident",
            `workspace=${next.workspaceId} session=${resident.sessionId} residents=${residents.size}`,
          );
          return resident.session;
        }
        // Drop a dead Worker of the target workspace before spawning, so a
        // stale entry cannot block the fresh identity.
        for (const stale of residentsOfWorkspace(next.workspaceId)) {
          await stopResident(stale);
        }
        if (input?.launchIfMissing === false) {
          const previous = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
          activeSessionId = undefined;
          if (previous !== undefined) {
            previous.idleSince = sessionIsIdle(previous.session) ? Date.now() : undefined;
            armIdleTimer(previous);
          }
          rememberUnavailable(undefined);
          rememberDisconnect(undefined);
          emitResidents();
          options.log?.write(
            "info",
            "runtime.rebind.dormant",
            `workspace=${next.workspaceId} residents=${residents.size}`,
          );
          return undefined;
        }
        options.log?.write(
          "info",
          "runtime.rebind.launch",
          `workspace=${next.workspaceId} residents=${residents.size}`,
        );
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
    isResident(sessionId: string): boolean {
      return residents.has(sessionId);
    },
    evacuateResident(sessionId: string): Promise<{ found: boolean; active?: DesktopRuntimeSession }> {
      return serialized(async () => {
        const resident = residents.get(sessionId);
        if (resident === undefined) return { found: false };
        const snapshot = resident.session.controller.publication()?.snapshot;
        // A crashed Worker keeps its last snapshot; only a live hello makes the
        // abort step meaningful. The stop below is the real fence either way.
        if (resident.session.hello() !== undefined && snapshot?.isStreaming === true) {
          const receipt = await resident.session.controller.invoke({
            type: "studio.request",
            requestId: randomUUID() as RequestId,
            runtimeEpoch: snapshot.runtimeEpoch,
            operation: { kind: "core.abort" },
          }).catch((error: unknown) => {
            options.log?.write("warn", "runtime.evacuate.abort-failed", `session=${sessionId} ${errorDetail(error)}`);
            return undefined;
          });
          if (receipt !== undefined && receipt.status !== "completed" && receipt.status !== "accepted") {
            options.log?.write(
              "warn",
              "runtime.evacuate.abort-rejected",
              `session=${sessionId} status=${receipt.status}`,
            );
          }
        }
        const wasActive = activeSessionId === sessionId;
        const evacuatedWorkspace = resident.workspace;
        if (!wasActive) {
          await stopResident(resident);
          return { found: true };
        }
        const endBatch = batchResidentPublications();
        // Detach the Facade from the retiring controller before its orderly
        // Bridge close publishes runtimeLost. The final resident publication
        // is held until the replacement is already bound, so Clients observe
        // connected(old) -> connected(new), never a false disconnected gap.
        sessionSink?.(undefined);
        try {
          await stopResident(resident);
          adoptWorkspace(evacuatedWorkspace);
          const active = await launchWorker(undefined, evacuatedWorkspace);
          sessionSink?.(active);
          return active === undefined ? { found: true } : { found: true, active };
        } finally {
          endBatch();
        }
      });
    },
    lastUnavailable() {
      return lastUnavailable;
    },
    lastDisconnect() {
      const active = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
      return lastDisconnect ?? active?.port.lastDisconnect?.();
    },
    ensure(input?: { force?: boolean }): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        const active = activeSessionId === undefined ? undefined : residents.get(activeSessionId);
        const force = input?.force === true;
        if (!force && active?.session.hello() !== undefined) {
          rememberUnavailable(undefined);
          rememberDisconnect(undefined);
          return active.session;
        }
        const resumeId = active?.sessionId;
        const activeWorkspace = active?.workspace;
        if (active !== undefined) await stopResident(active);
        const next = await launchWorker(resumeId, activeWorkspace);
        sessionSink?.(next);
        return next;
      });
    },
    attachSessionSink(listener) {
      sessionSink = listener;
    },
    attachWorkspaceSink(listener) {
      workspaceSinks.add(listener);
      return () => {
        workspaceSinks.delete(listener);
      };
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
  let lastUnavailable: HostRuntimeUnavailable | undefined;
  let lastDisconnect: HostRuntimeDisconnect | undefined;
  let lastExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let sessionSink: ((session: DesktopRuntimeSession | undefined) => void) | undefined;
  let stopping = false;
  let draining = false;
  let autoRespawns = 0;
  let respawnScheduledFor = 0;

  const rememberUnavailable = (facts: HostRuntimeUnavailable | undefined): void => {
    lastUnavailable = facts;
  };

  const rememberDisconnect = (facts: HostRuntimeDisconnect | undefined): void => {
    lastDisconnect = facts === undefined ? undefined : {
      code: facts.code,
      reason: redactText(facts.reason),
      occurredAt: facts.occurredAt ?? lastDisconnect?.occurredAt ?? new Date().toISOString(),
      ...(facts.autoRespawn === undefined ? {} : { autoRespawn: facts.autoRespawn }),
    };
  };

  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = queue.then(op, op);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function scheduleAutoRespawn(fromGeneration: number): void {
    const limit = options.autoRespawnLimit ?? 1;
    if (stopping || draining || limit <= 0) {
      if (lastDisconnect !== undefined && lastDisconnect.autoRespawn === undefined) {
        rememberDisconnect({ ...lastDisconnect, autoRespawn: "exhausted" });
      }
      return;
    }
    if (respawnScheduledFor === fromGeneration) return;
    if (autoRespawns >= limit) {
      if (lastDisconnect !== undefined) rememberDisconnect({ ...lastDisconnect, autoRespawn: "exhausted" });
      return;
    }
    respawnScheduledFor = fromGeneration;
    autoRespawns += 1;
    if (lastDisconnect !== undefined) rememberDisconnect({ ...lastDisconnect, autoRespawn: "scheduled" });
    const delay = options.autoRespawnDelayMs ?? 500;
    log?.write("warn", "runtime.respawn.schedule", `generation=${fromGeneration} attempt=${autoRespawns}`);
    const timer = setTimeout(() => {
      void serialized(async () => {
        if (stopping || fromGeneration !== generation) return;
        if (alive && bundle?.hello() !== undefined) return;

        // A backgrounded Windows window can lose the named-pipe connection
        // while the Runtime process is still alive. Reattach the existing
        // Bridge first; restarting the process would tear down its in-process
        // workers and incorrectly turn a transport hiccup into a Runtime
        // restart. Only fall back to a cold launch when the Runtime itself is
        // no longer reachable.
        const currentBridge = bridge;
        const currentBundle = bundle;
        if (currentBridge !== undefined && currentBundle !== undefined && currentBridge.state === "disconnected") {
          try {
            await currentBridge.reconnect();
            alive = true;
            await currentBundle.controller.refresh();
            rememberUnavailable(undefined);
            rememberDisconnect(undefined);
            autoRespawns = 0;
            log?.write("info", "runtime.reconnect.ok", `generation=${generation}`);
            sessionSink?.(currentBundle);
            return;
          } catch (error) {
            alive = false;
            log?.write("warn", "runtime.reconnect.fail", errorDetail(error));
          }
        }

        await stopCurrent("replace");
        const next = await launch();
        if (next !== undefined) {
          autoRespawns = 0;
        } else if (lastDisconnect !== undefined) {
          rememberDisconnect({ ...lastDisconnect, autoRespawn: autoRespawns >= (options.autoRespawnLimit ?? 1) ? "exhausted" : "failed" });
        }
        sessionSink?.(next);
      }).catch((error) => {
        if (lastDisconnect !== undefined) rememberDisconnect({ ...lastDisconnect, autoRespawn: "failed" });
        sessionSink?.(undefined);
        log?.write("error", "runtime.respawn.fail", errorDetail(error));
      });
    }, delay);
    timer.unref?.();
  }

  function noteUnexpectedLoss(preferred: HostRuntimeDisconnect): void {
    if (stopping || draining) return;
    if (lastExit !== undefined) {
      rememberDisconnect({
        code: "process-exit",
        reason: `Runtime process exited (code=${lastExit.code ?? "null"}, signal=${lastExit.signal ?? "none"})`,
      });
    } else if (lastDisconnect === undefined || lastDisconnect.code === "pipe-closed") {
      rememberDisconnect(preferred);
    }
    scheduleAutoRespawn(generation);
  }

  async function stopCurrent(reason: "host-stop" | "replace" = "replace"): Promise<void> {
    draining = true;
    if (reason === "host-stop") {
      stopping = true;
      rememberDisconnect({ code: "host-stop", reason: "Host stopped the Runtime" });
    }
    log?.write(
      "info",
      "runtime.stop",
      `generation=${generation} hadSession=${bundle !== undefined} alive=${alive} reason=${reason}`,
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
    draining = false;
  }

  async function launch(): Promise<DesktopRuntimeSession | undefined> {
    const selected = workspace;
    const launchContext = context;
    if (selected === undefined || launchContext === undefined) {
      log?.write("info", "runtime.launch.skip", "no-workspace");
      rememberUnavailable(unavailableFacts("no-workspace", "no workspace is selected"));
      return undefined;
    }
    if (launchContext.resolution.classification === "rejected") {
      log?.write("warn", "runtime.launch.skip", "resolution-rejected");
      rememberUnavailable(
        unavailableFacts(
          "resolution-rejected",
          launchContext.resolution.rejectionReason ?? "runtime probe rejected the executable",
        ),
      );
      return undefined;
    }
    if (!(await isUsableWorkspaceDirectory(selected.cwd))) {
      log?.write("warn", "runtime.launch.skip", "workspace-unusable");
      rememberUnavailable(unavailableFacts("workspace-unusable", "workspace directory is unusable"));
      return undefined;
    }
    const backend = new HostBackend({
      stateDirectory: launchContext.profileDirectory,
      runtimeInstallDirectory:
        launchContext.runtimeInstallDirectory ?? join(launchContext.profileDirectory, "runtimes"),
      ...(launchContext.installer === undefined ? {} : { installer: launchContext.installer }),
    });
    await backend.initialize();
    const installed = await backend.installer.currentManifest();
    if (installed === undefined) {
      log?.write("warn", "runtime.launch.skip", "no-managed-install");
      rememberUnavailable(unavailableFacts("not-installed", "managed runtime is not installed"));
      return undefined;
    }

    const launchGeneration = ++generation;
    lastExit = undefined;
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
        if (!stopping && !draining) {
          noteUnexpectedLoss({ code: "pipe-closed", reason: "Studio Bridge pipe closed" });
        }
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
            lastExit = { code, signal };
            log?.write(
              becameReady && launchGeneration === generation ? "error" : "info",
              "runtime.process.exit",
              `generation=${launchGeneration} code=${code} signal=${signal ?? "none"} afterReady=${becameReady}`,
            );
            if (becameReady && launchGeneration === generation && !stopping && !draining) {
              alive = false;
              noteUnexpectedLoss({
                code: "process-exit",
                reason: `Runtime process exited (code=${code ?? "null"}, signal=${signal ?? "none"})`,
              });
            }
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
      rememberUnavailable(undefined);
      rememberDisconnect(undefined);
      lastExit = undefined;
      autoRespawns = 0;
      stopping = false;
      return session;
    } catch (error) {
      log?.write("error", "runtime.launch.fail", `generation=${launchGeneration} ${errorDetail(error)}`);
      rememberUnavailable(classifyLaunchFailure(error));
      await stopCurrent("replace");
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
          rememberUnavailable(unavailableFacts("no-workspace", "no workspace is selected"));
          return undefined;
        }
        return await launch();
      });
    },

    stop(): Promise<void> {
      return serialized(() => stopCurrent("host-stop"));
    },

    rebind(next: { workspaceId: string; cwd: string }): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        log?.write("info", "runtime.rebind", `generation=${generation}`);
        stopping = false;
        await stopCurrent("replace");
        resumeSessionId = undefined;
        workspace = next;
        return await launch();
      });
    },

    switchSession(intent: { kind: "resume"; sessionId: string } | { kind: "fresh" }): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        const previousResume = resumeSessionId;
        log?.write("info", "runtime.switch.begin", `kind=${intent.kind} generation=${generation}`);
        stopping = false;
        await stopCurrent("replace");
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
          await stopCurrent("replace");
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
    lastUnavailable() {
      return lastUnavailable;
    },
    lastDisconnect() {
      return lastDisconnect;
    },
    isResident(sessionId: string): boolean {
      return bundle?.controller.publication()?.snapshot?.sessionId === sessionId;
    },
    evacuateResident(sessionId: string): Promise<{ found: boolean; active?: DesktopRuntimeSession }> {
      return serialized(async () => {
        const snapshot = bundle?.controller.publication()?.snapshot;
        if (snapshot === undefined || snapshot.sessionId !== sessionId || bundle === undefined) {
          return { found: false };
        }
        // Only a live hello makes the abort step meaningful; the stop below is
        // the real fence either way, so a failed abort must not block it.
        if (bundle.hello() !== undefined && snapshot.isStreaming) {
          const receipt = await bundle.controller.invoke({
            type: "studio.request",
            requestId: randomUUID() as RequestId,
            runtimeEpoch: snapshot.runtimeEpoch,
            operation: { kind: "core.abort" },
          }).catch((error: unknown) => {
            log?.write("warn", "runtime.evacuate.abort-failed", `session=${sessionId} ${errorDetail(error)}`);
            return undefined;
          });
          if (receipt !== undefined && receipt.status !== "completed" && receipt.status !== "accepted") {
            log?.write("warn", "runtime.evacuate.abort-rejected", `session=${sessionId} status=${receipt.status}`);
          }
        }
        stopping = false;
        await stopCurrent("replace");
        const active = await launch();
        sessionSink?.(active);
        return active === undefined ? { found: true } : { found: true, active };
      });
    },
    ensure(input?: { force?: boolean }): Promise<DesktopRuntimeSession | undefined> {
      return serialized(async () => {
        const force = input?.force === true;
        if (!force && alive && bundle?.hello() !== undefined) {
          rememberUnavailable(undefined);
          rememberDisconnect(undefined);
          return bundle;
        }
        stopping = false;
        await stopCurrent("replace");
        const next = await launch();
        if (next !== undefined) autoRespawns = 0;
        sessionSink?.(next);
        return next;
      });
    },
    attachSessionSink(listener) {
      sessionSink = listener;
    },
  };
}

function attachRuntimeOutput(child: ChildProcess, log: HostLog | undefined): void {
  if (log === undefined) {
    // stderr is spawned as a pipe, so an unread stream buffers inside Node
    // without bound. Nothing to log it into means it still has to be drained.
    child.stdout?.resume();
    child.stderr?.resume();
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
    snapshot.activeCommandIds.length === 0 &&
    snapshot.pendingInteraction === undefined &&
    snapshot.plan?.status !== "review"
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function unavailableFacts(code: RuntimeUnavailableCode, reason: string): HostRuntimeUnavailable {
  return { code, reason: redactText(reason) };
}

function classifyLaunchFailure(error: unknown): HostRuntimeUnavailable {
  if (error instanceof StudioBridgeHandshakeError && error.code === "HANDSHAKE_TIMEOUT") {
    return unavailableFacts("handshake-timeout", error.message);
  }
  const message = errorDetail(error);
  if (/exited before ready/iu.test(message)) {
    return unavailableFacts("exited-before-ready", message);
  }
  const code =
    error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "ENOENT" || /spawn .*ENOENT/iu.test(message)) {
    return unavailableFacts("spawn-failed", message);
  }
  return unavailableFacts("launch-failed", message);
}

export { classifyLaunchFailure };

function launchFailedFacts(error: unknown): HostRuntimeUnavailable {
  return classifyLaunchFailure(error);
}
