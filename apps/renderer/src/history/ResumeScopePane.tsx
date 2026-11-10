import { useEffect, useRef, useState } from "react";
import type { StudioClient, WorkspaceId } from "@omp-studio/client-contract";
import type { SessionResumeRow, SessionWorktreeResultMap } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { Icon } from "../icons";
import { MarkdownText } from "../conversation/markdown";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_RESUME_SESSIONS } from "../preview/resumeScopePreview";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceDialog, WorkspaceEmpty, WorkspaceStatus } from "../workspaces/Workspace";
import { SessionPickerKeys, SessionPickerList, SessionPickerSearch, sessionPickerTime } from "./SessionPicker";
import type { NativeHistoryContext } from "./NativeArchivePane";

export function ResumeScopePane({ client, context, onOpen, onPreviewOpen }: {
  client?: StudioClient | undefined;
  context?: NativeHistoryContext | undefined;
  onOpen?: ((sessionId: string, workspaceId: WorkspaceId) => void) | undefined;
  onPreviewOpen?: (() => void) | undefined;
}) {
  const { preview, marks } = usePreviewMode();
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [opened, setOpened] = useState(false);
  // A missing override asks OMP for its configured default, rather than guessing it in the UI.
  const [scope, setScope] = useState<"directory" | "repo">();
  const [resolvedScope, setResolvedScope] = useState<"directory" | "repo">("repo");
  const [rows, setRows] = useState<SessionResumeRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const enabled = preview || !!(client && context?.available && context.sessionId && context.capabilities?.capabilities.some(row => row.id === "worktrees.session.resume.list" && row.grade !== "unavailable"));

  useEffect(() => {
    if (opened) searchRef.current?.focus();
  }, [opened]);

  useEffect(() => {
    const current = ++epoch.current;
    setRows([]); setError(""); setLoading(false); setResuming(false); setTruncated(false);
    if (!opened || !enabled) return;
    if (preview) {
      setRows(PREVIEW_RESUME_SESSIONS.filter(row => scope !== "directory" || row.currentDirectory));
      setResolvedScope(scope ?? "repo");
      return;
    }
    setLoading(true);
    void client!.command("worktrees.session.resume.list", { sessionId: context!.sessionId!, ...(scope ? { scope } : {}) })
      .then(handle => waitReceipt<{ result: SessionWorktreeResultMap["worktrees.session.resume.list"] }>(client!, handle.requestId))
      .then(({ result }) => {
        if (current !== epoch.current) return;
        setRows(result.sessions); setTruncated(result.truncated); setResolvedScope(result.scope);
      })
      .catch(cause => { if (current === epoch.current) setError(hostErrorMessage(cause, zh ? "读取会话失败" : "Could not read sessions")); })
      .finally(() => { if (current === epoch.current) setLoading(false); });
    return () => { epoch.current++; };
  }, [opened, preview, client, context?.sessionId, enabled, scope, refresh, zh]);

  const needle = query.trim().toLocaleLowerCase();
  const visibleRows = rows.filter(row => `${row.title} ${row.directoryName ?? ""} ${row.firstMessage ?? ""} ${row.conversationExcerpt ?? ""}`.toLocaleLowerCase().includes(needle));
  const selected = visibleRows.find(row => row.sessionId === selectedId) ?? visibleRows[0];

  async function resume() {
    if (!selected || loading || resuming) return;
    if (preview) { setOpened(false); onPreviewOpen?.(); return; }
    if (!client || !context?.sessionId || !onOpen) return;
    const current = epoch.current;
    setResuming(true); setError("");
    try {
      const handle = await client.command("worktrees.session.resume.prepare", { sessionId: context.sessionId, targetSessionId: selected.sessionId, scope: scope ?? resolvedScope });
      const { result } = await waitReceipt<{ result: SessionWorktreeResultMap["worktrees.session.resume.prepare"] }>(client, handle.requestId);
      if (current !== epoch.current) return;
      if (!result.workspaceId) throw Error(zh ? "目标工作区不可用" : "The target workspace is unavailable");
      onOpen(result.targetSessionId, result.workspaceId as WorkspaceId);
      setOpened(false);
    } catch (cause) {
      if (current === epoch.current) setError(hostErrorMessage(cause, zh ? "恢复会话失败" : "Could not resume the session"));
    } finally {
      if (current === epoch.current) setResuming(false);
    }
  }

  const location = (row: SessionResumeRow) => row.currentDirectory ? zh ? "当前目录" : "This directory" : zh ? "关联 Worktree" : "Sibling worktree";
  const metadata = (row: SessionResumeRow) => <>
    <span><Icon name={row.currentDirectory ? "folder" : "branch"} extra="sm" />{row.directoryName || location(row)}</span>
    <time dateTime={row.modifiedAt}>{sessionPickerTime(row.modifiedAt, resolvedLanguage)}</time>
    {row.messageCount !== undefined ? <span>{t("history.messagesCount", { count: row.messageCount })}</span> : null}
  </>;

  return <>
    <button type="button" className="btn small outline" disabled={!enabled}
      data-tip={!enabled ? zh ? "连接 Runtime 后可浏览 OMP 会话" : "Connect the Runtime to browse OMP sessions" : undefined}
      onClick={() => setOpened(true)}><Icon name="history" extra="sm" />{zh ? "恢复 OMP 会话" : "Resume OMP session"}</button>
    {opened ? <WorkspaceDialog title={zh ? "恢复 OMP 会话" : "Resume OMP session"} onClose={() => setOpened(false)}>
      <div className="session-picker">
        <div className="session-picker-intro"><p>{zh ? "查找已保存的会话，预览后继续对话。" : "Find a saved session, preview it, and continue the conversation."}</p>{preview && marks ? <span className="chip gray xs">{t("common.demo")}</span> : null}</div>
        <div className="session-picker-toolbar">
          <SessionPickerSearch value={query} onChange={setQuery} onAccept={() => void resume()} label={zh ? "搜索会话标题、目录或摘要…" : "Search titles, folders or excerpts…"} listRef={listRef} inputRef={searchRef} disabled={resuming} />
          <AppSelect className="select" aria-label={zh ? "恢复范围" : "Resume scope"} value={scope ?? resolvedScope} disabled={loading || resuming} onChange={event => setScope(event.target.value as "directory" | "repo")}>
            <option value="directory">{zh ? "仅当前目录" : "This directory"}</option><option value="repo">{zh ? "同仓库 Worktree" : "Repository worktrees"}</option>
          </AppSelect>
          <button type="button" className="icon-btn" aria-label={zh ? "刷新 OMP 会话" : "Refresh OMP sessions"} data-tip={t("common.refresh")} disabled={loading || resuming} onClick={() => setRefresh(value => value + 1)}><Icon name="refresh" extra="sm" /></button>
        </div>
        <div className="session-picker-columns">
          <section className="session-picker-catalog" aria-label={zh ? "可恢复会话" : "Resumable sessions"}>
            <div className="session-picker-list-heading"><span>{zh ? "最近会话" : "Recent sessions"}</span><output aria-live="polite">{loading ? "…" : visibleRows.length}</output></div>
            {loading ? <div className="session-picker-loading" role="status"><Icon name="refresh" extra="sm" />{t("common.loading")}</div>
              : visibleRows.length ? <SessionPickerList listRef={listRef} label={zh ? "OMP 会话列表" : "OMP sessions"} selectedId={selected?.sessionId} onSelect={setSelectedId} onAccept={() => void resume()} disabled={resuming}
                items={visibleRows.map(row => ({ id: row.sessionId, title: row.title, metadata: metadata(row), excerpt: row.firstMessage, marker: row.continuationOf ? <span role="img" aria-label={zh ? "继续副本" : "Continuing copy"}><Icon name="fork" extra="sm" /></span> : undefined }))} />
              : <WorkspaceEmpty icon="history" title={!enabled || error ? zh ? "会话暂时不可用" : "Sessions unavailable" : needle ? t("history.noMatches") : zh ? "这个范围内还没有会话" : "No sessions in this scope"} />}
          </section>
          <aside className="session-picker-preview" aria-label={zh ? "恢复会话预览" : "Session preview"}>
            <div className="session-picker-preview-scroll">
              {selected ? <div className="session-picker-preview-content" key={selected.sessionId}>
                <h3>{selected.title}</h3>
                <div className="session-picker-meta">{metadata(selected)}{selected.status ? <WorkspaceStatus state={selected.status} /> : null}</div>
                <div className="session-picker-meta"><span>{location(selected)}</span>{selected.continuationOf ? <span><Icon name="fork" extra="sm" />{zh ? "继续副本" : "Continuing copy"}</span> : null}</div>
                {selected.firstMessage ? <><h4>{zh ? "首条请求" : "First request"}</h4><div className="session-picker-prompt"><MarkdownText text={selected.firstMessage} /></div></> : null}
                {selected.conversationExcerpt ? <><h4>{zh ? "对话摘录" : "Conversation excerpt"}</h4><MarkdownText text={selected.conversationExcerpt} /></> : null}
                {!selected.firstMessage && !selected.conversationExcerpt ? <p className="tiny muted">{zh ? "这条记录暂未提供对话摘要，可直接恢复后查看。" : "This record has no conversation excerpt. Resume it to read the conversation."}</p> : null}
                {selected.continuationOf ? <p className="session-picker-continuation"><Icon name="fork" extra="sm" /><span>{zh ? "恢复时会跟随迁移后的继续副本，打开实际可继续的会话。" : "Resume follows the continuing copy after a move and opens the session you can continue."}</span></p> : null}
              </div> : <WorkspaceEmpty icon="message" title={zh ? "选择会话查看预览" : "Select a session to preview"} />}
            </div>
          </aside>
        </div>
        {error ? <div className="session-picker-error" role="alert"><Icon name="alert-c" extra="sm" /><p>{error}</p><button type="button" className="btn small outline" disabled={loading || resuming} onClick={() => setRefresh(value => value + 1)}>{zh ? "重新读取" : "Retry"}</button></div> : null}
        <footer className="session-picker-foot">
          <div className="session-picker-foot-note"><p>{zh ? "恢复时切换到会话所属工作区。" : "Resume switches to the session's workspace."}{truncated ? zh ? " 仅列出最近 200 条会话。" : " Showing the latest 200 sessions." : ""}</p><SessionPickerKeys /></div>
          <button type="button" className="btn outline" onClick={() => setOpened(false)}>{t("common.cancel")}</button>
          <button type="button" className="btn primary" disabled={!enabled || !selected || loading || resuming || (!preview && !onOpen)} onClick={() => void resume()}><Icon name="arrow-r" extra="sm" />{resuming ? zh ? "正在恢复…" : "Resuming…" : zh ? "恢复会话" : "Resume session"}</button>
        </footer>
      </div>
    </WorkspaceDialog> : null}
  </>;
}
