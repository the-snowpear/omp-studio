/**
 * Desktop semantic commands: session.create / session.resume / session.drop / interaction.respond
 * and P4 invoke that forwards the client requestId.
 */

import { randomUUID } from "node:crypto";

import type {
  HostCatalogEntry,
  HostSemanticCommandService,
  HostSessionCatalogProvider,
} from "@omp-studio/host-client-api";
import { threadIdFor, formatRuntimeMissingMessage, type HostRuntimeDisconnect, type HostRuntimeUnavailable } from "@omp-studio/host-client-api";
import { scanSessionCatalog, StudioHostError, removeSessionPin, type StudioSessionArchiveService, type StudioSessionDeleteService } from "@omp-studio/studio-host";
import type { ApprovalMode, RequestId, StudioOperation, ThreadId } from "@omp-studio/studio-protocol";
import type {
  ConfigWriteResult,
  StudioPlanSaveAndQuitResult,
  StudioRuntimeSettingsGetResult,
  StudioRuntimeSettingsSetResult,
  WorkspaceId,
} from "@omp-studio/client-contract";

import type { DesktopRuntimeSession, DesktopRuntimeSessionPort } from "./host-composition.js";
import type { DesktopInteractionHost } from "./interaction-host.js";

/**
 * Commands issued against a live turn. Conversation events bump `stateVersion`
 * on every completed message/tool, so fencing abort/steer/pause on the Host's
 * last snapshot races the stream and the Runtime rejects with
 * STATE_VERSION_CONFLICT.
 */
const LIVE_TURN_OPERATION_KINDS = new Set<StudioOperation["kind"]>([
  // A prompt starts a turn from the Runtime's current state. Session creation
  // and the first state projection can advance the version between the Host
  // snapshot read and dispatch, so fencing it creates a false first-send
  // conflict. Runtime epoch and its own busy/lease guards remain authoritative.
  "core.prompt",
  "core.abort",
  "core.steer",
  "core.followUp",
  "queue.enqueue",
  "runtime.pause",
  "runtime.resume",
  "session.model.set",
  "session.thinking.set",
  "session.taskModel.set",
  "mode.plan.enter",
  "mode.plan.exit",
  "mode.vibe.enter",
  "mode.vibe.exit",
  "goal.create",
  "goal.drop",
  "loop.enable",
  "loop.disable",
  "session.fast.set",
  "session.prewalk.arm",
  "session.prewalk.disarm",
  "permissions.mode.set",
  // BTW runs beside the main turn by design, so a snapshot-derived
  // `expectedStateVersion` would collide with every streaming delta. The
  // Runtime's own single-slot guards (BUSY_STREAMING / INTERACTION_STALE)
  // already express the real preconditions and give better error text.
  "btw.ask",
  "btw.abort",
  "btw.branch",
  // Subagent / job ops run beside the parent turn (Inspect, Hub chat,
  // kill while a task tool is in flight). Same fence race as BTW.
  "agent.list",
  "agent.get",
  "agent.spawn",
  "agent.send",
  "agent.kill",
  "agent.revive",
  "agent.release",
  "agent.transcript.read",
  "agent.subscribe",
  "job.list",
  "job.get",
  "job.cancel",
  "job.subscribe",
]);

export function fencesOnStateVersion(kind: StudioOperation["kind"]): boolean {
  return !LIVE_TURN_OPERATION_KINDS.has(kind);
}

export function createWorkspaceSessionCatalog(
  getCwd: () => string | undefined,
  resolveWorkspaceCwd?: (workspaceId: WorkspaceId) => string | undefined | Promise<string | undefined>,
): HostSessionCatalogProvider {
  // Bootstrap, the expanded sidebar project and title reconciliation can ask
  // for the same workspace simultaneously. One scan already walks the global
  // OMP sessions tree, so duplicate scans only add Main-process/FS pressure.
  const scans = new Map<string, Promise<HostCatalogEntry[]>>();
  const scan = (cwd: string): Promise<HostCatalogEntry[]> => {
    const key = process.platform === "win32" ? cwd.toLowerCase() : cwd;
    const existing = scans.get(key);
    if (existing !== undefined) return existing;
    const pending = scanSessionCatalog({ includeCliSessions: true, allowedCwd: cwd })
      .then((result) => result.sessions.map((entry) => ({
        sessionId: entry.sessionId,
        modifiedAt: entry.modifiedAt,
        messageCount: 0,
        status: (entry.archived ? "archived" : "active") as HostCatalogEntry["status"],
        origin: entry.origin,
        pinned: entry.pinned,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      })))
      .finally(() => {
        scans.delete(key);
      });
    scans.set(key, pending);
    return pending;
  };
  return {
    async list(input?: { readonly workspaceId?: WorkspaceId }): Promise<HostCatalogEntry[]> {
      let cwd: string | undefined;
      if (input?.workspaceId !== undefined) {
        if (resolveWorkspaceCwd === undefined) {
          throw new StudioHostError("INVALID_ARGUMENT", "History workspace is not available on this Host");
        }
        cwd = await resolveWorkspaceCwd(input.workspaceId);
        if (cwd === undefined) {
          throw new StudioHostError("INVALID_ARGUMENT", "Unknown workspace id");
        }
      } else {
        cwd = getCwd();
      }
      if (cwd === undefined) return [];
      return (await scan(cwd)).map((entry) => ({ ...entry }));
    },
  };
}

export function createDesktopSemanticCommands(options: {
  readonly sessionRef: { current: DesktopRuntimeSession | undefined };
  readonly catalog: HostSessionCatalogProvider;
  readonly resolveResidentSessionId?: (threadId: ThreadId) => string | undefined;
  /** Lazy factory: the archive service is rebuilt when the workspace changes. */
  readonly archive?: () => StudioSessionArchiveService;
  /** Lazy factory: the delete service is rebuilt when the workspace changes. */
  readonly deleteService?: () => StudioSessionDeleteService;
  /** Lazy telemetry store so deleted sessions leave no telemetry record. */
  readonly telemetryStore?: () => { readonly remove?: (sessionId: string) => Promise<void> | void };
  /** Thread -> Runtime binding registry; the deleted thread's entry is removed. */
  readonly bindings?: { readonly unbind: (threadId: ThreadId) => Promise<void> | void };
  /** Durable session-lease store; stale lease files are removed with the session. */
  readonly leaseStore?: { readonly removeForSession: (sessionId: string) => Promise<void> | void };
  /** Resolves the OMP agent dir holding the global pin file. */
  readonly agentDir?: () => string;
  readonly switchSession?: DesktopRuntimeSessionPort["switchSession"];
  readonly applyApprovalMode?: DesktopRuntimeSessionPort["applyApprovalMode"];
  readonly evacuateResident?: DesktopRuntimeSessionPort["evacuateResident"];
  readonly supportsConcurrentSessions?: boolean;
  readonly bindSession: (session: DesktopRuntimeSession | undefined) => void;
  readonly interaction: DesktopInteractionHost;
  /**
   * Cold-start / read-only recovery: spawn the managed Runtime when
   * `switchSession` cannot because `start` never ran (rejected probe, no
   * workspace at boot, or a swallowed start failure).
   */
  readonly ensureRuntime?: () => Promise<DesktopRuntimeSession | undefined>;
  /** Last skip/fail or drop facts for CAPABILITY_UNAVAILABLE copy. */
  readonly runtimeMissing?: () => {
    readonly unavailable?: HostRuntimeUnavailable;
    readonly disconnect?: HostRuntimeDisconnect;
  };
}): HostSemanticCommandService {
  const archiveFactory = options.archive;
  const missingRuntime = (fallback: string): StudioHostError => {
    const facts = options.runtimeMissing?.();
    const message = formatRuntimeMissingMessage(facts ?? {});
    return new StudioHostError("CAPABILITY_UNAVAILABLE", message === "Runtime is not available" ? fallback : message);
  };
  return {
    ...(archiveFactory === undefined
      ? {}
      : {
          archive: async ({ threadId }: { readonly threadId: ThreadId }): Promise<ConfigWriteResult> => {
            const sessionId = await resolveCatalogSessionId(options, threadId);
            const releasedWriter = await releaseResidentSession(options, sessionId);
            // Studio-origin sessions are written only by the managed Runtime
            // broker. If that broker has no resident writer (or just evacuated
            // one), a recent mtime is a completed/title flush rather than an
            // unknown crash tail. CLI/unknown sessions keep the full grace.
            const discovered = (await options.catalog.list()).find((entry) => entry.sessionId === sessionId);
            const skipWriteGrace = releasedWriter || discovered?.origin === "studio";
            try {
              await archiveFactory().archive(sessionId, { skipWriteGrace });
            } catch (error) {
              // A duplicate/stale UI request after a successful move is
              // idempotent at the product command boundary.
              if ((error as { readonly code?: string })?.code !== "SESSION_ALREADY_ARCHIVED") throw error;
            }
            return { applied: true, runtimeEffect: "immediate", message: "Session archived to the OMP cold archive" };
          },
          unarchive: async ({ threadId }: { readonly threadId: ThreadId }): Promise<ConfigWriteResult> => {
            const sessionId = await resolveCatalogSessionId(options, threadId);
            await archiveFactory().unarchive(sessionId);
            return { applied: true, runtimeEffect: "immediate", message: "Session restored from the archive" };
          },
        }),
    delete: async ({ threadId }: { readonly threadId: ThreadId }): Promise<ConfigWriteResult> => {
      if (options.deleteService === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Session deletion is not available on this Host");
      }
      const sessionId = await resolveCatalogSessionId(options, threadId);
      // Abort a streaming turn and switch the Runtime off this file so the
      // transcript can be removed while no Worker holds it.
      await releaseResidentSession(options, sessionId);
      await options.deleteService().delete(sessionId);
      // Best-effort residue cleanup: the transcript/artifacts are the primary
      // object; a failing related-record removal must not fail the delete.
      await Promise.resolve(options.telemetryStore?.().remove?.(sessionId)).catch(() => undefined);
      await Promise.resolve(options.bindings?.unbind(threadId)).catch(() => undefined);
      await Promise.resolve(options.leaseStore?.removeForSession(sessionId)).catch(() => undefined);
      if (options.agentDir !== undefined) {
        await Promise.resolve(removeSessionPin(sessionId, options.agentDir())).catch(() => undefined);
      }
      return { applied: true, runtimeEffect: "immediate", message: "Session deleted" };
    },
    create: async () => {
      if (options.switchSession === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Fresh Runtime sessions are not available");
      }
      let next = await options.switchSession({ kind: "fresh" });
      if (next?.controller.publication()?.snapshot === undefined && options.ensureRuntime !== undefined) {
        next = (await options.ensureRuntime()) ?? next;
      }
      options.bindSession(next);
      const created = next?.controller.publication()?.snapshot;
      if (created === undefined) {
        throw missingRuntime("Runtime is not available");
      }
      return created;
    },
    resume: async ({ threadId }) => {
      const target = await resolveCatalogSessionId(options, threadId);
      const snapshot = options.sessionRef.current?.controller.publication()?.snapshot;
      if (snapshot !== undefined) {
        if (snapshot.isStreaming && options.supportsConcurrentSessions !== true) {
          throw new StudioHostError("BUSY_STREAMING", "Cannot resume while the Runtime is streaming");
        }
        if (snapshot.sessionId === target) {
          return snapshot;
        }
      }
      if (options.switchSession === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime session switching is not available");
      }
      const next = await options.switchSession({ kind: "resume", sessionId: target });
      let restoredSession = next;
      if (next?.controller.publication()?.snapshot === undefined && options.ensureRuntime !== undefined) {
        await options.ensureRuntime();
        restoredSession = (await options.switchSession({ kind: "resume", sessionId: target })) ?? next;
      }
      options.bindSession(restoredSession);
      const restored = restoredSession?.controller.publication()?.snapshot;
      if (restored === undefined) {
        throw missingRuntime("Runtime is not available");
      }
      if (restored.sessionId !== target) {
        throw new StudioHostError("INTERNAL_ERROR", "Session resume failed; the previous session was kept when possible");
      }
      return restored;
    },
    drop: async ({ threadId, requestId }) => {
      const session = options.sessionRef.current;
      if (session === undefined) {
        throw missingRuntime("Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw missingRuntime("Runtime snapshot is unavailable");
      }
      const target = await resolveCatalogSessionId(options, threadId);
      if (snapshot.sessionId !== target) {
        throw new StudioHostError("INVALID_ARGUMENT", "session.drop only applies to the current session");
      }
      const receipt = await session.controller.invoke({
        type: "studio.request",
        requestId: requestId as unknown as RequestId,
        runtimeEpoch: snapshot.runtimeEpoch,
        expectedStateVersion: snapshot.stateVersion,
        operation: { kind: "session.drop" },
      });
      throwIfNotCompleted(receipt);
      return session.controller.publication()?.snapshot ?? snapshot;
    },
    respond: async (input) => {
      const session = options.sessionRef.current;
      if (session === undefined) {
        throw missingRuntime("Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      if (snapshot === undefined) {
        throw missingRuntime("Runtime snapshot is unavailable");
      }
      await options.interaction.respond(input);
      return session.controller.publication()?.snapshot ?? snapshot;
    },
    setApprovalMode: async ({ mode }) => {
      // Session-exclusive (plan §5.4): accepted during a live turn. Runtime
      // projects the new mode immediately and writes tools.approvalMode on
      // the next user turn so in-flight tools keep the previous trust level.
      const session = options.sessionRef.current;
      if (session === undefined) {
        throw missingRuntime("Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw missingRuntime("Runtime snapshot is unavailable");
      }
      if (options.applyApprovalMode === undefined) {
        throw new StudioHostError(
          "CAPABILITY_UNAVAILABLE",
          "Approval mode sync is not available on this Host composition",
        );
      }
      return await options.applyApprovalMode(mode as ApprovalMode);
    },
    invoke: async (operation: StudioOperation, requestId?) => {
      if (requestId === undefined || requestId.length === 0) {
        throw new StudioHostError("INVALID_ARGUMENT", "Runtime invoke requires the client requestId");
      }
      const session = options.sessionRef.current;
      if (session === undefined) {
        throw missingRuntime("Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw missingRuntime("Runtime snapshot is unavailable");
      }
      const receipt = await session.controller.invoke({
        type: "studio.request",
        requestId: requestId as unknown as RequestId,
        runtimeEpoch: snapshot.runtimeEpoch,
        ...(fencesOnStateVersion(operation.kind) ? { expectedStateVersion: snapshot.stateVersion } : {}),
        operation,
      });
      throwIfNotCompleted(receipt);
      const latest = session.controller.publication()?.snapshot ?? snapshot;
      if (operation.kind === "operator.invoke") {
        // The Runtime returns { output, result } for operator commands; carry
        // it beside the post-command snapshot so the Renderer can surface
        // real command feedback (e.g. the /export target path).
        const carried = (receipt.result ?? {}) as { output?: unknown; result?: unknown };
        const output = Array.isArray(carried.output) ? carried.output.filter((line): line is string => typeof line === "string") : [];
        return {
          snapshot: latest,
          output,
          result: carried.result ?? { consumed: true },
        };
      }
      if (operation.kind === "session.tree.navigate" || operation.kind === "session.tree.branch") {
        // Keep the Runtime editor fill-back (text + images) next to the
        // snapshot. Other P4 commands stay snapshot-only so callers such as
        // session.fork waitReceipt<OperatorStateSnapshot> keep working.
        return {
          ...((receipt.result ?? {}) as object),
          snapshot: latest,
        };
      }
      if (operation.kind === "btw.ask") {
        // `branchToken` exists only here: it is never republished on
        // `btw.changed`, so losing it means the answer can no longer be
        // branched even though it completed.
        const carried = (receipt.result ?? {}) as { ephemeralId?: unknown; branchToken?: unknown };
        if (typeof carried.ephemeralId !== "string" || typeof carried.branchToken !== "string") {
          throw new StudioHostError("INTERNAL_ERROR", "Runtime did not return a BTW authorization");
        }
        return {
          snapshot: latest,
          ephemeralId: carried.ephemeralId,
          branchToken: carried.branchToken,
          status: "running" as const,
        };
      }
      if (operation.kind === "btw.branch") {
        const carried = (receipt.result ?? {}) as {
          branched?: unknown;
          newSessionId?: unknown;
          newLeafId?: unknown;
          reason?: unknown;
        };
        return {
          snapshot: latest,
          branched: carried.branched === true,
          ...(typeof carried.newSessionId === "string" ? { newSessionId: carried.newSessionId } : {}),
          // The Runtime reports a leaf-less branch as null; the contract omits
          // the field instead of carrying a nullable id to the Renderer.
          ...(typeof carried.newLeafId === "string" ? { newLeafId: carried.newLeafId } : {}),
          ...(typeof carried.reason === "string" ? { reason: carried.reason } : {}),
        };
      }
      if (operation.kind === "runtime.settings.get") {
        if (receipt.result === undefined || receipt.result === null || typeof receipt.result !== "object" || Array.isArray(receipt.result)) {
          throw new StudioHostError("INTERNAL_ERROR", "Runtime did not return runtime settings");
        }
        return receipt.result as StudioRuntimeSettingsGetResult;
      }
      if (operation.kind === "runtime.settings.set") {
        if (receipt.result === undefined || receipt.result === null || typeof receipt.result !== "object" || Array.isArray(receipt.result)) {
          throw new StudioHostError("INTERNAL_ERROR", "Runtime did not return the updated runtime setting");
        }
        return receipt.result as StudioRuntimeSettingsSetResult;
      }
      if (operation.kind === "mode.plan.review.saveAndQuit") {
        if (receipt.result === undefined || receipt.result === null || typeof receipt.result !== "object" || Array.isArray(receipt.result)) {
          throw new StudioHostError("INTERNAL_ERROR", "Runtime did not return the plan save result");
        }
        return receipt.result as StudioPlanSaveAndQuitResult;
      }
      return latest;
    },
  };
}

/**
 * A live Runtime holds the session file open. Abort a streaming turn, then
 * switch to a fresh session so the cold-archive move can take the file.
 * Returns true when the writer was just stopped (skip the crash-tail grace).
 */
async function releaseResidentSession(
  options: {
    readonly sessionRef: { current: DesktopRuntimeSession | undefined };
    readonly switchSession?: DesktopRuntimeSessionPort["switchSession"];
    readonly evacuateResident?: DesktopRuntimeSessionPort["evacuateResident"];
    readonly bindSession: (session: DesktopRuntimeSession | undefined) => void;
  },
  sessionId: string,
): Promise<boolean> {
  if (options.evacuateResident !== undefined) {
    const result = await options.evacuateResident(sessionId);
    if (!result.found) return false;
    if (result.active !== undefined) options.bindSession(result.active);
    return true;
  }
  const session = options.sessionRef.current;
  const snapshot = session?.controller.publication()?.snapshot;
  if (session === undefined || snapshot === undefined || snapshot.sessionId !== sessionId) return false;
  if (snapshot.isStreaming) {
    const receipt = await session.controller.invoke({
      type: "studio.request",
      requestId: randomUUID() as RequestId,
      runtimeEpoch: snapshot.runtimeEpoch,
      operation: { kind: "core.abort" },
    });
    throwIfNotCompleted(receipt);
  }
  if (options.switchSession === undefined) {
    throw new StudioHostError("COMMAND_BLOCKED", "Session is resident in a Runtime and cannot be moved");
  }
  const next = await options.switchSession({ kind: "fresh" });
  options.bindSession(next);
  const nextId = next?.controller.publication()?.snapshot?.sessionId;
  if (nextId === sessionId) {
    throw new StudioHostError("COMMAND_BLOCKED", "无法离开当前会话，归档已取消");
  }
  return true;
}

async function resolveCatalogSessionId(
  options: {
    readonly catalog: HostSessionCatalogProvider;
    readonly sessionRef?: { current: DesktopRuntimeSession | undefined };
    readonly resolveResidentSessionId?: (threadId: ThreadId) => string | undefined;
  },
  threadId: ThreadId,
): Promise<string> {
  const activeSessionId = options.sessionRef?.current?.controller.publication()?.snapshot?.sessionId;
  if (activeSessionId !== undefined && threadIdFor(activeSessionId) === threadId) {
    return activeSessionId;
  }
  const residentSessionId = options.resolveResidentSessionId?.(threadId);
  if (residentSessionId !== undefined) {
    return residentSessionId;
  }
  const entries = await options.catalog.list();
  const match = entries.find((entry) => threadIdFor(entry.sessionId) === threadId);
  if (match === undefined) {
    throw new StudioHostError("INVALID_ARGUMENT", "Session is not available in this workspace");
  }
  return match.sessionId;
}

function throwIfNotCompleted(receipt: { readonly status: string; readonly error?: { readonly code?: string; readonly message?: string } }): void {
  if (receipt.status === "completed") return;
  if (receipt.status === "outcome_unknown") {
    throw new StudioHostError("OUTCOME_UNKNOWN", receipt.error?.message ?? "Runtime command outcome is unknown");
  }
  const code = receipt.error?.code;
  if (code === "STATE_VERSION_CONFLICT") {
    throw new StudioHostError("STATE_VERSION_CONFLICT", receipt.error?.message ?? "state version conflict");
  }
  if (code === "RUNTIME_EPOCH_STALE") {
    throw new StudioHostError("RUNTIME_EPOCH_STALE", receipt.error?.message ?? "runtime epoch is stale");
  }
  if (code === "CAPABILITY_UNAVAILABLE") {
    throw new StudioHostError("CAPABILITY_UNAVAILABLE", receipt.error?.message ?? "runtime capability is unavailable");
  }
  if (code === "COMMAND_BLOCKED") {
    throw new StudioHostError("COMMAND_BLOCKED", receipt.error?.message ?? "a conflicting command is active");
  }
  if (code === "INVALID_ARGUMENT" || receipt.status === "rejected") {
    throw new StudioHostError("INVALID_ARGUMENT", receipt.error?.message ?? "Runtime rejected the request");
  }
  throw new StudioHostError("INTERNAL_ERROR", receipt.error?.message ?? `Runtime command ${receipt.status}`);
}
