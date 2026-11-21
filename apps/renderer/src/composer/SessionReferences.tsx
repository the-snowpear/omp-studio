import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { OpaqueCursor, SessionHistoryEntry, SessionHistoryMatch, SessionId, StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import { ToastHost } from "../ToastHost";
import { SurfaceProvider, useSurfaceDocument } from "../dock/SurfaceContext";
import { useConversationView } from "../conversationWorkspace/Context";
import { acquireProjectReads } from "../conversationWorkspace/projectReads";
import { hostErrorMessage } from "../hostError";
import { useI18n } from "../i18n";
import { MenuItem } from "../menus";
import { usePreviewMode } from "../preview/PreviewContext";
import { findPreviewThread, getPreviewProjects, previewSessionId } from "../preview/fixtures";
import { previewConversationItems } from "../preview/conversationFixtures";
import { useExecutionTarget, useExecutionTargets } from "../workspaces/ExecutionTargets";
import { recentSessionMessages, SESSION_REFERENCE_MESSAGE_LIMIT, type SessionReference, type SessionReferenceMessage, type SessionReferenceSource } from "./sessionReference";
import "./sessionReference.css";

export type SessionIdentity = Pick<SessionReference, "sessionId" | "source">;

type ClipboardIssue = "clipboardUnavailable" | "clipboardDenied" | "clipboardFailed";
type ClipboardOutcome = { code: "copied" } | { code: ClipboardIssue; reason?: string };

export async function writeSessionId(document: Document, sessionId: string): Promise<ClipboardOutcome> {
  const clipboard = document.defaultView?.navigator.clipboard;
  if (!clipboard?.writeText) return { code: "clipboardUnavailable" };
  try {
    await clipboard.writeText(sessionId);
    return { code: "copied" };
  } catch (error) {
    if ((error as { name?: string } | null)?.name === "NotAllowedError") return { code: "clipboardDenied" };
    return { code: "clipboardFailed", reason: hostErrorMessage(error, "") };
  }
}

export function sessionCopyMessage(outcome: ClipboardOutcome, t: ReturnType<typeof useI18n>["t"]): string {
  const label = t("sessionReference." + outcome.code);
  return outcome.code === "clipboardFailed" && outcome.reason ? label + " · " + outcome.reason : label;
}

type SessionReferenceActions = {
  copy(identity: SessionIdentity, document: Document, showToast?: boolean): Promise<ClipboardOutcome>;
  copiedIdentity(sessionId: string): SessionIdentity | undefined;
  locate(sessionId: string): Promise<readonly SessionReferenceSource[]>;
  read(sessionId: string, source: SessionReferenceSource, zh: boolean, signal: AbortSignal): Promise<readonly SessionReferenceMessage[]>;
  open(sessionId: string, source: SessionReferenceSource): Promise<void>;
  environmentName(targetId: string | null): string;
  crossEnvironment(source: SessionReferenceSource): boolean;
  available(source: SessionReferenceSource): boolean;
  previewTitle(source: SessionReferenceSource, zh: boolean): string | undefined;
};

const SessionReferenceContext = createContext<SessionReferenceActions | null>(null);
export const useSessionReferences = () => useContext(SessionReferenceContext);

// The windows share one Renderer. Only the last successful copy in each mode
// gets provenance without a lookup, and the clipboard itself holds the raw id.
const lastCopy = new Map<boolean, SessionIdentity>();

async function readExcerpts(client: StudioClient, sessionId: SessionId, signal: AbortSignal) {
  let cursor: OpaqueCursor | undefined;
  let messages: readonly SessionReferenceMessage[] = [];
  do {
    signal.throwIfAborted();
    const page = await client.query("session.transcript.readPage", { sessionId, ...(cursor && { cursor }) });
    messages = [...recentSessionMessages(page.items), ...messages].slice(-SESSION_REFERENCE_MESSAGE_LIMIT);
    if (messages.length === SESSION_REFERENCE_MESSAGE_LIMIT || page.items.some(item => item.kind === "resetBoundary")) break;
    cursor = page.olderCursor;
  } while (cursor);
  return messages;
}

async function locateOnHost(client: StudioClient, sessionId: SessionId, legacyWorkspaceId?: WorkspaceId): Promise<readonly SessionHistoryMatch[]> {
  try {
    return await client.query("history.locate", { sessionId });
  } catch {
    // Older Hosts can still answer the exact-id query for each registered project.
    const { workspaces } = await client.query("projects.list", {}).catch(() => ({ workspaces: [] }));
    const matches: SessionHistoryMatch[] = [];
    if (!workspaces.length && legacyWorkspaceId) {
      const result = await client.query("history.list", { sessionId, limit: 1 });
      return result.entries.map(entry => ({ workspaceId: legacyWorkspaceId, workspaceName: "", entry }));
    }
    for (const workspace of workspaces) {
      const input = { sessionId, limit: 1 };
      const result = await client.query("history.list", { ...input, workspaceId: workspace.workspaceId }).catch(() =>
        workspace.active ? client.query("history.list", input).catch(() => undefined) : undefined,
      );
      for (const entry of result?.entries ?? []) matches.push({
        workspaceId: workspace.workspaceId, workspaceName: workspace.name, entry,
      });
    }
    return matches;
  }
}

export function SessionReferencesProvider({ workspaceId, onOpenLegacy, children }: {
  workspaceId: WorkspaceId | undefined;
  onOpenLegacy: (entry: SessionHistoryEntry, workspaceId: WorkspaceId) => void;
  children: ReactNode;
}) {
  const { t, resolvedLanguage } = useI18n();
  const { preview } = usePreviewMode();
  const view = useConversationView();
  const workspaceStore = view?.store;
  const target = useExecutionTarget();
  const registry = useExecutionTargets();
  const legacy = useRef(onOpenLegacy);
  legacy.current = onOpenLegacy;
  const copyNumber = useRef(0);
  const [notice, setNotice] = useState<{ document: Document; sequence: number; outcome: ClipboardOutcome }>();
  const actions = useMemo<SessionReferenceActions>(() => {
    const connected = (targetId: string | null) => targetId === null ||
      target.inventory.statuses.some(status => status.id === targetId && status.state === "connected");
    const unavailable = () => new Error(t("sessionReference.sourceUnavailable"));
    return {
      async copy(identity, document, showToast = true) {
        const sequence = ++copyNumber.current;
        const outcome = await writeSessionId(document, identity.sessionId);
        if (outcome.code === "copied") lastCopy.set(preview, identity);
        if (showToast && copyNumber.current === sequence) setNotice({ document, sequence, outcome });
        return outcome;
      },
      copiedIdentity(sessionId) {
        const copy = lastCopy.get(preview);
        return copy?.sessionId === sessionId ? copy : undefined;
      },
      async locate(sessionId) {
        if (preview) {
          for (const project of getPreviewProjects(resolvedLanguage === "zh")) {
            const thread = project.threads.find(row => previewSessionId(row.id) === sessionId);
            if (thread && thread.msgs > 0) return [{
              targetId: null, workspaceId: project.id as WorkspaceId, workspaceName: project.name,
              previewThreadId: thread.id, title: thread.title,
            }];
          }
          return [];
        }
        const ids = new Set<string | null>([null, ...target.inventory.statuses
          .filter(status => status.state === "connected").map(status => status.id)]);
        const results = await Promise.allSettled([...ids].map(async targetId => {
          const client = await registry.readyClient(targetId);
          const matches = await locateOnHost(client, sessionId as SessionId, targetId === target.id ? workspaceId : undefined);
          return matches.filter(match => match.entry.sessionId === sessionId).map(({ entry, ...project }) => ({
            ...project, targetId, title: entry.title, historyId: entry.historyId, threadId: entry.threadId,
          }));
        }));
        return results.flatMap(result => result.status === "fulfilled" ? result.value : []);
      },
      async read(sessionId, source, zh, signal) {
        if (preview) {
          return source.previewThreadId && findPreviewThread(source.previewThreadId, zh)
            ? recentSessionMessages(previewConversationItems(source.previewThreadId, zh))
            : [];
        }
        if (!connected(source.targetId)) throw unavailable();
        const root = await registry.readyClient(source.targetId);
        const read = (client: StudioClient) => readExcerpts(client, sessionId as SessionId, signal);
        if (!root.openContext || root.supportsContexts === false) {
          const projects = await root.query("projects.list", {});
          const active = projects.activeWorkspaceId ?? projects.workspaces.find(workspace => workspace.active)?.workspaceId
            ?? (await root.bootstrap()).selected?.workspaceId;
          if (active !== source.workspaceId) throw unavailable();
          return await read(root);
        }
        const { reads, release } = acquireProjectReads(root, source.workspaceId);
        try {
          return await read(await reads.client());
        } finally {
          release();
        }
      },
      async open(sessionId, source) {
        if (preview) {
          if (!workspaceStore || !source.previewThreadId || !findPreviewThread(source.previewThreadId, resolvedLanguage === "zh")) throw unavailable();
          const viewId = workspaceStore.openFromDirectory({
            targetId: null, workspaceId: source.workspaceId,
            previewThreadId: source.previewThreadId, previewProjectId: source.workspaceId,
          });
          workspaceStore.focus(viewId);
          return;
        }
        if (!connected(source.targetId)) throw unavailable();
        const root = await registry.readyClient(source.targetId);
        if (workspaceStore) {
          const viewId = workspaceStore.openFromDirectory({
            targetId: source.targetId, workspaceId: source.workspaceId, sessionId,
            historyId: source.historyId, threadId: source.threadId,
          }, source.title);
          workspaceStore.focus(viewId);
          return;
        }
        if (source.targetId !== target.id) throw unavailable();
        const result = await root.query("history.list", { workspaceId: source.workspaceId, sessionId: sessionId as SessionId, limit: 1 });
        const entry = result.entries.find(entry => entry.sessionId === sessionId);
        if (!entry) throw unavailable();
        legacy.current(entry, source.workspaceId);
      },
      environmentName: id => id === null ? t("sessionReference.local") :
        target.inventory.profiles.find(profile => profile.id === id)?.name ?? t("sessionReference.remote"),
      crossEnvironment: source => !preview && source.targetId !== target.id,
      available: source => preview
        ? !!source.previewThreadId && !!findPreviewThread(source.previewThreadId, resolvedLanguage === "zh")
        : connected(source.targetId),
      previewTitle: (source, zh) => source.previewThreadId ? findPreviewThread(source.previewThreadId, zh)?.thread.title : undefined,
    };
  }, [preview, registry, resolvedLanguage, t, target, workspaceStore, workspaceId]);

  return <SessionReferenceContext.Provider value={actions}>
    {children}
    {notice ? <SurfaceProvider document={notice.document}><ToastHost
      key={notice.sequence}
      message={sessionCopyMessage(notice.outcome, t)}
      icon={notice.outcome.code === "copied" ? "check" : "alert"}
      variant="capsule"
      onDismiss={() => setNotice(undefined)}
    /></SurfaceProvider> : null}
  </SessionReferenceContext.Provider>;
}

export function CopySessionMenuItem({ identity, onClose }: { identity?: SessionIdentity | undefined; onClose: () => void }) {
  const actions = useSessionReferences();
  const document = useSurfaceDocument();
  const { t } = useI18n();
  if (!actions) return null;
  return <MenuItem icon="copy" disabled={!identity} title={!identity ? t("sessionReference.noId") : undefined} onClick={() => {
    if (!identity) return;
    onClose();
    void actions.copy(identity, document);
  }}>{t("sessionReference.copy")}</MenuItem>;
}
