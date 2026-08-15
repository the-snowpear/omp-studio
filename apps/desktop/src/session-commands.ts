/**
 * Desktop semantic commands: session.create / session.resume / session.drop / interaction.respond
 * and P4 invoke that forwards the client requestId.
 */

import type {
  HostCatalogEntry,
  HostSemanticCommandService,
  HostSessionCatalogProvider,
} from "@omp-studio/host-client-api";
import { threadIdFor } from "@omp-studio/host-client-api";
import { scanSessionCatalog, StudioHostError } from "@omp-studio/studio-host";
import type { ApprovalMode, RequestId, StudioOperation, ThreadId } from "@omp-studio/studio-protocol";

import type { DesktopRuntimeSession, DesktopRuntimeSessionPort } from "./host-composition.js";
import type { DesktopInteractionHost } from "./interaction-host.js";

export function createWorkspaceSessionCatalog(getCwd: () => string | undefined): HostSessionCatalogProvider {
  return {
    async list(): Promise<HostCatalogEntry[]> {
      const cwd = getCwd();
      if (cwd === undefined) return [];
      const result = await scanSessionCatalog({ includeCliSessions: true, allowedCwd: cwd });
      return result.sessions.map((entry) => ({
        sessionId: entry.sessionId,
        modifiedAt: entry.modifiedAt,
        messageCount: 0,
        status: "active" as const,
        ...(entry.title === undefined ? {} : { title: entry.title }),
        ...(entry.createdAt === undefined ? {} : { createdAt: entry.createdAt }),
      }));
    },
  };
}

export function createDesktopSemanticCommands(options: {
  readonly sessionRef: { current: DesktopRuntimeSession | undefined };
  readonly catalog: HostSessionCatalogProvider;
  readonly switchSession?: DesktopRuntimeSessionPort["switchSession"];
  readonly applyApprovalMode?: DesktopRuntimeSessionPort["applyApprovalMode"];
  readonly supportsConcurrentSessions?: boolean;
  readonly bindSession: (session: DesktopRuntimeSession | undefined) => void;
  readonly interaction: DesktopInteractionHost;
}): HostSemanticCommandService {
  return {
    create: async () => {
      if (options.switchSession === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Fresh Runtime sessions are not available");
      }
      const next = await options.switchSession({ kind: "fresh" });
      options.bindSession(next);
      const created = next?.controller.publication()?.snapshot;
      if (created === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      return created;
    },
    resume: async ({ threadId }) => {
      const target = await resolveCatalogSessionId(options.catalog, threadId);
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
      options.bindSession(next);
      const restored = next?.controller.publication()?.snapshot;
      if (restored === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      if (restored.sessionId !== target) {
        throw new StudioHostError("INTERNAL_ERROR", "Session resume failed; the previous session was kept when possible");
      }
      return restored;
    },
    drop: async ({ threadId, requestId }) => {
      const session = options.sessionRef.current;
      if (session === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime snapshot is unavailable");
      }
      const target = await resolveCatalogSessionId(options.catalog, threadId);
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
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      if (snapshot === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime snapshot is unavailable");
      }
      await options.interaction.respond(input);
      return session.controller.publication()?.snapshot ?? snapshot;
    },
    setApprovalMode: async ({ mode }) => {
      // Session-exclusive (plan §5.4): reject while the Runtime is streaming
      // or an interaction is pending so the mode change cannot race a turn.
      const session = options.sessionRef.current;
      if (session === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime snapshot is unavailable");
      }
      if (snapshot.isStreaming) {
        throw new StudioHostError("BUSY_STREAMING", "Cannot change the approval mode while the Runtime is streaming");
      }
      if (snapshot.pendingInteraction !== undefined) {
        throw new StudioHostError("COMMAND_BLOCKED", "Cannot change the approval mode while an interaction is pending");
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
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime is not available");
      }
      const snapshot = session.controller.publication()?.snapshot;
      const hello = session.hello();
      if (snapshot === undefined || hello === undefined) {
        throw new StudioHostError("CAPABILITY_UNAVAILABLE", "Runtime snapshot is unavailable");
      }
      const receipt = await session.controller.invoke({
        type: "studio.request",
        requestId: requestId as unknown as RequestId,
        runtimeEpoch: snapshot.runtimeEpoch,
        expectedStateVersion: snapshot.stateVersion,
        operation,
      });
      throwIfNotCompleted(receipt);
      return session.controller.publication()?.snapshot ?? snapshot;
    },
  };
}

async function resolveCatalogSessionId(catalog: HostSessionCatalogProvider, threadId: ThreadId): Promise<string> {
  const entries = await catalog.list();
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
  if (code === "INVALID_ARGUMENT" || receipt.status === "rejected") {
    throw new StudioHostError("INVALID_ARGUMENT", receipt.error?.message ?? "Runtime rejected the request");
  }
  throw new StudioHostError("INTERNAL_ERROR", receipt.error?.message ?? `Runtime command ${receipt.status}`);
}
