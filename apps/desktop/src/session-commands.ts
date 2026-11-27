import { type SessionWorktreeRow, type SessionResumePreparation } from "@omp-studio/studio-protocol";
import { type PortableExport, type SessionPortabilityStatus } from "@omp-studio/studio-protocol";
import { type SessionExportResult, type SessionExportStatus } from "@omp-studio/studio-protocol";
import { mediaInputArtifacts, type MediaDetail, isWorkbenchOperationKind, WORKBENCH_OPERATION_KINDS, isUpgradeOperationKind, UPGRADE_OPERATION_KINDS } from "@omp-studio/studio-protocol";
import { type QueueTakeback } from "@omp-studio/studio-protocol";
import type { RuntimeMediaFiles } from "./runtime-media-files.js";
import { isEvaluationOperationKind, isModelServicesKind, MODEL_SERVICES_COMMAND_KINDS, type ModelServicesCommandResultMap } from "@omp-studio/studio-protocol";
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
import { desktopText } from "./desktop-language-shared.js";
import { scanSessionCatalog, SessionDeleteServiceError, StudioHostError, removeSessionPin, type StudioSessionArchiveService, type StudioSessionDeleteService } from "@omp-studio/studio-host";
import type { SessionCatalogEntry, StoredWorkspace } from "@omp-studio/studio-host";
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
  "session.fork",
  "session.tree.branch",
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
  "session.prewalk.restart",
  "permissions.mode.set",
  // BTW runs beside the main turn by design, so a snapshot-derived
  // `expectedStateVersion` would collide with every streaming delta. The
  // Runtime's own single-slot guards (BUSY_STREAMING / INTERACTION_STALE)
  // already express the real preconditions and give better error text.
  ...WORKBENCH_OPERATION_KINDS,
  ...UPGRADE_OPERATION_KINDS,
  ...MODEL_SERVICES_COMMAND_KINDS,
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
  "browser.evaluate",
  "computer.evaluate",
  "image.read",
  "terminal.image",
  "video.metadata",
  "video.frame",
  "eval.agent.start",
  "eval.agent.status",
  "eval.agent.wait",
  "eval.agent.cancel",
  "eval.completion.start",
  "eval.completion.status",
  "eval.completion.wait",
  "eval.completion.cancel",
  "eval.workpool.status",
]);

export function fencesOnStateVersion(kind: StudioOperation["kind"]): boolean {
  return !LIVE_TURN_OPERATION_KINDS.has(kind);
}

function toCatalogEntry(entry: SessionCatalogEntry): HostCatalogEntry {
  return {
    sessionId: entry.sessionId,
    modifiedAt: entry.modifiedAt,
    ...(entry.lastActivityAt && { lastActivityAt: entry.lastActivityAt }),
    ...(entry.waitingForApproval && { waitingForApproval: true }),
    messageCount: 0,
    status: entry.archived ? "archived" : "active",
    origin: entry.origin,
    pinned: entry.pinned,
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
  };
}

export function createWorkspaceSessionCatalog(
  getCwd: () => string | undefined,
  resolveWorkspaceCwd?: (workspaceId: WorkspaceId) => string | undefined | Promise<string | undefined>,
  listWorkspaces?: () => readonly StoredWorkspace[] | Promise<readonly StoredWorkspace[]>,
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
      .then(result => result.sessions.map(toCatalogEntry))
      .finally(() => {
        scans.delete(key);
      });
    scans.set(key, pending);
    return pending;
  };
  return {
    ...(listWorkspaces && { async locate(sessionId: string) {
      const workspaces = await listWorkspaces();
      const byId = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace]));
      const result = await scanSessionCatalog({ includeCliSessions: true, locate: { sessionId, workspaces } });
      return result.sessions.map(entry => {
        const workspace = byId.get(entry.workspaceId!)!;
        return { workspaceId: workspace.workspaceId as WorkspaceId, workspaceName: workspace.name, entry: toCatalogEntry(entry) };
      });
    } }),
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
    // The list views hide sessions without a conversation message yet (fresh,
    // never sent), but their threads are still addressable for resume, archive
    // and delete: scan the catalog with empty sessions included and match the
    // derived thread id.
    async resolveThreadId(threadId: string): Promise<string | undefined> {
      const cwd = getCwd();
      if (!cwd) return undefined;
      const result = await scanSessionCatalog({ allowedCwd: cwd, includeCliSessions: true, includeEmptySessions: true });
      return result.sessions.find((entry) => threadIdFor(entry.sessionId) === threadId)?.sessionId;
    },
  };
}

export function createDesktopSemanticCommands(options: {
  readonly mediaFiles?: RuntimeMediaFiles;
  readonly mediaWorkspaceId?: () => string | undefined;
  readonly resolveImportWorkspace?: (workspaceId: string) => Promise<string | undefined>;
  readonly registerImportedWorkspace?: (cwd: string) => Promise<string>;

  readonly sessionRef: { current: DesktopRuntimeSession | undefined };
  readonly catalog: HostSessionCatalogProvider;
  readonly resolveResidentSessionId?: (threadId: ThreadId) => string | undefined;
  /** Lazy factory: the archive service is rebuilt when the workspace changes. */
  readonly archive?: () => StudioSessionArchiveService;
  /** Lazy factory: the delete service is rebuilt when the workspace changes. */
  readonly deleteService?: () => StudioSessionDeleteService;
  /**
   * Build a delete service scoped to an explicit working directory. Used by
   * `deleteWorkspaceSessions` to sweep every session recorded under a cwd
   * that is no longer the active workspace (so `deleteService`, which is bound
   * to the live cwd, cannot reach it).
   */
  readonly makeDeleteService?: (cwd: string) => StudioSessionDeleteService;
  /** Shared by the root Host and all of its scoped conversation clients. */
  readonly sessionFileOperations?: Map<ThreadId, Promise<unknown>>;
  readonly finishManagedArtifacts?: (sessionId: string, deleteManagedArtifacts: boolean) => Promise<void>;
  /** Lazy telemetry store so deleted sessions leave no telemetry record. */
  readonly telemetryStore?: () => { readonly remove?: (sessionId: string) => Promise<void> | void };
  /** Thread -> Runtime binding registry; the deleted thread's entry is removed. */
  readonly bindings?: { readonly unbind: (threadId: ThreadId) => Promise<void> | void };
  /** Durable session-lease store; stale lease files are removed with the session. */
  readonly leaseStore?: { readonly removeForSession: (sessionId: string) => Promise<void> | void };
  /** Resolves the OMP agent dir holding the global pin file. */
  readonly agentDir?: () => string;
  readonly switchSession?: DesktopRuntimeSessionPort["switchSession"];
  readonly synchronizeSessionIdentity?: DesktopRuntimeSessionPort["synchronizeSessionIdentity"];
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
  const sessionFileOperations = options.sessionFileOperations ?? new Map();
  function withSessionFileOperation<T>(threadId: ThreadId, run: () => Promise<T>): Promise<T> {
    const previous = sessionFileOperations.get(threadId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(run);
    sessionFileOperations.set(threadId, pending);
    return pending.finally(() => {
      if (sessionFileOperations.get(threadId) === pending) sessionFileOperations.delete(threadId);
    });
  }
  const resumePreparations = new Map<string, {
    result: SessionResumePreparation;
    workspace?: { workspaceId: string; cwd: string };
    expiresAt: number;
  }>();
  const missingRuntime = (fallback: string): StudioHostError => {
    const facts = options.runtimeMissing?.();
    const message = formatRuntimeMissingMessage(facts ?? {});
    return new StudioHostError("CAPABILITY_UNAVAILABLE", message === "Runtime is not available" ? fallback : message);
  };
  type DeleteResult = ConfigWriteResult & { readonly cleanup: "complete" | "partial" };
  async function deleteSessionFiles(
    service: StudioSessionDeleteService, sessionId: string, deleteManagedArtifacts: boolean, archivedOnly: boolean,
    evacuation?: { readonly replaceActive?: boolean },
  ) {
    if (!archivedOnly) await releaseResidentSession(options, sessionId, evacuation);
    const removed = await service.delete(sessionId, { archivedOnly }).catch((error: unknown) => {
      if (error instanceof SessionDeleteServiceError && error.code === "SESSION_NOT_ARCHIVED") {
        throw new StudioHostError("INVALID_ARGUMENT", desktopText("此会话已取消归档，已跳过。", "Skipped because the session was unarchived."));
      }
      throw error;
    });
    let artifactsWarning = false;
    await options.finishManagedArtifacts?.(sessionId, deleteManagedArtifacts).catch(() => { artifactsWarning = true; });
    // Best-effort residue cleanup: the transcript/artifacts are the primary
    // object; a failing related-record removal must not fail the delete.
    await Promise.resolve(options.telemetryStore?.().remove?.(sessionId)).catch(() => undefined);
    await Promise.resolve(options.bindings?.unbind(threadIdFor(sessionId))).catch(() => undefined);
    await Promise.resolve(options.leaseStore?.removeForSession(sessionId)).catch(() => undefined);
    if (options.agentDir !== undefined) {
      await Promise.resolve(removeSessionPin(sessionId, options.agentDir())).catch(() => undefined);
    }
    return { removed, artifactsWarning };
  }
  const removeSession = async (threadId: ThreadId, deleteManagedArtifacts: boolean, archivedOnly: boolean): Promise<DeleteResult> => {
    if (options.deleteService === undefined) {
      throw new StudioHostError("CAPABILITY_UNAVAILABLE", desktopText("此 Host 无法删除会话。", "Session deletion is not available on this Host."));
    }
    const service = options.deleteService();
    return await withSessionFileOperation(threadId, async () => {
      const sessionId = await resolveCatalogSessionId(options, threadId);
      const { removed, artifactsWarning } = await deleteSessionFiles(service, sessionId, deleteManagedArtifacts, archivedOnly);
      const messages = [deleteManagedArtifacts
        ? desktopText("会话及托管产物已删除。", "Session and managed artifacts deleted.")
        : desktopText("会话已删除；托管产物已保留。", "Session deleted; managed artifacts retained.")];
      if (removed.nativeCleanup.status === "partial") {
        messages.push(desktopText(
          `原生历史/统计清理未全部完成（${removed.nativeCleanup.reason}）；部分原生记录可能仍保留。`,
          `Native history/stats cleanup is partial (${removed.nativeCleanup.reason}); some native records may remain.`,
        ));
      }
      if (removed.artifactsCleanupFailed) messages.push(desktopText("会话产物目录清理失败。", "Could not remove the session artifacts directory."));
      if (artifactsWarning) messages.push(desktopText("托管产物清理失败，请检查产物库。", "Managed artifact cleanup failed. Review the artifact library."));
      const cleanup = removed.nativeCleanup.status === "partial" || removed.artifactsCleanupFailed || artifactsWarning ? "partial" : "complete";
      return { applied: true, runtimeEffect: "immediate", message: messages.join(" "), cleanup };
    });
  };
  const deleteWorkspaceSessions = async (cwd: string): Promise<{ readonly deleted: number; readonly warnings: number }> => {
    if (options.makeDeleteService === undefined) {
      throw new StudioHostError("CAPABILITY_UNAVAILABLE", desktopText("此 Host 无法清理项目会话记录。", "Session cleanup is not available on this Host."));
    }
    const service = options.makeDeleteService(cwd);
    const catalog = await scanSessionCatalog({ allowedCwd: cwd, includeCliSessions: true, includeEmptySessions: true });
    let deleted = 0;
    let warnings = 0;
    for (const entry of catalog.sessions) {
      try {
        const { removed, artifactsWarning } = await withSessionFileOperation(threadIdFor(entry.sessionId), () =>
          deleteSessionFiles(service, entry.sessionId, true, entry.archived, { replaceActive: false }),
        );
        deleted += 1;
        if (removed.nativeCleanup.status === "partial" || removed.artifactsCleanupFailed || artifactsWarning) warnings += 1;
      } catch {
        warnings += 1;
      }
    }
    return { deleted, warnings };
  };
  return {
    ...(archiveFactory === undefined
      ? {}
      : {
          archive: ({ threadId }: { readonly threadId: ThreadId }): Promise<ConfigWriteResult> => withSessionFileOperation(threadId, async () => {
            const sessionId = await resolveCatalogSessionId(options, threadId);
            const releasedWriter = await releaseResidentSession(options, sessionId);
            // Studio-origin sessions are written only by the managed Runtime
            // broker. CLI and unknown sessions keep the full crash-writer grace.
            const discovered = (await options.catalog.list()).find((entry) => entry.sessionId === sessionId);
            const skipWriteGrace = releasedWriter || discovered?.origin === "studio";
            try {
              await archiveFactory().archive(sessionId, { skipWriteGrace });
            } catch (error) {
              // Replaying a completed move is idempotent at the command boundary.
              if ((error as { readonly code?: string })?.code !== "SESSION_ALREADY_ARCHIVED") throw error;
            }
            return { applied: true, runtimeEffect: "immediate", message: "Session archived to the OMP cold archive" };
          }),
          unarchive: ({ threadId }: { readonly threadId: ThreadId }): Promise<ConfigWriteResult> => withSessionFileOperation(threadId, async () => {
            const sessionId = await resolveCatalogSessionId(options, threadId);
            await archiveFactory().unarchive(sessionId);
            return { applied: true, runtimeEffect: "immediate", message: "Session restored from the archive" };
          }),
        }),
    delete: ({ threadId, deleteManagedArtifacts = false }) => removeSession(threadId, deleteManagedArtifacts, false),
    deleteArchived: (input) => {
      if (typeof input?.threadId !== "string" || input.threadId.length === 0) {
        throw new StudioHostError("INVALID_ARGUMENT", desktopText("请选择已归档的会话。", "Choose an archived session."));
      }
      return removeSession(input.threadId, false, true);
    },
    deleteWorkspaceSessions: (cwd: string) => deleteWorkspaceSessions(cwd),
    create: async (input) => {
      if (input?.noContextFiles !== undefined && typeof input.noContextFiles !== "boolean") {
        throw new StudioHostError("INVALID_ARGUMENT", "Choose a boolean noContextFiles startup option");
      }
      if (input?.model !== undefined && (typeof input.model !== "string" || input.model.length > 512 || !/^[^\s\u0000-\u001f-][^\u0000-\u001f]*\/[^\u0000-\u001f]+$/u.test(input.model))) {
        throw new StudioHostError("INVALID_ARGUMENT", "Startup requires a provider/model selector");
      }
      if (options.switchSession === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Fresh Runtime sessions are not available");
      }
      let next = await options.switchSession({ kind: "fresh", ...(input?.noContextFiles === undefined ? {} : { noContextFiles: input.noContextFiles }), ...(input?.model === undefined ? {} : { model: input.model }) });
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
    resume: async ({ threadId, model }) => {
      const candidate = resumePreparations.get(threadId);
      const prepared = candidate && candidate.expiresAt > Date.now() ? candidate : undefined;
      if (prepared && !prepared.workspace) {
        throw new StudioHostError("INVALID_ARGUMENT", desktopText(
          "请选择有效的工作区并重新准备恢复会话。",
          "Choose an available workspace and prepare the session resume again.",
        ));
      }
      const target = prepared?.result.targetSessionId ?? await resolveCatalogSessionId(options, threadId);
      const previous = options.sessionRef.current;
      const snapshot = previous?.controller.publication()?.snapshot;
      if (snapshot !== undefined) {
        if (snapshot.isStreaming && options.supportsConcurrentSessions !== true) {
          throw new StudioHostError("BUSY_STREAMING", "Cannot resume while the Runtime is streaming");
        }
        if (snapshot.sessionId === target) {
          if (model !== undefined) throw new StudioHostError("INVALID_ARGUMENT", "This session is already active; change its model using the model picker");
          return snapshot;
        }
      }
      if (options.switchSession === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime session switching is not available");
      }
      const intent = {
        kind: "resume" as const, sessionId: target,
        ...(model === undefined ? {} : { model }),
        ...(prepared?.workspace ? {
          resumeWorkspace: prepared.workspace,
          allowRelocation: prepared.result.recordedCwd !== prepared.workspace.cwd,
        } : {}),
      };
      let restoredSession = await options.switchSession(intent);
      // Recovery is for a cold Host, not a failed replacement of a healthy Worker.
      if (restoredSession?.controller.publication()?.snapshot === undefined && previous?.hello() === undefined && options.ensureRuntime !== undefined) {
        await options.ensureRuntime();
        restoredSession = await options.switchSession(intent);
      }
      const restored = restoredSession?.controller.publication()?.snapshot;
      if (restored === undefined) throw missingRuntime(desktopText("恢复会话失败；原会话保持不变。", "Session resume failed; the previous session is unchanged"));
      if (restored.sessionId !== target && restored.resumedFromSessionId !== target && restored.continuationOf !== target) {
        throw new StudioHostError("INTERNAL_ERROR", desktopText("恢复会话失败；原会话保持不变。", "Session resume failed; the previous session is unchanged"));
      }
      options.bindSession(restoredSession);
      if (prepared) {
        resumePreparations.delete(threadIdFor(prepared.result.targetSessionId));
        resumePreparations.delete(threadIdFor(prepared.result.requestedSessionId));
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
      const mediaDirectory = session.mediaDirectory?.();
      const mediaWorkspaceId = options.mediaWorkspaceId?.();
      if (snapshot === undefined || hello === undefined) {
        throw missingRuntime("Runtime snapshot is unavailable");
      }
      if (operation.kind === "worktrees.session.resume.prepare") {
        // A new selection supersedes both aliases of an earlier preparation,
        // including when this attempt fails or now needs an explicit workspace.
        const previous = resumePreparations.get(threadIdFor(operation.targetSessionId));
        for (const [key, prepared] of resumePreparations) if (prepared === previous) resumePreparations.delete(key);
        const { executionWorkspaceId, executionCwd: _privatePath, ...rest } = operation;
        const cwd = executionWorkspaceId ? await options.resolveImportWorkspace?.(executionWorkspaceId) : undefined;
        if (executionWorkspaceId && !cwd) throw new StudioHostError("INVALID_ARGUMENT", desktopText("未知的执行工作区", "Unknown execution workspace"));
        operation = { ...rest, ...(executionWorkspaceId ? { executionWorkspaceId } : {}), ...(cwd ? { executionCwd: cwd } : {}) };
      }
      if (operation.kind === "session.import.execute") {
        if (!options.registerImportedWorkspace) throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Workspace import registration is unavailable");
        const { fallbackWorkspaceId, fallbackCwd: _privatePath, ...rest } = operation;
        const cwd = fallbackWorkspaceId ? await options.resolveImportWorkspace?.(fallbackWorkspaceId) : undefined;
        if (fallbackWorkspaceId && !cwd) throw new StudioHostError("INVALID_ARGUMENT", "Unknown import workspace");
        operation = { ...rest, ...(cwd ? { fallbackCwd: cwd } : {}) };
      }
      const grants: Array<{ artifactId: string; transferId: string }> = [];
      if (operation.kind === "session.portability.prepare") {
        if (!mediaDirectory || !options.mediaFiles) throw missingRuntime("The private desktop file channel is unavailable");
        const cwd = operation.targetWorkspaceId ? await options.resolveImportWorkspace?.(operation.targetWorkspaceId) : undefined;
        if (operation.targetWorkspaceId && !cwd) throw new StudioHostError("INVALID_ARGUMENT", "Unknown import workspace");
        try {
          const staged = await options.mediaFiles.stage(mediaDirectory, operation.artifactId, 64 * 1024 * 1024, operation.sessionId, true);
          grants.push({ artifactId: staged.artifactId, transferId: staged.transferId });
          if (options.sessionRef.current !== session || session.controller.publication()?.snapshot?.sessionId !== operation.sessionId) throw new Error("Session changed during archive staging");
          operation = { ...operation, inputTransfers: grants, ...(cwd ? { targetCwd: cwd } : {}) };
        } catch (cause) { await options.mediaFiles.releaseInputs(mediaDirectory, grants); throw cause; }
      }
      if (operation.kind === "media.start") {
        if (!mediaDirectory || !options.mediaFiles) throw missingRuntime("The private desktop media channel is unavailable");
        try {
          let remainingBytes = 64 * 1024 * 1024;
          for (const id of mediaInputArtifacts(operation.request)) {
            const staged = await options.mediaFiles.stage(mediaDirectory, id, remainingBytes, operation.sessionId);
            remainingBytes -= staged.bytes; grants.push({ artifactId: staged.artifactId, transferId: staged.transferId });
          }
          if (options.sessionRef.current !== session || session.controller.publication()?.snapshot?.sessionId !== operation.sessionId) throw new Error("Session changed during media staging");
          operation = { ...operation, inputTransfers: grants };
        } catch {
          await options.mediaFiles.releaseInputs(mediaDirectory, grants);
          throw new StudioHostError("INVALID_ARGUMENT", "Unable to stage media inputs. Check the artifact files and active session.");
        }
      }
      const receipt = await session.controller.invoke({
        type: "studio.request",
        requestId: requestId as unknown as RequestId,
        runtimeEpoch: snapshot.runtimeEpoch,
        ...(fencesOnStateVersion(operation.kind) ? { expectedStateVersion: snapshot.stateVersion } : {}),
        operation,
      }).catch(async cause => {
        if (mediaDirectory && grants.length) await options.mediaFiles?.releaseInputs(mediaDirectory, grants);
        throw cause;
      });
      if (receipt.status !== "completed" && mediaDirectory && grants.length) await options.mediaFiles?.releaseInputs(mediaDirectory, grants);
      throwIfNotCompleted(receipt);
      if (session.controller.publication()?.snapshot.sessionId !== snapshot.sessionId) await options.synchronizeSessionIdentity?.(session);
      const latest = session.controller.publication()?.snapshot ?? snapshot;
      if (operation.kind === "session.import.execute") {
        const imported = receipt.result as { imported?: unknown; sessionId?: unknown; cwd?: unknown };
        if (imported?.imported !== true || typeof imported.sessionId !== "string" || typeof imported.cwd !== "string")
          throw new StudioHostError("INTERNAL_ERROR", "Invalid import result");
        const workspaceId = await options.registerImportedWorkspace!(imported.cwd);
        return { snapshot: latest, result: { imported: true, sessionId: imported.sessionId, workspaceId } };
      }
      if (operation.kind === "worktrees.session.resume.prepare") {
        const result = receipt.result as SessionResumePreparation;
        let workspace: { workspaceId: string; cwd: string } | undefined;
        if (result.executionCwd !== undefined && !result.requiresWorkspaceSelection) {
          if (!options.registerImportedWorkspace) throw new StudioHostError("CAPABILITY_UNAVAILABLE", desktopText("恢复工作区注册不可用", "Resume workspace registration is unavailable"));
          workspace = { workspaceId: await options.registerImportedWorkspace(result.executionCwd), cwd: result.executionCwd };
        }
        const now = Date.now();
        for (const [key, prepared] of resumePreparations) if (prepared.expiresAt <= now) resumePreparations.delete(key);
        while (resumePreparations.size > 30) resumePreparations.delete(resumePreparations.keys().next().value!);
        const prepared = { result, ...(workspace ? { workspace } : {}), expiresAt: now + 300_000 };
        resumePreparations.set(threadIdFor(result.targetSessionId), prepared);
        resumePreparations.set(threadIdFor(result.requestedSessionId), prepared);
        return { snapshot: latest, result: { ...result, ...(workspace ? { workspaceId: workspace.workspaceId, threadId: threadIdFor(result.targetSessionId) } : { requiresWorkspaceSelection: true }) } };
      }
      if (operation.kind === "worktrees.session.create" || operation.kind === "worktrees.session.open") {
        const result = receipt.result as { cwd?: string; worktree?: SessionWorktreeRow };
        if (!result.cwd || !options.registerImportedWorkspace) throw new StudioHostError("INTERNAL_ERROR", "Worktree registration unavailable");
        const workspaceId = await options.registerImportedWorkspace(result.cwd);
        return { snapshot: latest, result: { ...(result.worktree ? { worktree: result.worktree } : {}), workspaceId } };
      }
      if (operation.kind === "session.portability.import") {
        const imported = receipt.result as { sessionId: string; mode: "created" | "forked"; cwd?: string };
        if (!imported.cwd || !options.registerImportedWorkspace) throw new StudioHostError("INTERNAL_ERROR", "Imported workspace registration is unavailable");
        const workspaceId = await options.registerImportedWorkspace(imported.cwd);
        return { snapshot: latest, result: { sessionId: imported.sessionId, mode: imported.mode, workspaceId } };
      }
      if (operation.kind === "session.portability.pack" || operation.kind === "session.portability.anonymize" || operation.kind === "session.portability.status") {
        const status = operation.kind === "session.portability.status" ? receipt.result as SessionPortabilityStatus : undefined;
        if (status?.imported?.cwd && options.registerImportedWorkspace) {
          const workspaceId = await options.registerImportedWorkspace(status.imported.cwd);
          return { snapshot: latest, result: { ...status, imported: { sessionId: status.imported.sessionId, mode: status.imported.mode, workspaceId } } };
        }
        const exported = status ? status.exported : receipt.result as PortableExport;
        if (exported) {
          if (!mediaDirectory || !options.mediaFiles) throw missingRuntime("The private desktop file channel is unavailable");
          const record = await options.mediaFiles.promote(mediaDirectory, operation.sessionId, mediaWorkspaceId, exported.id, exported.asset);
          const result = { ...exported, asset: { ...exported.asset, artifactId: record.artifactId } };
          return { snapshot: latest, result: status ? { ...status, exported: result } : result };
        }
      }
      if (operation.kind === "maintenance.session.export" || operation.kind === "maintenance.export.status") {
        const native = operation.kind === "maintenance.session.export" ? receipt.result as SessionExportResult : (receipt.result as SessionExportStatus).result;
        if (native) {
          if (!mediaDirectory || !options.mediaFiles) throw missingRuntime("The private desktop file channel is unavailable");
          const record = await options.mediaFiles.promote(mediaDirectory,operation.sessionId,mediaWorkspaceId,native.id,native.asset);
          const result = { ...native,asset:{...native.asset,artifactId:record.artifactId} };
          return {snapshot:latest,result:operation.kind === "maintenance.session.export"?result:{...(receipt.result as SessionExportStatus),result}};
        }
      }
      if (operation.kind === "media.read") {
        if (!mediaDirectory || !options.mediaFiles) throw missingRuntime("The private desktop media channel is unavailable");
        const detail = receipt.result as MediaDetail;
        const outputs = [];
        for (const asset of detail.outputs) {
          const record = await options.mediaFiles.promote(mediaDirectory, operation.sessionId, mediaWorkspaceId, detail.job.id, asset);
          outputs.push({ artifactId: record.artifactId, kind: asset.kind, name: record.name, mimeType: record.mimeType, bytes: record.bytes, sha256: record.sha256 });
        }
        return { snapshot: latest, result: { ...detail, outputs } };
      }
      if (operation.kind === "session.queue.takeback") {
        const detail = receipt.result as QueueTakeback;
        if (!detail.images.length) return { snapshot: latest, result: detail };
        if (!mediaDirectory || !options.mediaFiles) throw missingRuntime("The private desktop media channel is unavailable");
        const images = [];
        for (const asset of detail.images) {
          const record = await options.mediaFiles.promote(mediaDirectory, operation.sessionId, mediaWorkspaceId, operation.id, asset);
          images.push({ artifactId: record.artifactId, kind: "image" as const, name: record.name, mimeType: record.mimeType, bytes: record.bytes, sha256: record.sha256 });
        }
        return { snapshot: latest, result: { ...detail, images } };
      }
      if (isModelServicesKind(operation.kind)) return receipt.result as ModelServicesCommandResultMap[keyof ModelServicesCommandResultMap];
      if (isWorkbenchOperationKind(operation.kind) || isUpgradeOperationKind(operation.kind)) return { snapshot: latest, result: receipt.result };
      if (isEvaluationOperationKind(operation.kind)) return { snapshot: latest, result: receipt.result };
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
  evacuation?: { readonly replaceActive?: boolean },
): Promise<boolean> {
  if (options.evacuateResident !== undefined) {
    const result = await options.evacuateResident(sessionId, evacuation);
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
    throw new StudioHostError("COMMAND_BLOCKED", desktopText("无法离开当前会话，归档已取消", "Cannot leave the current session; archive cancelled"));
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
  if (match !== undefined) {
    return match.sessionId;
  }
  // The session is on disk but has no conversation message yet (fresh, never
  // sent), so no list view contains it. Its thread is still addressable — the
  // renderer resolves these sessions for resume, archive and delete.
  const emptySessionId = await options.catalog.resolveThreadId?.(threadId);
  if (emptySessionId !== undefined) {
    return emptySessionId;
  }
  throw new StudioHostError("INVALID_ARGUMENT", "Session is not available in this workspace");
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
