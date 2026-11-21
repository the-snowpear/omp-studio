import { timeTravelPreview } from "./preview/timeTravelPreview";
import { CopySessionMenuItem, type SessionIdentity } from "./composer/SessionReferences";
import { useExecutionTarget } from "./workspaces/ExecutionTargets";
import { ResumeScopePane, type OpenPreparedSession } from "./history/ResumeScopePane";
import { SessionPortabilityPane } from "./history/SessionPortabilityPane";
import type { SessionTitleRow } from "@omp-studio/studio-protocol";
import { useSessionTitles } from "./history/useSessionTitles";
import { SessionTitleMark } from "./history/SessionTitleMark";
import { previewSessionTitle } from "./preview/sessionTitlePreview";
import { NativeArchivePane, type NativeHistoryContext } from "./history/NativeArchivePane";
import { WorkspaceTabs, WorkspacePanel } from "./workspaces/Workspace";
import { SessionImportPanel } from "./SessionImportPanel";
import type { StudioClient, SessionId, WorkspaceId } from "@omp-studio/client-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionHistoryEntry, SessionHistoryReadModel, SessionHistoryStatus, ThreadId } from "@omp-studio/client-contract";
import { Icon, type IconName } from "./icons";
import { ToastHost } from "./ToastHost";
import type { PageRoute } from "./HomePage";
import { usePreviewMode } from "./preview/PreviewContext";
import {
  getPreviewHistory,
  findPreviewThread,
  previewSessionId,
  type PreviewHistoryRow,
  type PreviewHistoryStatus,
} from "./preview/fixtures";
import { useI18n } from "./i18n";
import { useSurfaceDocument, surfaceWindow } from "./dock/SurfaceContext";
import { hostErrorMessage } from "./hostError";
import { DeleteSessionDialog } from "./history/DeleteSessionDialog";
import { type ArchivedDeleteOutcome, type DeleteArchivedSessions } from "./history/sessionDeletion";
import { useArchivedHistory } from "./history/useArchivedHistory";
import { withoutDeletedSessions } from "./sidebar/useProjectHistories";
import { useTimeTravelSettings } from "./history/useTimeTravelSettings";
import { TimeTravelPane } from "./history/TimeTravelPane";
import { TimeTravelEntry } from "./history/TimeTravelActivation";

/** 工具栏状态筛选：纯客户端过滤已加载的会话模型，不涉及 Host 契约。 */
type StatusTab = "all" | "active" | "archived";
type BatchRow = { readonly id: string; readonly title: string; readonly entry?: SessionHistoryEntry };
type DeleteRequest =
  | { readonly kind: "preview"; readonly row: PreviewHistoryRow }
  | { readonly kind: "single"; readonly entry: SessionHistoryEntry }
  | { readonly kind: "batch"; readonly rows: readonly BatchRow[] };
type BatchResult = { readonly deleted: number; readonly failures: ReadonlyArray<{ title: string; reason: string }>; readonly warnings: ReadonlyArray<{ title: string; details: string }> };
type RowSelection = { readonly checked: boolean; readonly onChange: () => void };

const STATUS_TABS: ReadonlyArray<{ readonly id: StatusTab; readonly key: string }> = [
  { id: "all", key: "history.all" },
  { id: "active", key: "history.active" },
  { id: "archived", key: "history.archived" },
];

function matchesStatusTab(status: string, tab: StatusTab): boolean {
  if (tab === "all") return true;
  return tab === "archived" ? status === "archived" : status !== "archived";
}

const PREVIEW_STATUS: Record<PreviewHistoryStatus, { chip: string; key: string }> = {
  running: { chip: "blue", key: "common.running" },
  completed: { chip: "green", key: "common.completed" },
  failed: { chip: "red", key: "common.failed" },
  archived: { chip: "gray", key: "history.archived" },
};

const HOST_STATUS: Record<SessionHistoryStatus, { chip: string; key: string }> = {
  active: { chip: "blue", key: "history.active" },
  archived: { chip: "gray", key: "history.archived" },
  closed: { chip: "gray", key: "history.closed" },
};

function formatHostTime(value: string, t: (key: string) => string, zh: boolean): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return t("common.justNow");
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    return zh ? `${m} 分钟前` : `${m}m ago`;
  }
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    return zh ? `${h} 小时前` : `${h}h ago`;
  }
  if (seconds < 86400 * 7) {
    const d = Math.floor(seconds / 86400);
    return zh ? `${d} 天前` : `${d}d ago`;
  }
  return new Date(then).toLocaleDateString();
}

function hostHistoryTitle(entry: SessionHistoryEntry, untitledTitle: string): string {
  const title = entry.title?.trim();
  return title && title.length > 0 ? title : untitledTitle;
}

function useNotice(): [notice: { text: string; icon: IconName } | null, show: (text: string, icon?: IconName) => void, dismiss: () => void] {
  const [notice, setNotice] = useState<{ text: string; icon: IconName } | null>(null);
  return [notice, (text, icon: IconName = "info") => setNotice({ text, icon }), () => setNotice(null)];
}

function HistEmpty({ text }: { text: string }) {
  return (
    <div className="empty">
      <Icon name="search" />
      {text}
    </div>
  );
}

/**
 * The anchor is the trigger rect so the menu floats next to its row.
 */
function HistMoreMenu({
  open,
  rect,
  onClose,
  onDelete,
  onRename, onPin, pinned,
  copyIdentity,
}: {
  open: boolean;
  rect: { top: number; left: number; width: number; bottom: number } | null;
  onClose: () => void;
  onDelete?: (() => void) | undefined;
  onRename?: (() => void) | undefined;
  onPin?: (() => void) | undefined;
  pinned?: boolean | undefined;
  copyIdentity?: SessionIdentity | undefined;
}) {
  const { t, resolvedLanguage } = useI18n();
  const doc = useSurfaceDocument();
  const win = surfaceWindow(doc);
  const zh = resolvedLanguage === "zh";
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 200 });

  useEffect(() => {
    if (!open || rect === null) return;
    const width = Math.max(rect.width, 200);
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (height > 0 && top + height > win.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    setAnchor({ top, left, width });
  }, [open, rect, win]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (popRef.current?.contains(target)) return;
      onClose();
    };
    win.addEventListener("keydown", onKey);
    win.addEventListener("mousedown", onDoc);
    return () => {
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("mousedown", onDoc);
    };
  }, [open, onClose, win]);

  if (!open) return null;
  return createPortal(
    <div
      ref={popRef}
      className="menu hist-more-pop"
      role="menu"
      aria-label={t("common.moreActions")}
      style={{ top: anchor.top, left: anchor.left, minWidth: anchor.width }}
    >
      {onRename ? <button type="button" role="menuitem" className="menu-item" onClick={onRename}><Icon name="pencil" extra="sm" /><span>{t("conversation.renameThread")}</span></button> : null}
      {onPin ? <button type="button" role="menuitem" className="menu-item" onClick={onPin}><Icon name="pin" extra="sm" /><span>{pinned ? (zh ? "取消置顶" : "Unpin") : (zh ? "置顶" : "Pin")}</span></button> : null}
      <CopySessionMenuItem identity={copyIdentity} onClose={onClose} />
      {onDelete ? <button type="button" role="menuitem" className="menu-item danger" onClick={onDelete}>
        <Icon name="trash" extra="sm" />
        <span>{t("history.deleteSession")}</span>
      </button> : null}
    </div>,
    doc.body,
  );
}

function HistoryRowCheckbox({ selection, title }: { selection: RowSelection; title: string }) {
  const { t } = useI18n();
  return (
    <label className="history-checkbox-label">
      <input className="history-checkbox" type="checkbox" aria-label={t("history.selectSession", { title })} checked={selection.checked} onChange={selection.onChange} />
    </label>
  );
}

function PreviewHistRow({
  row,
  onOpen,
  onAct,
  onMore,
  selection,
}: {
  row: PreviewHistoryRow;
  onOpen: () => void;
  onAct: (kind: "resume" | "fork" | "more" | "unarchive") => void;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
  selection?: RowSelection | undefined;
}) {
  const status = PREVIEW_STATUS[row.status];
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  return (
    <div className="hist-row" data-selected={selection?.checked || undefined}>
      {selection ? <HistoryRowCheckbox selection={selection} title={row.title} /> : null}
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">
          {row.pinned ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
          <SessionTitleMark row={previewSessionTitle(row.id,row.title)} title={row.title} />{row.title}
        </span>
        <span className="h-sub">
          <span>{row.project} · {row.branch}</span>
          <span>{row.time}</span>
          <span>{row.model}</span>
          <span>{t("history.filesCount", { count: row.files })}</span>
          <span>{row.cost}</span>
          <span>Checkpoint ×{row.checkpoints}</span>
          {row.forkedFrom ? <span className="h-fork">{t("history.forkedFrom", { title: row.forkedFrom })}</span> : null}
        </span>
      </a>
      <span className={`chip ${status.chip}`}>{t(status.key)}</span>
      <div className="h-acts">
        <button
          type="button"
          className="icon-btn small"
          data-tip={row.status === "archived" ? t("history.unarchiveFirst") : t("history.resume")}
          aria-label={t("history.resume")}
          disabled={row.status === "archived"}
          onClick={() => onAct("resume")}
        ><Icon name="refresh" extra="sm" /></button>
        <button type="button" className="icon-btn small" data-tip="Fork" aria-label="Fork" onClick={() => onAct("fork")}><Icon name="fork" extra="sm" /></button>
        {row.status === "archived" ? (
          <button type="button" className="icon-btn small" data-tip={t("history.unarchiveSession")} aria-label={t("history.unarchiveSession")} onClick={() => onAct("unarchive")}><Icon name="external" extra="sm" /></button>
        ) : null}
        <button type="button" className="icon-btn small" data-tip={t("common.more")} aria-label={t("common.moreActions")} onClick={onMore}><Icon name="more" extra="sm" /></button>
      </div>
    </div>
  );
}


function HostHistRow({
  entry,
  lease, titleRow,
  onOpen,
  onUnarchive,
  onMore,
  onTimeTravel,
  selection,
}: {
  entry: SessionHistoryEntry;
  lease?: boolean | null | undefined;
  titleRow?: SessionTitleRow | undefined;
  onOpen: () => void;
  onUnarchive: (() => void) | undefined;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onTimeTravel: (() => void) | undefined;
  selection?: RowSelection | undefined;
}) {
  const status = HOST_STATUS[entry.status];
  const archived = entry.status === "archived";
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const title = hostHistoryTitle(entry, t("conversation.untitledSession"));
  return (
    <div className="hist-row" data-selected={selection?.checked || undefined}>
      {selection ? <HistoryRowCheckbox selection={selection} title={title} /> : null}
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">
          {lease === true ? <span className="chip blue xs">{zh ? "使用中" : "In use"}</span> : lease === null ? <span className="chip gray xs">{zh ? "占用未知" : "Unknown lease"}</span> : null}
          {entry.pinned === true ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
          <SessionTitleMark row={titleRow} title={title} />{title}
        </span>
        <span className="h-sub">
          <span>{t("history.messagesCount", { count: entry.messageCount })}</span>
          <span>{formatHostTime(entry.lastActiveAt, t, zh)}</span>
          {entry.summary ? <span>{entry.summary}</span> : null}
        </span>
      </a>
      <span className={`chip ${status.chip}`}>{t(status.key)}</span>
      <div className="h-acts">
        {onTimeTravel ? <button type="button" className="icon-btn small" data-tip="Time Travel" aria-label="Time Travel" onClick={onTimeTravel}><Icon name="history" extra="sm" /></button> : null}
        <button
          type="button"
          className="icon-btn small"
          data-tip={archived ? t("history.unarchiveFirst") : t("history.resume")}
          aria-label={t("history.resume")}
          disabled={archived}
          onClick={onOpen}
        ><Icon name="refresh" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled data-tip={t("history.forkNotImplemented")} aria-label="Fork"><Icon name="fork" extra="sm" /></button>
        {archived && onUnarchive !== undefined ? (
          <button type="button" className="icon-btn small" data-tip={t("history.unarchiveSession")} aria-label={t("history.unarchiveSession")} onClick={onUnarchive}><Icon name="external" extra="sm" /></button>
        ) : null}
        <button type="button" className="icon-btn small" data-tip={t("common.more")} aria-label={t("common.moreActions")} onClick={onMore}><Icon name="more" extra="sm" /></button>
      </div>
    </div>
  );
}

export function HistoryPage({
  nativeContext,
  client, onImportedOpen, onNativeResume, onImported,
  workspaceId,
  workspaceName,
  history,
  active = true,
  archiveRevision = 0,
  onRoute,
  onSelectThread,
  onUnarchive,
  onDeleteSession,
  onDeleteArchivedSessions,
  onDeletePreviewSessions,
  deletedPreviewSessionIds,
  deletedSessions,
  sessionWillStop,
  onRenameSession, onPinSession,
}: {
  nativeContext?: NativeHistoryContext;
  client?: StudioClient;
  workspaceId?: WorkspaceId | undefined;
  active?: boolean;
  archiveRevision?: number;
  workspaceName?: string | undefined;
  onRenameSession?: (entry: SessionHistoryEntry) => void;
  onPinSession?: (entry: SessionHistoryEntry) => void;
  onImportedOpen?: (sessionId: string, workspaceId: WorkspaceId) => void;
  onNativeResume?: OpenPreparedSession;
  onImported?: () => void;
  history?: SessionHistoryReadModel;
  onRoute: (route: PageRoute) => void;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  /** 真实模式「取消归档」（session.unarchive）；预览模式下为 undefined（走演示 toast）。 */
  onUnarchive?: (entry: SessionHistoryEntry) => void;
  onDeleteSession?: (entry: SessionHistoryEntry, deleteManagedArtifacts?: boolean) => Promise<boolean> | boolean;
  onDeleteArchivedSessions?: DeleteArchivedSessions;
  onDeletePreviewSessions?: (ids: readonly string[]) => void;
  deletedPreviewSessionIds?: ReadonlySet<string>;
  deletedSessions?: ReadonlySet<string>;
  sessionWillStop?: (entry: SessionHistoryEntry) => boolean;
}) {
  const { preview, marks } = usePreviewMode();
  const target = useExecutionTarget();
  const timeTravelSettings = useTimeTravelSettings(client);
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [workspaceTab,setWorkspaceTab] = useState<"catalog"|"archive"|"transfer">("catalog");
  const [query, setQuery] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [notice, show, dismissNotice] = useNotice();
  const q = query.trim().toLowerCase();
  const [previewMetadata, setPreviewMetadata] = useState<Record<string, { title?: string; pinned?: boolean }>>({});
  const [localPreviewDeletes, setLocalPreviewDeletes] = useState<ReadonlySet<string>>(() => new Set());
  const [previewRename, setPreviewRename] = useState<{ id: string; title: string }>();
  const [leases, setLeases] = useState<Record<string, boolean | null>>({});
  const canMetadata = preview || !!(nativeContext?.available && nativeContext.sessionId && nativeContext.capabilities?.capabilities.some(row => row.id === "session.history.rename" && row.grade !== "unavailable"));
  /** 哪个行的「⋮」菜单打开：id + 触发按钮 rect（菜单用 portal 定位到 body）。 */
  const [menu, setMenu] = useState<{ id: string; rect: { top: number; left: number; width: number; bottom: number } | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<DeleteRequest | null>(null);
  const [processed, setProcessed] = useState<number>();
  const [deleteError, setDeleteError] = useState<unknown>();
  const deleting = processed !== undefined;
  const deleteInFlight = useRef(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [batchResult, setBatchResult] = useState<BatchResult>();
  const selectAll = useRef<HTMLInputElement>(null);
  const archiveVisible = active && workspaceTab === "catalog" && statusTab === "archived";
  const archivedHistory = useArchivedHistory(client, workspaceId, archiveVisible && !preview, archiveRevision);
  const [timeTravelSession, setTimeTravelSession] = useState<SessionId>();

  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((id: string, event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ id, rect: { top: rect.top, left: rect.left, width: rect.width, bottom: rect.bottom } });
  }, []);

  const requestDelete = (request: DeleteRequest) => {
    setMenu(null);
    setDeleteError(undefined);
    setDeleteFor(request);
  };

  const cancelDelete = () => {
    if (deleteInFlight.current) return;
    setDeleteFor(null);
    setDeleteError(undefined);
  };

  const removePreviewRows = (ids: readonly string[]) => {
    setLocalPreviewDeletes(current => new Set([...current, ...ids]));
    onDeletePreviewSessions?.(ids);
  };

  const confirmDelete = async (deleteManagedArtifacts: boolean) => {
    if (deleteFor === null || deleteInFlight.current) return;
    if (deleteFor.kind === "preview") {
      removePreviewRows([deleteFor.row.id]);
      if (marks) show(t("history.demoDeleteToast", { title: deleteFor.row.title }), "trash");
      setDeleteFor(null);
      return;
    }
    deleteInFlight.current = true;
    setProcessed(0);
    setDeleteError(undefined);
    try {
      if (deleteFor.kind === "single") {
        if (!await onDeleteSession?.(deleteFor.entry, deleteManagedArtifacts)) throw new Error();
      } else {
        const confirmed = deleteFor.rows;
        if (preview) {
          removePreviewRows(confirmed.map(row => row.id));
          setSelectedIds(new Set());
          if (marks) setBatchResult({ deleted: confirmed.length, failures: [], warnings: [] });
        } else if (onDeleteArchivedSessions) {
          const outcomes = await onDeleteArchivedSessions(confirmed.flatMap(row => row.entry ? [row.entry] : []), setProcessed);
          const byThread = new Map<ThreadId, ArchivedDeleteOutcome>(outcomes.map(outcome => [outcome.threadId, outcome]));
          const failures: Array<{ title: string; reason: string }> = [];
          const warnings: Array<{ title: string; details: string }> = [];
          const failedIds = new Set<string>();
          let deleted = 0;
          for (const row of confirmed) {
            const result = row.entry && byThread.get(row.entry.threadId);
            if (result?.status === "deleted") {
              deleted += 1;
              if (result.cleanupWarning !== undefined) warnings.push({ title: row.title, details: result.cleanupWarning });
            } else {
              failedIds.add(row.id);
              failures.push({ title: row.title, reason: result?.reason ?? "" });
            }
          }
          setSelectedIds(failedIds);
          setBatchResult({ deleted, failures, warnings });
        }
      }
      setDeleteFor(null);
    } catch (error) {
      setDeleteError(error);
    } finally {
      deleteInFlight.current = false;
      setProcessed(undefined);
    }
  };

  const previewRows = useMemo(
    () => getPreviewHistory(zh).map(row => ({ ...row, ...previewMetadata[row.id] })).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned))
      .filter((row) => !localPreviewDeletes.has(row.id) && !deletedPreviewSessionIds?.has(row.id))
      .filter((row) => `${row.title} ${row.project} ${row.branch}`.toLowerCase().includes(q))
      .filter((row) => matchesStatusTab(row.status, statusTab)),
    [q, statusTab, previewMetadata, localPreviewDeletes, deletedPreviewSessionIds, zh],
  );
  const hostHistory = statusTab === "archived" && client ? archivedHistory.model : history;
  const hostRows = useMemo(
    () => (hostHistory && deletedSessions ? withoutDeletedSessions(hostHistory, deletedSessions).entries : hostHistory?.entries ?? [])
      .filter((entry) => `${hostHistoryTitle(entry, t("conversation.untitledSession"))} ${entry.summary ?? ""}`.toLowerCase().includes(q))
      .filter((entry) => matchesStatusTab(entry.status, statusTab)),
    [hostHistory, deletedSessions, q, statusTab, t],
  );
  const selectableRows: readonly BatchRow[] = useMemo(() => {
    if (!archiveVisible) return [];
    return preview
      ? previewRows.map(row => ({ id: row.id, title: row.title }))
      : onDeleteArchivedSessions
        ? hostRows.map(entry => ({ id: entry.historyId, title: hostHistoryTitle(entry, t("conversation.untitledSession")), entry }))
        : [];
  }, [archiveVisible, preview, previewRows, hostRows, onDeleteArchivedSessions, t]);
  const visibleIds = useMemo(() => new Set(selectableRows.map(row => row.id)), [selectableRows]);
  const selectedRows = selectableRows.filter(row => selectedIds.has(row.id));
  const selectedCount = selectedRows.length;
  const allSelected = selectedCount > 0 && selectedCount === selectableRows.length;
  useEffect(() => {
    setSelectedIds(current => {
      const remaining = new Set([...current].filter(id => visibleIds.has(id)));
      return remaining.size === current.size ? current : remaining;
    });
  }, [visibleIds]);
  useEffect(() => {
    setSelectedIds(new Set());
    setBatchResult(undefined);
  }, [preview, workspaceId, archiveVisible]);
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = selectedCount > 0 && !allSelected;
  }, [allSelected, selectedCount, selectableRows.length]);
  const selectionFor = (id: string): RowSelection | undefined => visibleIds.has(id) ? {
    checked: selectedIds.has(id),
    onChange: () => setSelectedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }),
  } : undefined;
  const historySessionIds = useMemo(() => (history?.entries ?? []).flatMap(row => row.sessionId ? [row.sessionId] : []), [history?.entries]);
  useEffect(() => {
    setTimeTravelSession(undefined);
  }, [workspaceId]);
  useEffect(() => {
    if (timeTravelSession && historySessionIds.includes(timeTravelSession)) return;
    setTimeTravelSession(historySessionIds.find(id => id === nativeContext?.sessionId) ?? historySessionIds[0]);
  }, [historySessionIds, nativeContext?.sessionId, timeTravelSession]);
  const timeTravelEntry = history?.entries.find(row => row.sessionId === timeTravelSession);
  const leaseAvailable = !!nativeContext?.available && !!nativeContext.capabilities?.capabilities.some(row => row.id === "session.lease.inspect" && row.grade !== "unavailable");

  useEffect(() => {
    let alive = true;
    setLeases({});
    if (preview || workspaceTab !== "catalog" || !client || !nativeContext?.sessionId || !leaseAvailable || !historySessionIds.length) return;
    void client.query("session.lease.read", { sessionId: nativeContext.sessionId, targetSessionIds: historySessionIds }).then(result => {
      const held = new Set(result.held), unknown = new Set(result.unknown);
      if (alive) setLeases(Object.fromEntries(historySessionIds.map(id => [id, unknown.has(id) ? null : held.has(id)])));
    }).catch(() => {});
    return () => { alive = false; };
  }, [preview, client, nativeContext?.sessionId, leaseAvailable, historySessionIds, workspaceTab]);

  const titleMetadata = useSessionTitles(client,nativeContext,hostRows.flatMap(entry=>entry.sessionId?[{id:entry.sessionId,title:entry.title}]:[]),workspaceTab==="catalog");
  const rows = preview ? previewRows : hostRows;
  const live = rows.length ? t("history.conversationsCount", { count: rows.length }) : t("history.noMatches");
  const canBatchDelete = preview || onDeleteArchivedSessions !== undefined;
  const archiveReadError = archiveVisible && !preview ? archivedHistory.error : undefined;
  const emptyLabel = archiveVisible && rows.length === 0 && !q
    ? t(!preview && client && archivedHistory.loading ? "history.archiveLoading" : "history.noArchivedSessions")
    : t("history.noMatches");
  const deleteTarget = deleteFor?.kind === "batch"
    ? { count: deleteFor.rows.length, processed: processed ?? 0 }
    : deleteFor?.kind === "preview"
      ? { title: previewRows.find(row => row.id === deleteFor.row.id)?.title ?? deleteFor.row.title, stopping: deleteFor.row.status === "running" }
      : deleteFor?.kind === "single"
        ? { title: hostHistoryTitle(deleteFor.entry, t("conversation.untitledSession")), stopping: sessionWillStop?.(deleteFor.entry) }
        : undefined;

  return (
    <div className="page-wide">
<WorkspaceTabs<"catalog"|"archive"|"transfer"> id="history-workspace" label={zh ? "历史" : "History"} value={workspaceTab} onChange={setWorkspaceTab} items={[{id:"catalog",icon:"history",label:zh?"会话目录":"Session catalog"},{id:"archive",icon:"archive",label:"Archive / Recap"},{id:"transfer",icon:"export",label:zh?"迁移与导出":"Transfer & export"}]}/>
<WorkspacePanel id="history-workspace" name="catalog" active={workspaceTab==="catalog"}>
<div className="hist-layout">
      <section className="history-catalog" aria-labelledby="histHeading">
        <header className="history-catalog-heading">
          <div className="history-catalog-title"><h2 id="histHeading">{zh ? "项目会话" : "Project sessions"}</h2><span className="history-catalog-count">{t("history.conversationsCount", { count: rows.length })}</span></div>
          <div className="history-catalog-actions">
            <ResumeScopePane key={nativeContext?.sessionId ?? "no-live-session"} client={client} context={nativeContext} onOpen={onNativeResume} onPreviewOpen={() => onRoute("workbench")} />
            <SessionImportPanel client={client ?? null} onOpen={onImportedOpen ?? (() => {})} {...(onImported ? { onImported } : {})} onPreviewOpen={() => onRoute("workbench")} />
          </div>
        </header>
        <div className="hist-toolbar">
          <label className="sr-only" htmlFor="histSearch">{t("history.searchLabel")}</label>
          <input
            className="input hist-search"
            id="histSearch"
            type="search"
            value={query}
            placeholder={t("history.searchByTitle")}
            onChange={(event) => setQuery(event.target.value)}
          />
          {/* 状态筛选是纯客户端过滤（已加载会话模型），两种模式行为一致 */}
          <div className="hist-tabs" role="group" aria-label={t("history.filterByStatus")}>
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`btn small ${statusTab === tab.id ? "primary" : "outline"}`}
                aria-pressed={statusTab === tab.id}
                onClick={() => setStatusTab(tab.id)}
              >{t(tab.key)}</button>
            ))}
          </div>
          <button type="button" className="btn outline" onClick={() => setWorkspaceTab("transfer")}>
            <Icon name="export" extra="sm" />{t("history.export")}
          </button>
          {preview && marks ? <span className="chip gray xs">{t("common.demo")}</span> : null}
        </div>
        {archiveVisible && canBatchDelete && selectableRows.length > 0 ? (
          <div className="history-batch-toolbar">
            <label className="history-checkbox-label">
              <input ref={selectAll} className="history-checkbox" type="checkbox" checked={allSelected} onChange={() => setSelectedIds(allSelected ? new Set() : new Set(visibleIds))} />
              {t("history.selectAllArchived")}
            </label>
            <output className="history-batch-count" aria-live="polite">{t("history.selectedCount", { count: selectedCount })}</output>
            {selectedCount > 0 ? <>
              <button type="button" className="btn small outline" onClick={() => setSelectedIds(new Set())}>{t("history.clearSelection")}</button>
              <button type="button" className="btn danger solid small" onClick={() => requestDelete({ kind: "batch", rows: selectedRows })} disabled={deleting}>
                <Icon name="trash" extra="sm" />{t("history.deleteSelected")}
              </button>
            </> : null}
          </div>
        ) : null}
        {archiveVisible && batchResult ? (
          <div className="history-batch-result">
            <div className="history-batch-result-head">
              <div role="status">
                <strong>{t("history.batchDeleted", { count: batchResult.deleted })}</strong>
                {batchResult.failures.length > 0 ? <> · {t("history.batchDeleteFailed", { count: batchResult.failures.length })}</> : null}
                {batchResult.warnings.length > 0 ? <> · {t("history.batchCleanupPartial", { count: batchResult.warnings.length })}</> : null}
              </div>
              <button type="button" className="icon-btn small" aria-label={t("common.close")} onClick={() => setBatchResult(undefined)}><Icon name="x" extra="sm" /></button>
            </div>
            {batchResult.failures.length > 0 || batchResult.warnings.length > 0 ? (
              <ul>
                {batchResult.failures.map(({ title, reason }, index) => <li key={index}>{t("history.batchFailureDetail", { title, reason })}</li>)}
                {batchResult.warnings.map(({ title, details }, index) => <li key={index}>{t("history.batchCleanupDetail", { title })} {details}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
        {archiveReadError !== undefined ? (
          <div className="create-project-error" role="alert">
            <span>{hostErrorMessage(archiveReadError, t("history.archiveLoadError"))}</span>
            <button type="button" className="btn small outline" onClick={archivedHistory.refresh}>{t("common.retry")}</button>
          </div>
        ) : null}
        {preview
          ? (previewRows.length
            ? previewRows.map((row) => (
              <PreviewHistRow
                key={row.id}
                row={row}
                selection={selectionFor(row.id)}
                onOpen={() => onRoute("workbench")}
                onAct={(kind) => {
                  if (kind === "resume") {
                    if (marks) show(t("history.demoResumeToast", { title: row.title }), "refresh");
                    onRoute("workbench");
                    return;
                  }
                  if (kind === "unarchive") {
                    if (marks) show(t("history.demoUnarchiveToast", { title: row.title }), "archive");
                    return;
                  }
                  if (kind === "more") {
                    return;
                  }
                  if (marks) show(t("history.demoForkToast", { title: row.title }), "fork");
                }}
                onMore={(event) => openMenu(row.id, event)}
              />
            ))
            : <HistEmpty text={emptyLabel} />)
          : (hostRows.length
            ? hostRows.map((entry) => (
              <HostHistRow
                key={entry.historyId}
                entry={entry}
                selection={selectionFor(entry.historyId)}
                lease={leases[entry.sessionId ?? ""]}
                titleRow={titleMetadata.rows.get(entry.sessionId ?? "")}
                onOpen={() => onSelectThread(entry)}
                onUnarchive={entry.status === "archived" && onUnarchive !== undefined ? () => onUnarchive(entry) : undefined}
                onMore={(event) => openMenu(entry.historyId, event)}
                onTimeTravel={timeTravelSettings.settings?.enabled && entry.sessionId ? () => setTimeTravelSession(entry.sessionId) : undefined}
              />
            ))
            : archiveReadError === undefined ? <HistEmpty text={archiveVisible || history ? emptyLabel : t("history.catalogUnavailable")} /> : null)}
        {archiveVisible && !preview && archivedHistory.model && archivedHistory.model.entries.length < archivedHistory.model.total ? (
          <div className="history-archived-more">
            <button type="button" className="btn outline small" disabled={archivedHistory.loading} onClick={archivedHistory.loadMore}>
              {archivedHistory.loading ? <span className="spinner" aria-hidden="true" /> : <Icon name="chevron-d" extra="sm" />}
              {t("history.loadMoreArchived")}
            </button>
          </div>
        ) : null}
        <div className="sr-only" role="status" aria-live="polite">{live}</div>
      </section>
      {!timeTravelSettings.settings?.enabled ? <TimeTravelEntry client={client} expanded /> : <TimeTravelPane key={`${workspaceId}:${timeTravelEntry?.sessionId}:${preview}`} client={client} entry={preview ? timeTravelPreview.entry : timeTravelEntry} onOpen={() => { if (timeTravelEntry) onSelectThread(timeTravelEntry); }} />}
      <HistMoreMenu
        open={menu !== null}
        rect={menu?.rect ?? null}
        onClose={closeMenu}
        copyIdentity={(() => {
          if (preview) {
            const row = previewRows.find(row => row.id === menu?.id);
            const match = row?.threadId ? findPreviewThread(row.threadId, zh) : undefined;
            if (!row || !match) return undefined;
            return {
              sessionId: previewSessionId(match.thread.id), source: {
                targetId: null, workspaceId: match.project.id as WorkspaceId, workspaceName: match.project.name,
                title: row.title, previewThreadId: match.thread.id,
              },
            };
          }
          const entry = hostRows.find(row => row.historyId === menu?.id);
          if (!entry?.sessionId) return undefined;
          return {
            sessionId: entry.sessionId,
            ...(workspaceId ? { source: {
              targetId: target.id, workspaceId: workspaceId as WorkspaceId, workspaceName,
              title: entry.title, threadId: entry.threadId, historyId: entry.historyId,
            } } : {}),
          };
        })()}
        pinned={preview ? previewRows.find(row => row.id === menu?.id)?.pinned : hostRows.find(row => row.historyId === menu?.id)?.pinned}
        onRename={canMetadata ? () => {
          if (preview) { const row = previewRows.find(row => row.id === menu?.id); if (row) setPreviewRename({ id: row.id, title: row.title }); }
          else { const row = hostRows.find(row => row.historyId === menu?.id); if (row) onRenameSession?.(row); }
          closeMenu();
        } : undefined}
        onPin={canMetadata ? () => {
          if (preview) { const row = previewRows.find(row => row.id === menu?.id); if (row) setPreviewMetadata(current => ({ ...current, [row.id]: { ...current[row.id], pinned: !row.pinned } })); }
          else { const row = hostRows.find(row => row.historyId === menu?.id); if (row) onPinSession?.(row); }
          closeMenu();
        } : undefined}
        onDelete={preview || onDeleteSession ? () => {
          if (menu === null) return;
          if (preview) {
            const row = previewRows.find(candidate => candidate.id === menu.id);
            if (row) return requestDelete({ kind: "preview", row });
          } else {
            const entry = hostRows.find(candidate => candidate.historyId === menu.id);
            if (entry) return requestDelete({ kind: "single", entry });
          }
          closeMenu();
        } : undefined}
      />
      {previewRename ? <div className="modal-backdrop create-project-backdrop"><form className="modal create-project-modal" role="dialog" aria-label={t("conversation.renameThread")} onSubmit={event => { event.preventDefault(); if (!previewRename.title.trim()) return; setPreviewMetadata(current => ({ ...current, [previewRename.id]: { ...current[previewRename.id], title: previewRename.title.trim() } })); setPreviewRename(undefined); }}><h3>{t("conversation.renameThread")}</h3><input className="input" autoFocus value={previewRename.title} onChange={event => setPreviewRename({ ...previewRename, title: event.target.value })} /><div className="create-project-foot"><button type="button" className="btn outline" onClick={() => setPreviewRename(undefined)}>{t("common.cancel")}</button><button type="submit" className="btn primary" disabled={!previewRename.title.trim()}>{t("common.save")}</button></div></form></div> : null}
      {deleteTarget ? (
        <DeleteSessionDialog
          target={deleteTarget}
          busy={deleting}
          error={deleteError === undefined ? undefined : hostErrorMessage(deleteError, t("history.deleteSessionFailed"))}
          onConfirm={deleteManagedArtifacts => { void confirmDelete(deleteManagedArtifacts); }}
          onCancel={cancelDelete}
        />
      ) : null}
      <ToastHost message={notice?.text ?? null} icon={notice?.icon ?? "info"} onDismiss={dismissNotice} />
    </div>
</WorkspacePanel>
<WorkspacePanel id="history-workspace" name="transfer" active={workspaceTab==="transfer"}>{workspaceTab === "transfer" ? <SessionPortabilityPane client={client} context={nativeContext} visible={workspaceTab==="transfer"} entries={history?.entries ?? []} onImported={onImported} onOpen={onImportedOpen} /> : null}</WorkspacePanel>
<WorkspacePanel id="history-workspace" name="archive" active={workspaceTab==="archive"}><NativeArchivePane client={client} context={nativeContext} active={workspaceTab==="archive"} canOpen={id=>(history?.entries??[]).some(entry=>entry.sessionId===id)} onOpen={id=>{const entry=(history?.entries??[]).find(entry=>entry.sessionId===id);if(entry)onSelectThread(entry);}}/></WorkspacePanel>
    </div>
  );
}
