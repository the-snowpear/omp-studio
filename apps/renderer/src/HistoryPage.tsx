import { timeTravelPreview } from "./preview/timeTravelPreview";
import { ResumeScopePane } from "./history/ResumeScopePane";
import { SessionPortabilityPane } from "./history/SessionPortabilityPane";
import { SeanceDialog } from "./history/SeanceDialog";
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
import type { SessionHistoryEntry, SessionHistoryReadModel, SessionHistoryStatus } from "@omp-studio/client-contract";
import { Icon, type IconName } from "./icons";
import { ToastHost } from "./ToastHost";
import type { PageRoute } from "./HomePage";
import { usePreviewMode } from "./preview/PreviewContext";
import {
  PREVIEW_HISTORY,
  type PreviewHistoryRow,
  type PreviewHistoryStatus,
} from "./preview/fixtures";
import { useI18n } from "./i18n";
import { useTimeTravelSettings } from "./history/useTimeTravelSettings";
import { TimeTravelPane } from "./history/TimeTravelPane";
import { TimeTravelEntry } from "./history/TimeTravelActivation";

/** 工具栏状态筛选：纯客户端过滤已加载的会话模型，不涉及 Host 契约。 */
type StatusTab = "all" | "active" | "archived";

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

function formatHostTime(value: string, t: (key: string) => string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return t("common.justNow");
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`;
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
 * Per-row "⋮" popup. Only one item today (删除会话); the anchor is the row's
 * trigger button rect so the menu floats next to the row that owns it.
 */
function HistMoreMenu({
  open,
  rect,
  onClose,
  onDelete,
  onRename, onPin, pinned,
}: {
  open: boolean;
  rect: { top: number; left: number; width: number; bottom: number } | null;
  onClose: () => void;
  onDelete: () => void;
  onRename?: (() => void) | undefined;
  onPin?: (() => void) | undefined;
  pinned?: boolean | undefined;
}) {
  const { t } = useI18n();
  const popRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 200 });

  useEffect(() => {
    if (!open || rect === null) return;
    const width = Math.max(rect.width, 200);
    const height = popRef.current?.offsetHeight ?? 0;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    let top = rect.bottom + 6;
    if (height > 0 && top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 6);
    }
    setAnchor({ top, left, width });
  }, [open, rect]);

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
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDoc);
    };
  }, [open, onClose]);

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
      {onPin ? <button type="button" role="menuitem" className="menu-item" onClick={onPin}><Icon name="pin" extra="sm" /><span>{pinned ? "取消置顶 / Unpin" : "置顶 / Pin"}</span></button> : null}
      <button type="button" role="menuitem" className="menu-item danger" onClick={onDelete}>
        <Icon name="trash" extra="sm" />
        <span>{t("history.deleteSession")}</span>
      </button>
    </div>,
    document.body,
  );
}

/** Application-internal delete confirmation (same style family as archive confirm). */
function DeleteSessionDialog({
  title,
  preview,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  preview: boolean;
  busy: boolean;
  error?: string;
  onConfirm: (deleteManagedArtifacts: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { marks } = usePreviewMode();
  const [deleteManagedArtifacts, setDeleteManagedArtifacts] = useState(false);
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return createPortal(
    <div className="modal-backdrop create-project-backdrop" role="presentation" onMouseDown={busy ? undefined : onCancel}>
      <section
        className="modal create-project-modal create-branch-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="histDeleteTitle"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="create-project-head">
          <div>
            <span className="create-project-kicker">SESSION</span>
            <h2 id="histDeleteTitle">{t("history.deleteConfirmTitle")}</h2>
            <p className="create-branch-sub">{t("history.deleteConfirmDesc", { title })}</p>
          </div>
          <button type="button" className="icon-btn" aria-label={t("common.close")} disabled={busy} onClick={onCancel}><Icon name="x" /></button>
        </div>
        <div className="create-project-body">
          <p className="create-branch-hint">
            {preview && marks ? t("history.deleteConfirmDemo") : t("history.deleteConfirmReal")}
          </p>
          <label className="small"><input type="checkbox" disabled={busy} checked={deleteManagedArtifacts} onChange={event => setDeleteManagedArtifacts(event.target.checked)} /> {t("history.deleteManagedArtifacts")}</label>
          <p className="small muted">{t("history.retainManagedArtifacts")}</p>
          {error !== undefined ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{error}</div> : null}
        </div>
        <div className="create-project-foot">
          <button type="button" className="btn outline" autoFocus disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn danger" disabled={busy} onClick={() => onConfirm(deleteManagedArtifacts)}>
            {busy
              ? <><span className="spinner" aria-hidden="true" />{t("history.deleting")}</>
              : <><Icon name="trash" extra="sm" /><span>{t("history.deleteSession")}</span></>}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function PreviewHistRow({
  row,
  onOpen,
  onAct,
  onMore,
  onConsult,
}: {
  row: PreviewHistoryRow;
  onOpen: () => void;
  onAct: (kind: "resume" | "fork" | "more" | "unarchive") => void;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onConsult: () => void;
}) {
  const status = PREVIEW_STATUS[row.status];
  const { t } = useI18n();
  const consultLabel = useConsultLabel();
  return (
    <div className="hist-row">
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
        <button type="button" className="icon-btn small" data-tip={consultLabel} aria-label={consultLabel} onClick={onConsult}><Icon name="eye" extra="sm" /></button>
        {row.status === "archived" ? (
          <button type="button" className="icon-btn small" data-tip={t("history.unarchiveSession")} aria-label={t("history.unarchiveSession")} onClick={() => onAct("unarchive")}><Icon name="external" extra="sm" /></button>
        ) : null}
        <button type="button" className="icon-btn small" data-tip={t("common.more")} aria-label={t("common.moreActions")} onClick={onMore}><Icon name="more" extra="sm" /></button>
      </div>
    </div>
  );
}

/** Inline zh/en: no locale keys for this action yet. */
function useConsultLabel(): string {
  return useI18n().resolvedLanguage === "zh" ? "只读咨询" : "Consult (read-only)";
}

function HostHistRow({
  entry,
  lease, titleRow,
  onOpen,
  onUnarchive,
  onMore,
  onConsult,
  onTimeTravel,
}: {
  entry: SessionHistoryEntry;
  lease?: boolean | null | undefined;
  titleRow?: SessionTitleRow | undefined;
  onOpen: () => void;
  onUnarchive: (() => void) | undefined;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
  /** Undefined when no live session can run the consult (or this is the live session). */
  onConsult: (() => void) | undefined;
  onTimeTravel: (() => void) | undefined;
}) {
  const status = HOST_STATUS[entry.status];
  const archived = entry.status === "archived";
  const { t } = useI18n();
  const consultLabel = useConsultLabel();
  const title = hostHistoryTitle(entry, t("conversation.untitledSession"));
  return (
    <div className="hist-row">
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">
          {lease === true ? <span className="chip blue xs">使用中 / In use</span> : lease === null ? <span className="chip gray xs">占用未知 / Unknown lease</span> : null}
          {entry.pinned === true ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
          <SessionTitleMark row={titleRow} title={title} />{title}
        </span>
        <span className="h-sub">
          <span>{t("history.messagesCount", { count: entry.messageCount })}</span>
          <span>{formatHostTime(entry.lastActiveAt, t)}</span>
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
        <button type="button" className="icon-btn small" data-tip={consultLabel} aria-label={consultLabel} disabled={onConsult === undefined} onClick={onConsult}><Icon name="eye" extra="sm" /></button>
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
  client, onImportedOpen, onImported,
  workspaceId,
  history,
  onRoute,
  onSelectThread,
  onUnarchive,
  onDeleteSession,
  onRenameSession, onPinSession,
}: {
  nativeContext?: NativeHistoryContext;
  client?: StudioClient;
  workspaceId?: string | undefined;
  onRenameSession?: (entry: SessionHistoryEntry) => void;
  onPinSession?: (entry: SessionHistoryEntry) => void;
  onImportedOpen?: (sessionId: string, workspaceId: WorkspaceId) => void;
  onImported?: () => void;
  history?: SessionHistoryReadModel;
  onRoute: (route: PageRoute) => void;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  /** 真实模式「取消归档」（session.unarchive）；预览模式下为 undefined（走演示 toast）。 */
  onUnarchive?: (entry: SessionHistoryEntry) => void;
  /** 真实模式「删除会话」；预览模式下为 undefined（走演示确认 + toast）。 */
  onDeleteSession?: (entry: SessionHistoryEntry, deleteManagedArtifacts?: boolean) => Promise<boolean> | boolean;
}) {
  const { preview, marks } = usePreviewMode();
  const timeTravelSettings = useTimeTravelSettings(client);
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [workspaceTab,setWorkspaceTab] = useState<"catalog"|"archive"|"transfer">("catalog");
  const [query, setQuery] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [notice, show, dismissNotice] = useNotice();
  const q = query.trim().toLowerCase();
  const [previewMetadata, setPreviewMetadata] = useState<Record<string, { title?: string; pinned?: boolean }>>({});
  const [previewRename, setPreviewRename] = useState<{ id: string; title: string }>();
  const [leases, setLeases] = useState<Record<string, boolean | null>>({});
  const canMetadata = preview || !!(nativeContext?.available && nativeContext.sessionId && nativeContext.capabilities?.capabilities.some(row => row.id === "session.history.rename" && row.grade !== "unavailable"));
  /** 哪个行的「⋮」菜单打开：id + 触发按钮 rect（菜单用 portal 定位到 body）。 */
  const [menu, setMenu] = useState<{ id: string; rect: { top: number; left: number; width: number; bottom: number } | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ title: string; entry?: SessionHistoryEntry } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const [consult, setConsult] = useState<{ source: string; title: string } | null>(null);
  const [timeTravelSession, setTimeTravelSession] = useState<SessionId>();
  const canConsult = !!(nativeContext?.available && nativeContext.sessionId && nativeContext.capabilities?.capabilities.some((item) => item.id === "seance.ask" && item.grade !== "unavailable"));

  const closeMenu = useCallback(() => setMenu(null), []);
  const openMenu = useCallback((id: string, event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ id, rect: { top: rect.top, left: rect.left, width: rect.width, bottom: rect.bottom } });
  }, []);

  const requestDelete = useCallback((title: string, entry?: SessionHistoryEntry) => {
    setMenu(null);
    setDeleteError(undefined);
    setDeleteFor(entry === undefined ? { title } : { title, entry });
  }, []);

  const cancelDelete = useCallback(() => {
    if (deleting) return;
    setDeleteFor(null);
    setDeleteError(undefined);
  }, [deleting]);

  const confirmDelete = useCallback((deleteManagedArtifacts: boolean) => {
    if (deleteFor === null || deleting) return;
    if (preview || deleteFor.entry === undefined || onDeleteSession === undefined) {
      if (marks || !preview) show(t("history.demoDeleteToast", { title: deleteFor.title }), "trash");
      setDeleteFor(null);
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    void Promise.resolve(onDeleteSession(deleteFor.entry, deleteManagedArtifacts))
      .then((ok) => {
        if (ok) {
          setDeleteFor(null);
          setDeleteError(undefined);
        }
        setDeleting(false);
      })
      .catch((error) => {
        setDeleteError(error instanceof Error && error.message.length > 0 ? error.message : String(error));
        setDeleting(false);
      });
  }, [deleteFor, deleting, marks, preview, onDeleteSession, show, t]);

  const previewRows = useMemo(
    () => PREVIEW_HISTORY.map(row => ({ ...row, ...previewMetadata[row.id] })).sort((a,b) => Number(!!b.pinned)-Number(!!a.pinned))
      .filter((row) => `${row.title} ${row.project} ${row.branch}`.toLowerCase().includes(q))
      .filter((row) => matchesStatusTab(row.status, statusTab)),
    [q, statusTab, previewMetadata],
  );
  const hostRows = useMemo(
    () => (history?.entries ?? [])
      .filter((entry) => `${hostHistoryTitle(entry, t("conversation.untitledSession"))} ${entry.summary ?? ""}`.toLowerCase().includes(q))
      .filter((entry) => matchesStatusTab(entry.status, statusTab)),
    [history, q, statusTab, t],
  );
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

  return (
    <div className="page-wide">
<WorkspaceTabs<"catalog"|"archive"|"transfer"> id="history-workspace" label={zh ? "历史" : "History"} value={workspaceTab} onChange={setWorkspaceTab} items={[{id:"catalog",icon:"history",label:zh?"会话目录":"Session catalog"},{id:"archive",icon:"archive",label:"Archive / Recap"},{id:"transfer",icon:"export",label:zh?"迁移与导出":"Transfer & export"}]}/>
<WorkspacePanel id="history-workspace" name="catalog" active={workspaceTab==="catalog"}>
<div className="hist-layout">
      <section className="history-catalog" aria-labelledby="histHeading">
        <header className="history-catalog-heading">
          <div className="history-catalog-title"><h2 id="histHeading">{zh ? "项目会话" : "Project sessions"}</h2><span className="history-catalog-count">{t("history.conversationsCount", { count: rows.length })}</span></div>
          <div className="history-catalog-actions">
            <ResumeScopePane key={nativeContext?.sessionId ?? "no-live-session"} client={client} context={nativeContext} onOpen={onImportedOpen} onPreviewOpen={() => onRoute("workbench")} />
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
        {preview
          ? (previewRows.length
            ? previewRows.map((row) => (
              <PreviewHistRow
                key={row.id}
                row={row}
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
                onConsult={() => setConsult({ source: row.id, title: row.title })}
                onMore={(event) => openMenu(row.id, event)}
              />
            ))
            : <HistEmpty text={t("history.noMatches")} />)
          : (hostRows.length
            ? hostRows.map((entry) => (
              <HostHistRow
                key={entry.historyId}
                entry={entry}
                lease={leases[entry.sessionId ?? ""]}
                titleRow={titleMetadata.rows.get(entry.sessionId ?? "")}
                onOpen={() => onSelectThread(entry)}
                onUnarchive={entry.status === "archived" && onUnarchive !== undefined ? () => onUnarchive(entry) : undefined}
                onMore={(event) => openMenu(entry.historyId, event)}
                onConsult={canConsult && entry.sessionId && entry.sessionId !== nativeContext?.sessionId ? () => setConsult({ source: entry.sessionId!, title: hostHistoryTitle(entry, t("conversation.untitledSession")) }) : undefined}
                onTimeTravel={timeTravelSettings.settings?.enabled && entry.sessionId ? () => setTimeTravelSession(entry.sessionId) : undefined}
              />
            ))
            : <HistEmpty text={history ? t("history.noMatches") : t("history.catalogUnavailable")} />)}
        <div className="sr-only" role="status" aria-live="polite">{live}</div>
      </section>
      {!timeTravelSettings.settings?.enabled ? <TimeTravelEntry client={client} expanded /> : <TimeTravelPane key={`${workspaceId}:${timeTravelEntry?.sessionId}:${preview}`} client={client} entry={preview ? timeTravelPreview.entry : timeTravelEntry} onOpen={() => { if (timeTravelEntry) onSelectThread(timeTravelEntry); }} />}
      <HistMoreMenu
        open={menu !== null}
        rect={menu?.rect ?? null}
        onClose={closeMenu}
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
        onDelete={() => {
          if (menu === null) return;
          const hostEntry = hostRows.find((entry) => entry.historyId === menu.id);
          if (hostEntry !== undefined) {
            requestDelete(hostHistoryTitle(hostEntry, t("conversation.untitledSession")), hostEntry);
            return;
          }
          const previewRow = previewRows.find((row) => row.id === menu.id);
          if (previewRow !== undefined) {
            requestDelete(previewRow.title);
            return;
          }
          closeMenu();
        }}
      />
      {previewRename ? <div className="modal-backdrop create-project-backdrop"><form className="modal create-project-modal" role="dialog" aria-label={t("conversation.renameThread")} onSubmit={event => { event.preventDefault(); if (!previewRename.title.trim()) return; setPreviewMetadata(current => ({ ...current, [previewRename.id]: { ...current[previewRename.id], title: previewRename.title.trim() } })); setPreviewRename(undefined); }}><h3>{t("conversation.renameThread")}</h3><input className="input" autoFocus value={previewRename.title} onChange={event => setPreviewRename({ ...previewRename, title: event.target.value })} /><div className="create-project-foot"><button type="button" className="btn outline" onClick={() => setPreviewRename(undefined)}>{t("common.cancel")}</button><button type="submit" className="btn primary" disabled={!previewRename.title.trim()}>{t("common.save")}</button></div></form></div> : null}
      {deleteFor !== null ? (
        <DeleteSessionDialog
          title={deleteFor.title}
          preview={preview}
          busy={deleting}
          {...(deleteError === undefined ? {} : { error: deleteError })}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      ) : null}
      {consult !== null ? (
        <SeanceDialog
          client={client}
          sessionId={nativeContext?.sessionId}
          source={consult.source}
          title={consult.title}
          preview={preview}
          onClose={() => setConsult(null)}
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
