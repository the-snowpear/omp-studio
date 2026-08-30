import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionHistoryEntry, SessionHistoryReadModel, SessionHistoryStatus } from "@omp-studio/client-contract";
import { Icon } from "./icons";
import { ToastHost } from "./ToastHost";
import type { PageRoute } from "./HomePage";
import { usePreviewMode } from "./preview/PreviewContext";
import {
  PREVIEW_HISTORY,
  PREVIEW_TIME_TRAVEL,
  type PreviewHistoryRow,
  type PreviewHistoryStatus,
  type PreviewTtNode,
} from "./preview/fixtures";
import { useI18n } from "./i18n";

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

const TT_RESTORE = {
  code: "history.restoreCodeOnly",
  convo: "history.restoreConvoOnly",
  both: "history.restoreBoth",
} as const;

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

function useNotice(): [notice: { text: string; icon: string } | null, show: (text: string, icon?: string) => void, dismiss: () => void] {
  const [notice, setNotice] = useState<{ text: string; icon: string } | null>(null);
  return [notice, (text, icon = "info") => setNotice({ text, icon }), () => setNotice(null)];
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
}: {
  open: boolean;
  rect: { top: number; left: number; width: number; bottom: number } | null;
  onClose: () => void;
  onDelete: () => void;
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
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
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
            {preview ? t("history.deleteConfirmDemo") : t("history.deleteConfirmReal")}
          </p>
          {error !== undefined ? <div className="create-project-error" role="alert"><Icon name="alert" extra="sm" />{error}</div> : null}
        </div>
        <div className="create-project-foot">
          <button type="button" className="btn outline" autoFocus disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
          <button type="button" className="btn danger" disabled={busy} onClick={onConfirm}>
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
}: {
  row: PreviewHistoryRow;
  onOpen: () => void;
  onAct: (kind: "resume" | "fork" | "more" | "unarchive") => void;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const status = PREVIEW_STATUS[row.status];
  const { t } = useI18n();
  return (
    <div className="hist-row">
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">
          {row.pinned ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
          {row.title}
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
  onOpen,
  onUnarchive,
  onMore,
}: {
  entry: SessionHistoryEntry;
  onOpen: () => void;
  onUnarchive: (() => void) | undefined;
  onMore: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const status = HOST_STATUS[entry.status];
  const archived = entry.status === "archived";
  const { t } = useI18n();
  const title = hostHistoryTitle(entry, t("conversation.untitledSession"));
  return (
    <div className="hist-row">
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">
          {entry.pinned === true ? <span className="t-pin" role="img" aria-label={t("history.pinned")}><Icon name="pin" extra="sm" /></span> : null}
          {title}
        </span>
        <span className="h-sub">
          <span>{t("history.messagesCount", { count: entry.messageCount })}</span>
          <span>{formatHostTime(entry.lastActiveAt, t)}</span>
          {entry.summary ? <span>{entry.summary}</span> : null}
        </span>
      </a>
      <span className={`chip ${status.chip}`}>{t(status.key)}</span>
      <div className="h-acts">
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

function TimeTravelRail({ onRestore }: { onRestore: (kind: keyof typeof TT_RESTORE) => void }) {
  const { t } = useI18n();
  return (
    <div className="tt-rail">
      {PREVIEW_TIME_TRAVEL.map((node: PreviewTtNode, index) => (
        <div className={`tt-node ${node.kind}`} key={`${node.kind}-${node.time}-${index}`}>
          <div className="tt-card">
            <div className="tt-card-head">
              <b>{node.title}</b>
              <span className="tiny muted mono">{node.time}</span>
              {node.restorable ? <span className="chip purple xs">{t("history.restorable")}</span> : null}
              {node.restorable ? <span className="spacer" /> : null}
              {node.restorable ? (
                <>
                  <button type="button" className="btn small outline" onClick={() => onRestore("code")}>{t("history.btnRestoreCode")}</button>
                  <button type="button" className="btn small outline" onClick={() => onRestore("convo")}>{t("history.btnRestoreConvo")}</button>
                  <button type="button" className="btn small primary" onClick={() => onRestore("both")}>{t("history.btnRestoreBoth")}</button>
                </>
              ) : null}
            </div>
            <div className="small muted tt-card-body">{node.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export function HistoryPage({
  history,
  onRoute,
  onSelectThread,
  onUnarchive,
  onDeleteSession,
}: {
  history?: SessionHistoryReadModel;
  onRoute: (route: PageRoute) => void;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  /** 真实模式「取消归档」（session.unarchive）；预览模式下为 undefined（走演示 toast）。 */
  onUnarchive?: (entry: SessionHistoryEntry) => void;
  /** 真实模式「删除会话」；预览模式下为 undefined（走演示确认 + toast）。 */
  onDeleteSession?: (entry: SessionHistoryEntry) => Promise<boolean> | boolean;
}) {
  const { preview } = usePreviewMode();
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [notice, show, dismissNotice] = useNotice();
  const q = query.trim().toLowerCase();
  /** 哪个行的「⋮」菜单打开：id + 触发按钮 rect（菜单用 portal 定位到 body）。 */
  const [menu, setMenu] = useState<{ id: string; rect: { top: number; left: number; width: number; bottom: number } | null } | null>(null);
  const [deleteFor, setDeleteFor] = useState<{ title: string; entry?: SessionHistoryEntry } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

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

  const confirmDelete = useCallback(() => {
    if (deleteFor === null || deleting) return;
    if (preview || deleteFor.entry === undefined || onDeleteSession === undefined) {
      show(t("history.demoDeleteToast", { title: deleteFor.title }), "trash");
      setDeleteFor(null);
      return;
    }
    setDeleting(true);
    setDeleteError(undefined);
    void Promise.resolve(onDeleteSession(deleteFor.entry))
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
  }, [deleteFor, deleting, preview, onDeleteSession, show, t]);

  const previewRows = useMemo(
    () => PREVIEW_HISTORY
      .filter((row) => `${row.title} ${row.project} ${row.branch}`.toLowerCase().includes(q))
      .filter((row) => matchesStatusTab(row.status, statusTab)),
    [q, statusTab],
  );
  const hostRows = useMemo(
    () => (history?.entries ?? [])
      .filter((entry) => `${hostHistoryTitle(entry, t("conversation.untitledSession"))} ${entry.summary ?? ""}`.toLowerCase().includes(q))
      .filter((entry) => matchesStatusTab(entry.status, statusTab)),
    [history, q, statusTab, t],
  );

  const rows = preview ? previewRows : hostRows;
  const live = rows.length ? t("history.conversationsCount", { count: rows.length }) : t("history.noMatches");

  return (
    <div className="page-wide hist-layout">
      <section aria-labelledby="histHeading">
        <h2 className="sr-only" id="histHeading">{t("history.listHeading")}</h2>
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
          {preview
            ? (
              <>
                <button type="button" className="btn outline" onClick={() => show(t("history.demoExportToast"), "export")}>
                  <Icon name="export" extra="sm" />{t("history.export")}
                </button>
                <span className="chip gray xs">{t("common.demo")}</span>
              </>
            )
            : (
              <button type="button" className="btn outline" disabled data-tip={t("history.exportNotImplemented")}>
                <Icon name="export" extra="sm" />{t("history.export")}
              </button>
            )}
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
                    show(t("history.demoResumeToast", { title: row.title }), "refresh");
                    onRoute("workbench");
                    return;
                  }
                  if (kind === "unarchive") {
                    show(t("history.demoUnarchiveToast", { title: row.title }), "archive");
                    return;
                  }
                  if (kind === "more") {
                    return;
                  }
                  show(t("history.demoForkToast", { title: row.title }), "fork");
                }}
                onMore={(event) => openMenu(row.id, event)}
              />
            ))
            : <HistEmpty text={t("history.noMatches")} />)
          : (hostRows.length
            ? hostRows.map((entry) => (
              <HostHistRow
                key={entry.historyId}
                entry={entry}
                onOpen={() => onSelectThread(entry)}
                onUnarchive={entry.status === "archived" && onUnarchive !== undefined ? () => onUnarchive(entry) : undefined}
                onMore={(event) => openMenu(entry.historyId, event)}
              />
            ))
            : <HistEmpty text={history ? t("history.noMatches") : t("history.catalogUnavailable")} />)}
        <div className="sr-only" role="status" aria-live="polite">{live}</div>
      </section>
      <section aria-labelledby="ttHeading">
        <h2 className="tt-heading" id="ttHeading">Time Travel</h2>
        <p className="muted small tt-desc">{t("history.timeTravelDesc")}</p>
        {preview ? (
          <TimeTravelRail onRestore={(kind) => show(t("history.demoRestoreToast", { desc: t(TT_RESTORE[kind]) }), "history")} />
        ) : (
          <div className="empty">
            <Icon name="history" />
            {t("shell.previewUnavailableDetail")}
          </div>
        )}
      </section>
      <HistMoreMenu
        open={menu !== null}
        rect={menu?.rect ?? null}
        onClose={closeMenu}
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
      <ToastHost message={notice?.text ?? null} icon={notice?.icon ?? "info"} onDismiss={dismissNotice} />
    </div>
  );
}
