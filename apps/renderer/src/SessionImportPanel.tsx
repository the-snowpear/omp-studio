import { AppSelect } from "./AppSelect";
import { useEffect, useId, useRef, useState } from "react";
import type { ForeignSessionSummary, ForeignSource, StudioClient, WorkspaceRecord, WorkspaceId } from "@omp-studio/client-contract";
import { invokeUpgrade, useUpgradeAvailable } from "./runtimeUpgrade";
import { hostErrorMessage } from "./hostError";
import { usePreviewMode } from "./preview/PreviewContext";
import { useI18n } from "./i18n";
import { Icon } from "./icons";
import { SlidingTabs } from "./SlidingTabs";
import { MarkdownText } from "./conversation/markdown";
import { WorkspaceDialog, WorkspaceEmpty } from "./workspaces/Workspace";
import { SessionPickerKeys, SessionPickerList, SessionPickerSearch, sessionPickerTime } from "./history/SessionPicker";
import { PREVIEW_FOREIGN_SESSIONS, PREVIEW_IMPORT_PREVIEWS, PREVIEW_IMPORT_WORKSPACES } from "./preview/runtimeUpgradeFixtures";

export function SessionImportPanel({ client, onOpen, onImported, onPreviewOpen }: {
  client: StudioClient | null;
  onOpen: (sessionId: string, workspaceId: WorkspaceId) => void;
  onImported?: () => void;
  onPreviewOpen?: () => void;
}) {
  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const available = useUpgradeAvailable(client, preview, "session.import.execute");
  const [opened, setOpened] = useState(false);
  const [source, setSource] = useState<ForeignSource>("claude");
  const [sessions, setSessions] = useState<ForeignSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [detail, setDetail] = useState<{ session: ForeignSessionSummary; preview: string }>();
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>([]);
  const [fallback, setFallback] = useState("");
  const [result, setResult] = useState<{ source: ForeignSource; sourceId: string; sessionId: string; workspaceId: string }>();
  const [loading, setLoading] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [listError, setListError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [importError, setImportError] = useState("");
  const listEpoch = useRef(0);
  const detailEpoch = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (opened) searchRef.current?.focus();
  }, [opened]);

  useEffect(() => {
    const current = ++listEpoch.current;
    setSelectedId(""); setSessions([]); setListError(""); setLoading(false);
    if (!opened || !available) return;
    if (preview) {
      setSessions(PREVIEW_FOREIGN_SESSIONS.filter(item => item.source === source));
      setWorkspaces(PREVIEW_IMPORT_WORKSPACES);
      return;
    }
    setLoading(true);
    void Promise.all([invokeUpgrade(client!, "session.import.list", { source }), client!.query("projects.list", {})])
      .then(([list, projects]) => {
        if (current !== listEpoch.current) return;
        setSessions(list.sessions); setWorkspaces(projects.workspaces);
      })
      .catch(cause => { if (current === listEpoch.current) setListError(hostErrorMessage(cause, zh ? "读取外部会话失败" : "Could not read external sessions")); })
      .finally(() => { if (current === listEpoch.current) setLoading(false); });
    return () => { listEpoch.current++; };
  }, [opened, available, source, preview, client, refresh, zh]);

  const needle = query.trim().toLocaleLowerCase();
  const visibleSessions = sessions.filter(item => item.source === source && `${item.title} ${item.directoryName} ${item.firstMessage ?? ""}`.toLocaleLowerCase().includes(needle));
  const selected = visibleSessions.find(item => item.sourceId === selectedId) ?? visibleSessions[0];
  const activeDetail = detail?.session.source === source && detail.session.sourceId === selected?.sourceId ? detail : undefined;
  const imported = result?.source === source && result.sourceId === selected?.sourceId ? result : undefined;
  const summary = activeDetail?.session ?? selected;

  useEffect(() => {
    const current = ++detailEpoch.current;
    setDetail(undefined); setResult(undefined); setFallback(""); setPreviewError(""); setImportError(""); setPreviewLoading(false); setImporting(false);
    if (!opened || !selected) return;
    setPreviewLoading(true);
    const read = preview
      ? Promise.resolve({ session: selected, preview: PREVIEW_IMPORT_PREVIEWS[selected.sourceId]! })
      : invokeUpgrade(client!, "session.import.preview", { source, sourceId: selected.sourceId });
    void read.then(value => { if (current === detailEpoch.current) setDetail(value); })
      .catch(cause => { if (current === detailEpoch.current) setPreviewError(hostErrorMessage(cause, zh ? "读取会话预览失败" : "Could not preview the session")); })
      .finally(() => { if (current === detailEpoch.current) setPreviewLoading(false); });
    return () => { detailEpoch.current++; };
  }, [opened, selected, source, preview, client, previewRefresh, zh]);

  async function run() {
    if (!selected || !activeDetail || !activeDetail.preview || importing || imported || (!activeDetail.session.cwdExists && !fallback)) return;
    const current = detailEpoch.current;
    setImporting(true); setImportError("");
    try {
      const value = preview ? { sessionId: "demo-import", workspaceId: fallback || "demo-import-workspace" }
        : await invokeUpgrade(client!, "session.import.execute", { source, sourceId: selected.sourceId, ...(!activeDetail.session.cwdExists ? { fallbackWorkspaceId: fallback } : {}) });
      if (!preview) onImported?.();
      if (current === detailEpoch.current) setResult({ ...value, source, sourceId: selected.sourceId });
    } catch (cause) {
      if (current === detailEpoch.current) setImportError(hostErrorMessage(cause, zh ? "导入会话失败" : "Could not import the session"));
    } finally {
      if (current === detailEpoch.current) setImporting(false);
    }
  }

  function openImported() {
    if (!imported) return;
    if (preview) onPreviewOpen?.();
    else onOpen(imported.sessionId, imported.workspaceId as WorkspaceId);
    setOpened(false);
  }
  const accept = () => { if (imported) openImported(); else void run(); };
  const metadata = (item: ForeignSessionSummary) => <>
    <span><Icon name="folder" extra="sm" />{item.directoryName}</span>
    <time dateTime={item.modifiedAt}>{sessionPickerTime(item.modifiedAt, resolvedLanguage)}</time>
    {item.messageCount !== undefined ? <span>{t("history.messagesCount", { count: item.messageCount })}</span> : null}
  </>;

  return <>
    <button type="button" className="btn small outline" aria-label={t("runtimeUpgrade.importTitle")} disabled={!available}
      data-tip={!available ? t("runtimeUpgrade.unavailable") : undefined} onClick={() => setOpened(true)}><Icon name="export" extra="sm" />{zh ? "导入会话" : "Import sessions"}</button>
    {opened ? <WorkspaceDialog title={t("runtimeUpgrade.importTitle")} onClose={() => setOpened(false)}>
      <div className="session-picker">
        <div className="session-picker-intro"><p>{zh ? "从 Claude 或 Codex 的已保存对话创建 OMP 会话。" : "Create an OMP session from a saved Claude or Codex conversation."}</p>{preview && marks ? <span className="chip gray xs">{t("common.demo")}</span> : null}</div>
        <div className="session-picker-toolbar">
          <fieldset className="session-picker-source" disabled={importing}><SlidingTabs<ForeignSource> id={`${id}-sources`} ariaLabel={zh ? "导入来源" : "Import source"} value={source} orientation="horizontal"
            onChange={value => { setSource(value); setQuery(""); }} items={[
              { id: "claude", label: "Claude", icon: "message", buttonId: `${id}-claude`, panelId: `${id}-claude-panel` },
              { id: "codex", label: "Codex", icon: "terminal", buttonId: `${id}-codex`, panelId: `${id}-codex-panel` },
            ]} /></fieldset>
          <SessionPickerSearch value={query} onChange={setQuery} onAccept={accept} label={zh ? "搜索外部会话…" : "Search external sessions…"} listRef={listRef} inputRef={searchRef} disabled={importing} />
          <button type="button" className="icon-btn" aria-label={zh ? "刷新外部会话" : "Refresh external sessions"} data-tip={t("common.refresh")} disabled={loading || importing} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" extra="sm" /></button>
        </div>
        <div className="session-picker-columns" role="tabpanel" id={`${id}-${source}-panel`} aria-labelledby={`${id}-${source}`}>
          <section className="session-picker-catalog" aria-label={zh ? "外部会话" : "External sessions"}>
            <div className="session-picker-list-heading"><span>{source === "claude" ? "Claude" : "Codex"} {zh ? "会话" : "sessions"}</span><output aria-live="polite">{loading ? "…" : visibleSessions.length}</output></div>
            {loading ? <div className="session-picker-loading" role="status"><Icon name="refresh" extra="sm" />{t("common.loading")}</div>
              : visibleSessions.length ? <SessionPickerList listRef={listRef} label={zh ? "可导入会话列表" : "Importable sessions"} selectedId={selected?.sourceId} onSelect={setSelectedId} onAccept={accept} disabled={importing}
                items={visibleSessions.map(item => ({ id: item.sourceId, title: item.title, metadata: metadata(item), excerpt: item.firstMessage, marker: !item.cwdExists ? <span className="session-picker-missing" role="img" aria-label={zh ? "原工作目录不存在" : "Original directory missing"} data-tip={zh ? "原工作目录不存在" : "Original directory missing"}><Icon name="alert" extra="sm" /></span> : undefined }))} />
              : <WorkspaceEmpty icon="message" title={!available || listError ? zh ? "外部会话暂时不可用" : "External sessions unavailable" : needle ? t("history.noMatches") : zh ? `没有找到 ${source === "claude" ? "Claude" : "Codex"} 会话` : `No ${source === "claude" ? "Claude" : "Codex"} sessions found`} />}
          </section>
          <aside className="session-picker-preview" aria-label={zh ? "导入会话预览" : "Import preview"}>
            <div className="session-picker-preview-scroll">
              {summary ? <div className="session-picker-preview-content" key={summary.sourceId}>
                <h3>{summary.title}</h3><div className="session-picker-meta">{metadata(summary)}</div>
                <h4>{zh ? "对话预览" : "Conversation preview"}</h4>
                {previewLoading ? <div className="session-picker-loading" role="status"><Icon name="refresh" extra="sm" />{t("common.loading")}</div>
                  : previewError ? <div className="session-picker-error" role="alert"><p>{previewError}</p><button type="button" className="btn small outline" onClick={() => setPreviewRefresh(value => value + 1)}>{zh ? "重新读取" : "Retry"}</button></div>
                    : activeDetail?.preview ? <MarkdownText text={activeDetail.preview} /> : <p className="tiny muted">{zh ? "这条会话没有可预览的消息。" : "This session has no messages to preview."}</p>}
              </div> : <WorkspaceEmpty icon="message" title={zh ? "选择会话查看预览" : "Select a session to preview"} />}
            </div>
            {summary && !summary.cwdExists && !imported ? <div className="session-picker-destination"><label><span className="session-picker-missing"><Icon name="alert" extra="sm" /> {t("runtimeUpgrade.importCwd")}</span>
              <AppSelect className="select" aria-label={zh ? "导入目标工作区" : "Import workspace"} value={fallback} disabled={importing} onChange={event => setFallback(event.target.value)}>
                <option value="">{zh ? "选择目标工作区…" : "Choose a workspace…"}</option>{workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.name}{workspace.active ? zh ? " · 当前" : " · current" : ""}</option>)}
              </AppSelect>
            </label></div> : null}
            {imported ? <div className="session-picker-result" role="status"><Icon name="check" extra="sm" /><span>{t("runtimeUpgrade.importDone")}</span></div> : null}
          </aside>
        </div>
        {listError ? <div className="session-picker-error" role="alert"><Icon name="alert-c" extra="sm" /><p>{listError}</p><button type="button" className="btn small outline" disabled={loading} onClick={() => setRefresh(value => value + 1)}>{zh ? "重新读取" : "Retry"}</button></div> : null}
        {importError ? <div className="session-picker-error" role="alert"><Icon name="alert-c" extra="sm" /><p>{importError}</p></div> : null}
        <footer className="session-picker-foot">
          <div className="session-picker-foot-note"><p>{imported ? zh ? "会话已就绪，可以在 OMP 中继续。" : "The session is ready to continue in OMP." : zh ? "导入为独立的 OMP 会话，保留原始消息。" : "Import as a separate OMP session with the original messages."}</p><SessionPickerKeys /></div>
          <button type="button" className="btn outline" onClick={() => setOpened(false)}>{t("common.close")}</button>
          {imported ? <button type="button" className="btn primary" onClick={openImported}><Icon name="arrow-r" extra="sm" />{t("common.open")}</button>
            : <button type="button" className="btn primary" disabled={loading || previewLoading || importing || !activeDetail?.preview || (!activeDetail.session.cwdExists && !fallback)} onClick={() => void run()}><Icon name="arrow-r" extra="sm" />{importing ? zh ? "正在导入…" : "Importing…" : t("runtimeUpgrade.importAction")}</button>}
        </footer>
      </div>
    </WorkspaceDialog> : null}
  </>;
}
