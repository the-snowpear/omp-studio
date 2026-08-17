import { useMemo, useState } from "react";
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

const CONTRACT = {
  export: "导出会话不在公共 contract 中",
  fork: "Fork 会话不在公共 contract 中",
  more: "更多会话操作不在公共 contract 中",
} as const;

/** 工具栏状态筛选：纯客户端过滤已加载的会话模型，不涉及 Host 契约。 */
type StatusTab = "all" | "active" | "archived";

const STATUS_TABS: ReadonlyArray<{ readonly id: StatusTab; readonly label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "archived", label: "已归档" },
];

function matchesStatusTab(status: string, tab: StatusTab): boolean {
  if (tab === "all") return true;
  return tab === "archived" ? status === "archived" : status !== "archived";
}

const PREVIEW_STATUS: Record<PreviewHistoryStatus, { chip: string; label: string }> = {
  running: { chip: "blue", label: "运行中" },
  completed: { chip: "green", label: "已完成" },
  failed: { chip: "red", label: "失败" },
  archived: { chip: "gray", label: "已归档" },
};

const HOST_STATUS: Record<SessionHistoryStatus, { chip: string; label: string }> = {
  active: { chip: "blue", label: "进行中" },
  archived: { chip: "gray", label: "已归档" },
  closed: { chip: "gray", label: "已关闭" },
};

const TT_RESTORE = {
  code: "仅恢复代码：工作区回滚，对话保留",
  convo: "仅恢复对话：对话回滚，工作区保留",
  both: "恢复代码与对话：两者同时回滚到该节点",
} as const;

function formatHostTime(value: string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return value;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 7) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(then).toLocaleDateString();
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

function PreviewHistRow({
  row,
  onOpen,
  onAct,
}: {
  row: PreviewHistoryRow;
  onOpen: () => void;
  onAct: (kind: "resume" | "fork" | "more" | "unarchive") => void;
}) {
  const status = PREVIEW_STATUS[row.status];
  return (
    <div className="hist-row">
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">
          {row.pinned ? <span className="t-pin" role="img" aria-label="已置顶"><Icon name="pin" extra="sm" /></span> : null}
          {row.title}
        </span>
        <span className="h-sub">
          <span>{row.project} · {row.branch}</span>
          <span>{row.time}</span>
          <span>{row.model}</span>
          <span>{row.files} 文件</span>
          <span>{row.cost}</span>
          <span>Checkpoint ×{row.checkpoints}</span>
          {row.forkedFrom ? <span className="h-fork">forked from「{row.forkedFrom}」</span> : null}
        </span>
      </a>
      <span className={`chip ${status.chip}`}>{status.label}</span>
      <div className="h-acts">
        <button
          type="button"
          className="icon-btn small"
          data-tip={row.status === "archived" ? "恢复：已归档会话需先取消归档" : `恢复：${row.title}`}
          aria-label={`恢复：${row.title}`}
          disabled={row.status === "archived"}
          onClick={() => onAct("resume")}
        ><Icon name="refresh" extra="sm" /></button>
        <button type="button" className="icon-btn small" data-tip={`Fork：${row.title}`} aria-label={`Fork：${row.title}`} onClick={() => onAct("fork")}><Icon name="fork" extra="sm" /></button>
        {row.status === "archived" ? (
          <button type="button" className="icon-btn small" data-tip={`取消归档：${row.title}`} aria-label={`取消归档：${row.title}`} onClick={() => onAct("unarchive")}><Icon name="external" extra="sm" /></button>
        ) : null}
        <button type="button" className="icon-btn small" data-tip={`更多操作：${row.title}`} aria-label={`更多操作：${row.title}`} onClick={() => onAct("more")}><Icon name="more" extra="sm" /></button>
      </div>
    </div>
  );
}

function HostHistRow({
  entry,
  onOpen,
  onUnarchive,
}: {
  entry: SessionHistoryEntry;
  onOpen: () => void;
  onUnarchive: (() => void) | undefined;
}) {
  const status = HOST_STATUS[entry.status];
  const archived = entry.status === "archived";
  return (
    <div className="hist-row">
      <span className="a-ic purple" aria-hidden="true"><Icon name="message" extra="sm" /></span>
      <a className="h-main" href="#!workbench" onClick={(event) => { event.preventDefault(); onOpen(); }}>
        <span className="h-title ellipsis">{entry.title}</span>
        <span className="h-sub">
          <span>{entry.messageCount} messages</span>
          <span>{formatHostTime(entry.lastActiveAt)}</span>
          {entry.summary ? <span>{entry.summary}</span> : null}
        </span>
      </a>
      <span className={`chip ${status.chip}`}>{status.label}</span>
      <div className="h-acts">
        <button
          type="button"
          className="icon-btn small"
          data-tip={archived ? "恢复：已归档会话需先取消归档" : `恢复：${entry.title}`}
          aria-label={`恢复：${entry.title}`}
          disabled={archived}
          onClick={onOpen}
        ><Icon name="refresh" extra="sm" /></button>
        <button type="button" className="icon-btn small" disabled title={CONTRACT.fork} data-tip={CONTRACT.fork} aria-label={`Fork：${entry.title}`}><Icon name="fork" extra="sm" /></button>
        {archived && onUnarchive !== undefined ? (
          <button type="button" className="icon-btn small" data-tip={`取消归档：${entry.title}`} aria-label={`取消归档：${entry.title}`} onClick={onUnarchive}><Icon name="external" extra="sm" /></button>
        ) : null}
        <button type="button" className="icon-btn small" disabled title={CONTRACT.more} data-tip={CONTRACT.more} aria-label={`更多操作：${entry.title}`}><Icon name="more" extra="sm" /></button>
      </div>
    </div>
  );
}

function TimeTravelRail({ onRestore }: { onRestore: (kind: keyof typeof TT_RESTORE) => void }) {
  return (
    <div className="tt-rail">
      {PREVIEW_TIME_TRAVEL.map((node: PreviewTtNode, index) => (
        <div className={`tt-node ${node.kind}`} key={`${node.kind}-${node.time}-${index}`}>
          <div className="tt-card">
            <div className="tt-card-head">
              <b>{node.title}</b>
              <span className="tiny muted mono">{node.time}</span>
              {node.restorable ? <span className="chip purple xs">可恢复</span> : null}
              {node.restorable ? <span className="spacer" /> : null}
              {node.restorable ? (
                <>
                  <button type="button" className="btn small outline" onClick={() => onRestore("code")}>仅恢复代码</button>
                  <button type="button" className="btn small outline" onClick={() => onRestore("convo")}>仅恢复对话</button>
                  <button type="button" className="btn small primary" onClick={() => onRestore("both")}>恢复代码与对话</button>
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
}: {
  history?: SessionHistoryReadModel;
  onRoute: (route: PageRoute) => void;
  onSelectThread: (entry: SessionHistoryEntry) => void;
  /** 真实模式「取消归档」（session.unarchive）；预览模式下为 undefined（走演示 toast）。 */
  onUnarchive?: (entry: SessionHistoryEntry) => void;
}) {
  const { preview } = usePreviewMode();
  const [query, setQuery] = useState("");
  const [statusTab, setStatusTab] = useState<StatusTab>("all");
  const [notice, show, dismissNotice] = useNotice();
  const q = query.trim().toLowerCase();

  const previewRows = useMemo(
    () => PREVIEW_HISTORY
      .filter((row) => `${row.title} ${row.project} ${row.branch}`.toLowerCase().includes(q))
      .filter((row) => matchesStatusTab(row.status, statusTab)),
    [q, statusTab],
  );
  const hostRows = useMemo(
    () => (history?.entries ?? [])
      .filter((entry) => `${entry.title} ${entry.summary ?? ""}`.toLowerCase().includes(q))
      .filter((entry) => matchesStatusTab(entry.status, statusTab)),
    [history, q, statusTab],
  );

  const rows = preview ? previewRows : hostRows;
  const live = rows.length ? `${rows.length} 个对话` : "没有匹配的对话";

  return (
    <div className="page-wide hist-layout">
      <section aria-labelledby="histHeading">
        <h2 className="sr-only" id="histHeading">会话列表</h2>
        <div className="hist-toolbar">
          <label className="sr-only" htmlFor="histSearch">搜索对话标题、项目或分支</label>
          <input
            className="input hist-search"
            id="histSearch"
            type="search"
            value={query}
            placeholder="搜索对话标题 / 项目 / 分支…"
            onChange={(event) => setQuery(event.target.value)}
          />
          {/* 状态筛选是纯客户端过滤（已加载会话模型），两种模式行为一致 */}
          <div className="hist-tabs" role="group" aria-label="按状态筛选会话">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`btn small ${statusTab === tab.id ? "primary" : "outline"}`}
                aria-pressed={statusTab === tab.id}
                onClick={() => setStatusTab(tab.id)}
              >{tab.label}</button>
            ))}
          </div>
          {preview
            ? (
              <>
                <button type="button" className="btn outline" onClick={() => show("演示：导出不会写文件", "export")}>
                  <Icon name="export" extra="sm" />导出
                </button>
                <span className="chip gray xs">演示</span>
              </>
            )
            : (
              <button type="button" className="btn outline" disabled title={CONTRACT.export}>
                <Icon name="export" extra="sm" />导出
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
                    show(`演示：恢复「${row.title}」`, "refresh");
                    onRoute("workbench");
                    return;
                  }
                  if (kind === "unarchive") {
                    show(`演示：取消归档「${row.title}」不会改 Host`, "archive");
                    return;
                  }
                  show(kind === "fork" ? `演示：Fork「${row.title}」不会创建 Thread` : `演示：更多操作不会改 Host`, kind === "fork" ? "fork" : "more");
                }}
              />
            ))
            : <HistEmpty text="没有匹配的对话" />)
          : (hostRows.length
            ? hostRows.map((entry) => (
              <HostHistRow
                key={entry.historyId}
                entry={entry}
                onOpen={() => onSelectThread(entry)}
                onUnarchive={entry.status === "archived" && onUnarchive !== undefined ? () => onUnarchive(entry) : undefined}
              />
            ))
            : <HistEmpty text={history ? "没有匹配的对话" : "无法读取 session catalog"} />)}
        <div className="sr-only" role="status" aria-live="polite">{live}</div>
      </section>
      <section aria-labelledby="ttHeading">
        <h2 className="tt-heading" id="ttHeading">Time Travel</h2>
        <p className="muted small tt-desc">「跟踪上游 pi-web 更新到 omp-web」的执行历史。恢复操作会明确区分代码与对话的影响范围。</p>
        {preview ? (
          <TimeTravelRail onRestore={(kind) => show(`演示：${TT_RESTORE[kind]}`, "history")} />
        ) : (
          <div className="empty">
            <Icon name="history" />
            当前功能等待后续接入
          </div>
        )}
      </section>
      <ToastHost message={notice?.text ?? null} icon={notice?.icon ?? "info"} onDismiss={dismissNotice} />
    </div>
  );
}
