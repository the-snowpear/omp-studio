import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import { Icon } from "../icons";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { useSurfaceDocument } from "../dock/SurfaceContext";
import { useWideLayout } from "../layout/useWideLayout";
import { WorkspaceDialog } from "../workspaces/Workspace";
import { JobInspector } from "../conversation/JobInspector";
import { hostErrorMessage } from "../hostError";
import { invokeServiceCommand } from "../services/serviceCommands";
import { PREVIEW_BACKGROUND_DETAILS } from "../preview/backgroundTasksPreview";
import { backgroundTaskCounts, taskDuration, taskStatusLabel, type BackgroundTask } from "./backgroundTasksModel";
import type { useBackgroundTasks } from "./useBackgroundTasks";
import { BackgroundTaskMenu } from "./BackgroundTaskMenu";
import "./backgroundTasks.css";

export type BackgroundTasksSource = ReturnType<typeof useBackgroundTasks>;
export type BackgroundTaskIntent = { key?: string | undefined; serial: number };
export type BackgroundTasksPanelProps = {
  source: BackgroundTasksSource;
  client?: StudioClient | undefined;
  sessionId?: string | undefined;
  scopeKey: string;
  available: boolean;
  visible: boolean;
  card: boolean;
  now: number;
  locked?: boolean;
  intent?: BackgroundTaskIntent | undefined;
  onOpenWindow: (key?: string) => void;
  onOpenPreview: (url: string, key: string) => boolean;
};

function useServiceLogs(task: BackgroundTask | null, props: BackgroundTasksPanelProps, doc: Document, preview: boolean) {
  const service = task?.kind === "service" ? task.service : undefined;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const refresh = useRef<() => void>(() => {});
  const { client, scopeKey, available, visible, card } = props;
  useEffect(() => { setText(""); setError(""); }, [scopeKey, client, service?.name, service?.instanceId, preview]);
  useEffect(() => {
    let active = true, busy = false;
    const load = async () => {
      if (!service || !visible || card || doc.hidden || busy || (!preview && (!client || !available))) return;
      if (preview) {
        setText(service.state === "exited" ? "Process exited." : "Server ready\nWatching workspace files…");
        return;
      }
      busy = true;
      try {
        const result = await invokeServiceCommand(client!, "services.logs", { name: service.name, instanceId: service.instanceId, lines: 300 });
        if (active && !doc.hidden) { setText(result.text); setError(""); }
      } catch (cause) {
        if (active && !doc.hidden) setError(hostErrorMessage(cause, "Cannot read service logs"));
      } finally { busy = false; }
    };
    const request = () => { void load(); };
    refresh.current = request;
    request();
    const timer = service && task?.active && visible && !card && !preview && available ? setInterval(request, 3000) : undefined;
    doc.addEventListener("visibilitychange", request);
    return () => { active = false; if (timer !== undefined) clearInterval(timer); doc.removeEventListener("visibilitychange", request); refresh.current = () => {}; };
  }, [client, scopeKey, available, visible, card, doc, preview, service?.name, service?.instanceId, service?.state, task?.active]);
  return { text, error, refresh: () => refresh.current() };
}

function taskIcon(row: BackgroundTask) {
  return row.kind === "service" ? "server" : row.job.type === "task" ? "bot" : row.job.type === "eval" ? "test" : "terminal";
}
function serviceMode(mode: string, zh: boolean) {
  return mode === "persist" ? zh ? "持久化" : "Persistent" : mode === "detached" ? zh ? "脱离运行" : "Detached" : zh ? "会话内" : "Session";
}

export function BackgroundTasksPanel(props: BackgroundTasksPanelProps) {
  const { source, card, visible, now, scopeKey, client, sessionId, available, intent, onOpenWindow, onOpenPreview, locked } = props;
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { preview, marks } = usePreviewMode();
  const doc = useSurfaceDocument();
  const [container, wide] = useWideLayout<HTMLDivElement>(720);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [recentOpen, setRecentOpen] = useState(false);
  const [confirm, setConfirm] = useState<BackgroundTask | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openError, setOpenError] = useState("");
  const [menu, setMenu] = useState<{ key: string; point: { x: number; y: number } } | null>(null);
  const selectedCache = useRef<BackgroundTask | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const appliedIntent = useRef(0);
  const found = source.rows.find(row => row.key === selectedKey);
  const selected = selectedKey ? found ?? selectedCache.current : null;
  const gone = selected !== null && !found;
  const counts = backgroundTaskCounts(source.rows);
  const activeRows = source.rows.filter(row => row.active);
  const recentRows = source.rows.filter(row => !row.active);
  const listHidden = !card && !wide && selected !== null;
  const logs = useServiceLogs(gone ? null : selected, props, doc, preview);
  const showProcess = (row: BackgroundTask) => {
    if (card) { onOpenWindow(row.key); return; }
    selectedCache.current = row;
    setSelectedKey(row.key);
  };
  const choose = (row: BackgroundTask) => {
    setOpenError("");
    if (row.kind === "service" && row.active && row.service.previewUrl) {
      if (onOpenPreview(row.service.previewUrl, row.key)) return;
      setOpenError(zh ? "当前连接无法打开内置网页，先显示服务启动过程。" : "The managed browser is unavailable for this connection. Showing the service process instead.");
    }
    showProcess(row);
  };
  useLayoutEffect(() => { if (found) selectedCache.current = found; }, [found]);
  useEffect(() => {
    if (!intent || appliedIntent.current === intent.serial || card) return;
    const row = source.rows.find(item => item.key === intent.key);
    if (intent.key && !row) return;
    appliedIntent.current = intent.serial;
    if (row) { selectedCache.current = row; setSelectedKey(row.key); }
  }, [intent, source.rows, card]);
  useLayoutEffect(() => {
    if (listHidden || !restoreFocus.current) return;
    const row = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-task-key]") ?? []).find(node => node.dataset.taskKey === restoreFocus.current);
    row?.querySelector<HTMLElement>(".bt-task-main")?.focus({ preventScroll: true });
    restoreFocus.current = null;
  }, [listHidden]);
  useEffect(() => { if (!visible) { setConfirm(null); setMenu(null); } }, [visible]);

  const stop = (row: BackgroundTask) => {
    if (!source.canStop(row) || source.pending.has(row.key)) return;
    if (row.kind === "service") setConfirm(row);
    else void source.stop(row);
  };
  const stopButton = (row: BackgroundTask) => row.active ? <button type="button" className="bt-stop"
    aria-label={`${zh ? "停止" : "Stop"} ${row.label}`} data-tip={source.pending.has(row.key) ? zh ? "正在停止" : "Stopping" : zh ? "停止" : "Stop"}
    disabled={!source.canStop(row) || source.pending.has(row.key)} onClick={() => stop(row)}>
    <Icon name={source.pending.has(row.key) ? "clock" : "stop"} extra="sm" />
  </button> : null;
  const renderRow = (row: BackgroundTask) => {
    const pending = source.pending.has(row.key);
    const status = pending ? zh ? "正在停止" : "Stopping" : taskStatusLabel(row, zh);
    const tone = row.failed ? "danger" : pending || ["queued", "starting", "restarting", "stopping"].includes(row.state) ? "warning" : row.active ? "active" : "quiet";
    const metadata = row.kind === "service" ? serviceMode(row.service.mode, zh) : row.job.stage ?? (row.depth ? zh ? "子任务" : "Child task" : "");
    return <div className={`bt-row${selectedKey === row.key && !card ? " is-selected" : ""}`} key={row.key} data-task-key={row.key} data-kind={row.kind} data-tone={tone}
      style={{ "--task-depth": Math.min(card ? 0 : row.depth, 2) } as CSSProperties}
      onContextMenu={event => { if (row.kind !== "service") return; event.preventDefault(); event.stopPropagation(); setMenu({ key: row.key, point: { x: event.clientX, y: event.clientY } }); }}
      onKeyDown={event => { if (row.kind !== "service" || !(event.key === "ContextMenu" || event.shiftKey && event.key === "F10")) return; event.preventDefault(); event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ key: row.key, point: { x: rect.left + 12, y: rect.bottom } }); }}>
      <button className="bt-task-main" type="button" onClick={() => choose(row)} aria-label={`${row.label} · ${status}`} aria-pressed={!card && selectedKey === row.key} disabled={card && locked && row.kind === "job"}>
        <span className="bt-task-icon"><Icon name={taskIcon(row)} {...(card ? { extra: "sm" } : {})} /></span>
        <span className="bt-task-copy"><span className="bt-task-name" data-tip={row.label}>{row.label}</span>
          <span className="bt-task-meta"><span className="bt-state">{status}</span>{metadata ? <span className="bt-task-context">{metadata}</span> : null}<span className={`bt-time${card && row.kind === "service" && row.service.previewUrl ? " bt-address" : ""}`} data-tip={row.kind === "service" ? row.service.previewUrl : undefined}>{card && row.kind === "service" && row.service.previewUrl ? new URL(row.service.previewUrl).host : taskDuration(row, now)}</span></span>
        </span>
      </button>
      {stopButton(row)}
      {source.actionErrors.get(row.key) ? <div className="bt-row-error" role="alert">{source.actionErrors.get(row.key)}</div> : null}
    </div>;
  };
  const refresh = async () => { if (refreshing) return; setRefreshing(true); try { await source.refresh(); } finally { setRefreshing(false); } };
  const confirmed = confirm ? source.rows.find(row => row.key === confirm.key) : undefined;
  const missingSource = !available && !preview;
  const menuTarget = source.rows.find(row => row.key === menu?.key);

  return <div ref={container} className={`background-tasks${card ? " is-card" : ""}${wide && !card ? " is-wide" : ""}`} data-testid="background-tasks" data-view={card ? "card" : wide ? "wide" : "narrow"}>
    <div className="bt-toolbar">
      <span className="bt-activity"><i aria-hidden="true" data-active={counts.active > 0 || undefined} />{zh ? "活动" : "Active"}<b>{counts.active}</b></span>
      {preview && marks ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}
      {!card ? <button className="bt-toolbar-action" type="button" onClick={() => void refresh()} disabled={refreshing || missingSource} data-tip={zh ? "刷新列表" : "Refresh list"} aria-label={zh ? "刷新列表" : "Refresh list"}><Icon name="refresh" extra="sm" /></button> : null}
    </div>
    {missingSource ? <div className="bt-source-note"><Icon name="info" extra="sm" />{zh ? "当前会话未连接，已读状态可能过期" : "No live session. Shown states may be out of date."}</div> : null}
    {source.servicesState === "error" ? <div className="bt-source-note is-error" role="alert">{zh ? "服务暂不可读：" : "Services unavailable: "}{source.servicesError}</div> : null}
    {source.servicesState === "unavailable" && !missingSource ? <div className="bt-source-note">{zh ? "服务功能未启用；仍显示可用的后台任务" : "Services are unavailable. Background jobs are still shown."}</div> : null}
    {openError ? <div className="bt-source-note" role="status">{openError}</div> : null}
    <div className="bt-content">
      <div className="bt-list" ref={list} hidden={listHidden} aria-label={zh ? "后台活动列表" : "Background activity list"}>
        {activeRows.map(renderRow)}
        {!activeRows.length ? <div className="bt-empty"><Icon name="terminal" />
          <span>{!source.jobsReady || source.servicesState === "loading" ? zh ? "正在读取后台活动…" : "Loading background activity…" : missingSource ? zh ? "暂无可用的后台活动" : "No background activity available" : zh ? "暂无正在运行的任务" : "No active background tasks"}</span>
          {source.jobsReady && source.servicesState !== "loading" ? <small>{zh ? "托管服务和后台任务会统一显示在这里" : "Managed services and background jobs appear here."}</small> : null}
        </div> : null}
        {card || recentRows.length > 0 ? <section className="bt-recent">
          <button className="bt-recent-toggle" type="button" aria-expanded={recentOpen && recentRows.length > 0} disabled={recentRows.length === 0} onClick={() => setRecentOpen(!recentOpen)}>
            <Icon name={recentOpen ? "chevron-d" : "chevron-r"} extra="sm" /><span>{zh ? "最近已结束" : "Recently finished"}</span><b>{recentRows.length}</b>
            {counts.failed > 0 ? <span className="bt-failures"><Icon name="alert-c" extra="sm" />{zh ? `失败 ${counts.failed}` : `${counts.failed} failed`}</span> : null}
          </button>
          {recentOpen ? <div>{recentRows.map(renderRow)}</div> : null}
        </section> : null}
      </div>
      {!card ? <section className="bt-detail" hidden={!wide && !selected} aria-label={zh ? "活动详情" : "Activity details"}>
        {selected ? <>
          <div className="bt-detail-head">
            <button type="button" className="bt-back" onClick={() => { restoreFocus.current = selected.key; setSelectedKey(null); }} aria-label={zh ? "返回任务列表" : "Back to tasks"} data-tip={zh ? "返回任务列表" : "Back to tasks"}><Icon name="chevron-l" extra="sm" /></button>
            <h3>{selected.label}</h3>{!gone ? stopButton(selected) : null}
          </div>
          <div className="bt-detail-body">
            {gone ? <div className="bt-source-note">{zh ? "此记录已移出最近列表，不再读取详情" : "This entry is no longer retained. Details will not refresh."}</div> : null}
            {source.actionErrors.get(selected.key) ? <div className="bt-row-error" role="alert">{source.actionErrors.get(selected.key)}</div> : null}
            <div className="bt-detail-summary"><span>{taskStatusLabel(selected, zh)}</span><span className="bt-time">{taskDuration(selected, now)}</span></div>
            {selected.kind === "job" ? <JobInspector job={{ id: selected.job.jobId, label: selected.label, status: selected.state, generation: selected.job.generation }}
              client={client} sessionId={sessionId} available={available && !gone} visible={visible && !gone} scopeKey={scopeKey} embedded presentation="process" document={doc}
              {...(preview ? { previewInspection: PREVIEW_BACKGROUND_DETAILS[selected.job.jobId] ?? null } : {})} onClose={() => setSelectedKey(null)} />
            : <>
              <div className="bt-log-heading"><h4>{zh ? "启动过程" : "Service process"}</h4>
                {selected.service.previewUrl ? <button className="btn small ghost" type="button" disabled={gone || !selected.active} onClick={() => choose(selected)}><Icon name="globe" extra="sm" />{zh ? "打开网页" : "Open page"}</button> : null}
                <button className="bt-toolbar-action" type="button" onClick={logs.refresh} disabled={gone || (!available && !preview)} aria-label={zh ? "刷新日志" : "Refresh logs"} data-tip={zh ? "刷新日志" : "Refresh logs"}><Icon name="refresh" extra="sm" /></button>
              </div>
              {!selected.service.previewUrl ? <div className="bt-source-note">{zh ? "此服务未上报网页地址，显示运行输出。" : "No page address was reported for this service. Showing its process output."}</div> : null}
              {logs.error ? <div className="bt-row-error" role="alert">{logs.error}</div> : null}
              {logs.text ? <pre className="bt-log" aria-label={zh ? "服务最近输出" : "Recent service output"}>{logs.text}</pre> : <div className="bt-source-note">{zh ? "暂无日志" : "No logs yet"}</div>}
              <details className="bt-process-details"><summary>{zh ? "执行信息" : "Execution details"}</summary>
                <dl className="bt-service-fields"><dt>{zh ? "生命周期" : "Lifetime"}</dt><dd>{serviceMode(selected.service.mode, zh)}</dd>
                  <dt>{zh ? "服务实例" : "Instance"}</dt><dd>{selected.service.instanceId}</dd>
                  {selected.service.pid !== undefined ? <><dt>PID</dt><dd>{selected.service.pid}</dd></> : null}
                  {selected.service.previewUrl ? <><dt>{zh ? "网页地址" : "Page URL"}</dt><dd>{selected.service.previewUrl}</dd></> : null}
                  <dt>{zh ? "重启次数" : "Restarts"}</dt><dd>{selected.service.restartCount}</dd>
                  {selected.service.exitCode !== undefined ? <><dt>{zh ? "退出码" : "Exit code"}</dt><dd>{selected.service.exitCode}</dd></> : null}
                </dl>
              </details>
            </>}
          </div>
        </> : <div className="bt-detail-placeholder"><Icon name="console" /><span>{zh ? "选择一项后台活动" : "Select a background activity"}</span><small>{zh ? "查看状态、执行信息与输出" : "Inspect its status, execution details and output."}</small></div>}
      </section> : null}
    </div>

    {menu && menuTarget?.kind === "service" ? <BackgroundTaskMenu point={menu.point} canOpenPage={menuTarget.active && !!menuTarget.service.previewUrl}
      onOpenPage={() => { setMenu(null); choose(menuTarget); }} onProcess={() => { setMenu(null); showProcess(menuTarget); }} onClose={() => setMenu(null)} /> : null}
    {confirm ? <WorkspaceDialog title={zh ? "停止服务" : "Stop service"} onClose={() => setConfirm(null)}>
      <div className="bt-confirm"><p>{zh ? `停止「${confirm.label}」？使用此服务的页面或任务可能会中断。` : `Stop “${confirm.label}”? Pages or tasks using this service may be interrupted.`}</p>
        <div className="actions"><button type="button" className="btn" onClick={() => setConfirm(null)}>{zh ? "取消" : "Cancel"}</button>
          <button type="button" className="btn danger" disabled={!confirmed || !source.canStop(confirmed) || source.pending.has(confirm.key)} onClick={() => { if (confirmed) void source.stop(confirmed); setConfirm(null); }}>{zh ? "停止服务" : "Stop service"}</button>
        </div>
      </div>
    </WorkspaceDialog> : null}
  </div>;
}
