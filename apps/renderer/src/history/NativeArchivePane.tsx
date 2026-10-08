import { useEffect, useRef, useState } from "react";
import type {
  ClientBootstrap,
  StudioClient,
  CommandInput,
} from "@omp-studio/client-contract";
import type {
  ArchiveResultMap,
  NativeArchiveSession,
  NativeArchiveText,
  NativeArchiveDetail,
} from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import {
  previewArchiveSessions,
  previewArchiveTexts,
  previewArchiveDetail,
} from "../preview/archivePreview";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceEmpty, WorkspaceStatus } from "../workspaces/Workspace";
import "./archive.css";
type View = "sessions" | "recaps" | "prompts";
export interface NativeHistoryContext {
  sessionId?: string | undefined;
  available: boolean;
  capabilities?: ClientBootstrap["capabilityManifest"] | undefined;
}
export function NativeArchivePane({
  client,
  context,
  active,
  canOpen,
  onOpen,
}: {
  client?: StudioClient | undefined;
  context?: NativeHistoryContext | undefined;
  active: boolean;
  canOpen(sessionId: string): boolean;
  onOpen(sessionId: string): void;
}) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [view, setView] = useState<View>("sessions"),
    [scope, setScope] = useState<"workspace" | "all">("workspace");
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [sessions, setSessions] = useState<NativeArchiveSession[]>([]),
    [texts, setTexts] = useState<NativeArchiveText[]>([]);
  const [detail, setDetail] = useState<NativeArchiveDetail>(),
    [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false),
    [detailBusy, setDetailBusy] = useState(false),
    [error, setError] = useState(""),
    [detailError, setDetailError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const epoch = useRef(0),
    detailEpoch = useRef(0),
    previousContext = useRef("");
  const kind =
    view === "sessions"
      ? "archive.sessions.list"
      : view === "recaps"
        ? "archive.recaps.list"
        : "archive.prompts.search";
  const cap = (id: string) =>
    context?.capabilities?.capabilities.some(
      (row) => row.id === id && row.grade !== "unavailable",
    ) === true;
  const enabled =
    preview ||
    !!(client && context?.sessionId && context.available && cap(kind));
  const inspectEnabled = preview || cap("archive.session.inspect");
  async function read<K extends keyof ArchiveResultMap>(
    name: K,
    input: CommandInput<K>,
  ): Promise<ArchiveResultMap[K]> {
    const handle = await client!.command(name, input);
    return (
      await waitReceipt<{ result: ArchiveResultMap[K] }>(
        client!,
        handle.requestId,
      )
    ).result;
  }
  useEffect(() => {
    const current = ++epoch.current;
    detailEpoch.current++;
    setBusy(false);
    setDetailBusy(false);
    setError("");
    setDetailError("");
    if (!active || !enabled) return;
    setBusy(true);
    const key = [context?.sessionId, scope, preview].join(":");
    if (previousContext.current !== key) {
      setDetail(undefined);
      setSelected("");
      previousContext.current = key;
    }
    const load = async () => {
      try {
        const args = { sessionId: context?.sessionId ?? "", scope };
        if (preview) {
          setSessions(previewArchiveSessions());
          setTexts(previewArchiveTexts(view, search));
          setTruncated(false);
          return;
        }
        if (view === "sessions") {
          const result = await read("archive.sessions.list", args);
          if (current !== epoch.current) return;
          setSessions(result.rows);
          setTruncated(result.truncated);
        } else {
          const result =
            view === "recaps"
              ? await read("archive.recaps.list", args)
              : await read("archive.prompts.search", {
                  ...args,
                  query: search,
                });
          if (current !== epoch.current) return;
          setTexts(result.rows);
          setTruncated(result.truncated);
        }
      } catch (cause) {
        if (current === epoch.current)
          setError(
            hostErrorMessage(
              cause,
              zh ? "历史查询失败" : "History query failed",
            ),
          );
      } finally {
        if (current === epoch.current) setBusy(false);
      }
    };
    void load();
    return () => {
      epoch.current++;
      detailEpoch.current++;
    };
  }, [
    client,
    context?.sessionId,
    active,
    enabled,
    view,
    scope,
    search,
    refresh,
    preview,
    zh,
  ]);
  async function inspect(id: string) {
    const current = ++detailEpoch.current;
    setSelected(id);
    setDetail(undefined);
    setDetailError("");
    setDetailBusy(true);
    try {
      const result = preview
        ? previewArchiveDetail(id)
        : await read("archive.session.inspect", {
            sessionId: context!.sessionId!,
            targetSessionId: id,
          });
      if (current === detailEpoch.current) setDetail(result);
    } catch (cause) {
      if (current === detailEpoch.current)
        setDetailError(
          hostErrorMessage(
            cause,
            zh ? "会话详情不可用" : "Session details unavailable",
          ),
        );
    } finally {
      if (current === detailEpoch.current) setDetailBusy(false);
    }
  }
  const stamp = (date: string) =>
    new Date(date).toLocaleString(zh ? "zh-CN" : "en-US");
  const renderText = (row: NativeArchiveText, index: number) => (
    <article key={index} className="archive-text-row">
      <div className="archive-meta">
        <time dateTime={row.at}>{stamp(row.at)}</time>
        {scope === "all" && row.project ? <span>{row.project}</span> : null}
        {row.uses !== undefined ? (
          <span>
            {zh ? "使用" : "Used"} {row.uses}
          </span>
        ) : null}
      </div>
      <p>{row.text}</p>
      {row.truncated ? (
        <small>
          {zh ? "内容较长，显示摘要" : "Long content; showing an excerpt"}
        </small>
      ) : null}
      {row.sessionId ? (
        <details>
          <summary>{zh ? "会话标识" : "Session identity"}</summary>
          <code>{row.sessionId}</code>
        </details>
      ) : null}
    </article>
  );
  return (
    <section
      className="native-archive"
      aria-label={zh ? "原生历史查询" : "Native history"}
    >
      <header className="workspace-section-heading">
        <div>
          <h2>
            Archive / Recap{" "}
            {preview ? (
              <span className="chip gray xs">{zh ? "演示" : "Demo"}</span>
            ) : null}
          </h2>
          <p>
            {zh
              ? "查询 OMP 保存的会话、空闲回顾和提示词历史。结果保留原始会话身份。"
              : "Browse native sessions, idle recaps and prompt history with their original session identities."}
          </p>
        </div>
      </header>
      <form
        className="archive-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query.trim());
          setRefresh((v) => v + 1);
        }}
      >
        <label>
          {zh ? "内容" : "Content"}
          <select
            className="select"
            value={view}
            onChange={(event) => setView(event.target.value as View)}
          >
            <option value="sessions">{zh ? "会话" : "Sessions"}</option>
            <option value="recaps">{zh ? "回顾" : "Recaps"}</option>
            <option value="prompts">{zh ? "提示词" : "Prompts"}</option>
          </select>
        </label>
        <label>
          {zh ? "范围" : "Scope"}
          <select
            className="select"
            value={scope}
            onChange={(event) =>
              setScope(event.target.value as "workspace" | "all")
            }
          >
            <option value="workspace">
              {zh ? "当前工作区" : "Current workspace"}
            </option>
            <option value="all">{zh ? "全部工作区" : "All workspaces"}</option>
          </select>
        </label>
        {view === "prompts" ? (
          <label className="archive-search">
            {zh ? "搜索提示词" : "Search prompts"}
            <input
              className="input"
              type="search"
              maxLength={256}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        ) : null}
        <button className="btn outline" disabled={!enabled || busy}>
          {view === "prompts"
            ? zh
              ? "搜索"
              : "Search"
            : zh
              ? "刷新"
              : "Refresh"}
        </button>
      </form>
      {!enabled ? (
        <WorkspaceEmpty
          title={zh ? "原生历史暂不可用" : "Native history unavailable"}
        >
          {context?.available
            ? zh
              ? "当前 Runtime 尚未提供此查询能力。"
              : "This Runtime does not support this query."
            : zh
              ? "连接 Runtime 后可读取已保存的历史。"
              : "Connect the Runtime to read saved history."}
        </WorkspaceEmpty>
      ) : error ? (
        <p role="alert" className="archive-error">
          {error}
        </p>
      ) : busy ? (
        <p role="status">{zh ? "读取中…" : "Loading…"}</p>
      ) : (
        <div className="archive-columns">
          <div className="archive-results">
            {view === "sessions" ? (
              sessions.length ? (
                sessions.map((row) => (
                  <button
                    type="button"
                    className={
                      "archive-session" +
                      (selected === row.id ? " selected" : "")
                    }
                    aria-pressed={selected === row.id}
                    disabled={!inspectEnabled}
                    key={row.id}
                    onClick={() => void inspect(row.id)}
                  >
                    <strong>{row.title || row.id}</strong>
                    <span className="archive-meta">
                      {row.project} · {stamp(row.modified)} · {row.messages}{" "}
                      {zh ? "条消息" : "messages"}
                    </span>
                    {row.status ? <WorkspaceStatus state={row.status} /> : null}
                    {row.recap ? (
                      <span className="archive-excerpt">{row.recap}</span>
                    ) : null}
                    {row.truncated ? (
                      <small>
                        {zh ? "长内容已截断" : "Long content is truncated"}
                      </small>
                    ) : null}
                  </button>
                ))
              ) : (
                <WorkspaceEmpty
                  title={zh ? "没有可读取的会话" : "No readable sessions"}
                />
              )
            ) : texts.length ? (
              texts.map(renderText)
            ) : (
              <WorkspaceEmpty
                title={zh ? "暂无匹配的历史" : "No matching history"}
              />
            )}
            {truncated ? (
              <p className="tiny muted">
                {zh
                  ? "仅显示最近 20 项。缩小范围或搜索提示词可定位其他记录。"
                  : "Showing the latest 20 entries. Narrow the scope or search prompts to find other records."}
              </p>
            ) : null}
          </div>
          {view === "sessions" ? (
            <aside className="archive-detail">
              {detailBusy ? (
                <p role="status">
                  {zh ? "读取会话详情…" : "Loading session details…"}
                </p>
              ) : detailError ? (
                <p role="alert" className="archive-error">
                  {detailError}
                </p>
              ) : detail ? (
                <>
                  <h3>{detail.session.title}</h3>
                  <details>
                    <summary>{zh ? "会话详情" : "Session details"}</summary>
                    <dl>
                      <dt>{zh ? "完整 ID" : "Full ID"}</dt>
                      <dd>{detail.session.id}</dd>
                      <dt>{zh ? "创建时间" : "Created"}</dt>
                      <dd>{stamp(detail.session.created)}</dd>
                    </dl>
                  </details>
                  <button
                    className="btn outline"
                    disabled={!preview && !canOpen(detail.session.id)}
                    onClick={() => {
                      if (!preview) onOpen(detail.session.id);
                    }}
                  >
                    {preview
                      ? zh
                        ? "演示会话"
                        : "Demo session"
                      : zh
                        ? "打开会话"
                        : "Open session"}
                  </button>
                  {!preview && !canOpen(detail.session.id) ? (
                    <p className="tiny muted">
                      {zh
                        ? "当前 Studio 会话目录尚未收录此记录；刷新历史目录后再打开。"
                        : "This entry is not in the current Studio catalog. Refresh the catalog before opening."}
                    </p>
                  ) : null}
                  <h4>{zh ? "空闲回顾" : "Idle recaps"}</h4>
                  {detail.recaps.length ? (
                    detail.recaps.map(renderText)
                  ) : (
                    <p className="muted tiny">
                      {zh ? "没有已保存的回顾" : "No saved recaps"}
                    </p>
                  )}
                  <h4>{zh ? "近期提示词" : "Recent prompts"}</h4>
                  {detail.prompts.map(renderText)}
                  {detail.truncated ? (
                    <p className="tiny muted">
                      {zh
                        ? "详情显示最近记录及文本摘要。"
                        : "Details show recent entries and text excerpts."}
                    </p>
                  ) : null}
                </>
              ) : (
                <WorkspaceEmpty
                  title={
                    zh ? "选择会话查看详情" : "Select a session for details"
                  }
                />
              )}
            </aside>
          ) : null}
        </div>
      )}
    </section>
  );
}
