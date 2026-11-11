import { useEffect, useId, useState, type CSSProperties } from "react";
import type { McpRuntimeStatus, McpAuthResult } from "@omp-studio/studio-protocol";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { hostErrorMessage } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_MCP_RUNTIME, applyPreviewMcpAction } from "../preview/runtimeCatalogPreview";
import { CatalogEmpty, CatalogHeading, useRuntimeCatalog, type RuntimeCatalogProps } from "./RuntimeCatalogShared";
import { McpAuthActions } from "./McpAuthActions";
import "./mcpRuntime.css";

type Server = McpRuntimeStatus["servers"][number];
type Filter = "all" | "ready" | "pending" | "attention";

function ServerTools({ server, zh }: { server: Server; zh: boolean }) {
  return (
    <div className="runtime-mcp-tools">
      <div className="runtime-mcp-tools-heading">
        <span><Icon name="wrench" extra="xs" />{zh ? "会话工具" : "Session tools"}</span>
        <span>{zh ? "只读提示不代表授权，调用遵循当前审批策略。" : "Read-only hints describe behavior; calls follow your approval policy."}</span>
      </div>
      <div className="runtime-mcp-tool-list">
        {server.toolInfo?.map((tool) => (
          <div className="runtime-mcp-tool" key={tool.name}>
            <Icon name="file-code" extra="xs" />
            <div>
              <code>{tool.mcpToolName}</code>
              {tool.description ? <p>{tool.description}</p> : null}
              <span className="runtime-mcp-tool-identity">{tool.name}</span>
            </div>
            <span className={`runtime-mcp-tool-hint${tool.readOnlyHint === true ? " readonly" : ""}`}>
              <Icon name={tool.readOnlyHint === true ? "eye" : tool.readOnlyHint === false ? "pencil" : "issue"} extra="xs" />
              {tool.readOnlyHint === true ? (zh ? "只读提示" : "Read-only hint") : tool.readOnlyHint === false ? (zh ? "可修改提示" : "Mutable hint") : (zh ? "未声明" : "Unspecified")}
            </span>
          </div>
        ))}
      </div>
      {server.tools > (server.toolInfo?.length ?? 0) ? <p className="runtime-mcp-tools-limit">{zh ? `已显示 ${server.toolInfo?.length ?? 0} / ${server.tools} 个工具` : `Showing ${server.toolInfo?.length ?? 0} of ${server.tools} tools`}</p> : null}
    </div>
  );
}

function ServerRow({ server, paneId, zh, props, preview, authAvailable, onComplete }: {
  server: Server;
  paneId: string;
  zh: boolean;
  props: RuntimeCatalogProps;
  preview: boolean;
  authAvailable: boolean;
  onComplete(result: McpAuthResult): void;
}) {
  const [open, setOpen] = useState(false);
  const states = zh
    ? { ready: "工具就绪", pending: "连接 / 加载中", failed: "启动失败", disconnected: "未连接" }
    : { ready: "Tools ready", pending: "Connecting / loading", failed: "Startup failed", disconnected: "Disconnected" };
  const hasTools = !!server.toolInfo?.length;
  const source = server.source;
  const sourceLabel = source ? [source.providerName, source.level === "project" ? (zh ? "项目" : "Project") : source.level === "user" ? (zh ? "用户" : "User") : (zh ? "内置" : "Native")].join(" · ") : "";
  const toolsId = `${paneId}-tools`;
  return (
    <article className={`runtime-mcp-server state-${server.state}${open && hasTools ? " expanded" : ""}`} aria-label={server.name}>
      <div className="runtime-mcp-identity">
        <span className="runtime-mcp-server-icon"><Icon name={server.transport === "stdio" ? "terminal" : "server"} /></span>
        <div>
          <strong>{server.name}</strong>
          {server.transport || sourceLabel ? <span className="runtime-mcp-source">{server.transport ? <code>{server.transport.toUpperCase()}</code> : null}{sourceLabel ? <span>{sourceLabel}</span> : null}</span> : null}
        </div>
      </div>
      <span className={`runtime-mcp-state state-${server.state}`}><span className={server.state === "pending" ? "dot pulse" : undefined} aria-hidden="true" />{states[server.state]}</span>
      <button type="button" className="runtime-mcp-tool-toggle" disabled={!hasTools}
        aria-label={zh ? `查看 ${server.name} 的工具` : `View tools for ${server.name}`}
        aria-expanded={hasTools ? open : undefined} aria-controls={hasTools ? toolsId : undefined}
        onClick={() => setOpen(!open)}>
        <strong>{server.tools}</strong><span>{zh ? "个工具" : "tools"}</span>{hasTools ? <Icon name="chevron-d" extra="xs" /> : null}
      </button>
      {preview || authAvailable ? <McpAuthActions client={props.client} sessionId={props.sessionId} name={server.name}
        available={authAvailable} preview={preview} zh={zh} authSupported={server.transport !== "stdio"} previewScope={server.source?.level === "project" ? "project" : "user"} onComplete={onComplete} /> : <span className="runtime-mcp-actions-unavailable">{zh ? "连接操作不可用" : "Connection actions unavailable"}</span>}
      {server.error ? <p className="runtime-mcp-failure"><Icon name="alert-c" extra="xs" /><span>{server.error}</span></p> : null}
      {open && hasTools ? <div id={toolsId} className="runtime-mcp-tools-region"><ServerTools server={server} zh={zh} /></div> : null}
    </article>
  );
}

export function McpRuntimePane(props: RuntimeCatalogProps & { authAvailable?: boolean | undefined }) {
  const { client, sessionId, available, visible = true, authAvailable = false } = props;
  const { preview, marks } = usePreviewMode();
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const paneId = useId();
  const [status, setStatus] = useState<McpRuntimeStatus>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const invoke = useRuntimeCatalog(client, sessionId);

  useEffect(() => {
    setStatus(preview ? PREVIEW_MCP_RUNTIME : undefined);
    setError("");
    setRefreshing(false);
    setFilter("all");
    setSearch("");
  }, [preview, sessionId, available, client]);

  useEffect(() => {
    if (preview || !available || !sessionId || !visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (!document.hidden) {
          setRefreshing(true);
          const value = await invoke("mcp.runtime.status", { sessionId });
          if (active) { setStatus(value); setError(""); }
        }
      } catch (cause) {
        if (active) setError(hostErrorMessage(cause, zh ? "读取会话连接失败" : "Could not read session connections"));
      } finally {
        if (active) { setRefreshing(false); timer = setTimeout(() => void poll(), 4000); }
      }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [invoke, preview, sessionId, available, visible, refreshRevision, zh]);

  const onComplete = (result: McpAuthResult) => {
    if (preview) setStatus((current) => current ? applyPreviewMcpAction(current, result) : current);
    else setRefreshRevision((value) => value + 1);
  };
  const canRead = preview || (available && !!sessionId);
  const servers = status?.available ? status.servers : [];
  const ready = servers.filter((server) => server.state === "ready").length;
  const pending = servers.filter((server) => server.state === "pending").length;
  const attention = servers.length - ready - pending;
  const toolCount = servers.reduce((sum, server) => sum + server.tools, 0);
  const filtered = servers.filter((server) => {
    const matchesState = filter === "all" || (filter === "attention" ? server.state === "failed" || server.state === "disconnected" : server.state === filter);
    const text = [server.name, server.source?.providerName, ...(server.toolInfo?.map((tool) => `${tool.name} ${tool.mcpToolName} ${tool.description ?? ""}`) ?? [])].join(" ").toLowerCase();
    return matchesState && text.includes(search.trim().toLowerCase());
  });
  const overall = !status?.available ? (zh ? "状态未知" : "Readiness unknown") : status.ready ? (zh ? "全部就绪" : "All ready") : status.settled ? (zh ? "存在不可用连接" : "Some connections unavailable") : (zh ? "仍在等待" : "Still waiting");

  return (
    <section className="runtime-catalog-pane runtime-mcp-pane" lang={zh ? "zh-CN" : "en"} aria-label={zh ? "Runtime MCP 就绪状态" : "Runtime MCP readiness"}>
      <CatalogHeading title={zh ? "会话连接" : "Session connections"} scope={zh ? "MCP · 当前 Runtime" : "MCP · Current Runtime"}
        demo={preview && marks ? (zh ? "演示" : "Demo") : undefined}
        description={zh ? "查看当前会话的实际连接、工具就绪状态与授权。" : "Live connections, tool readiness, and authorization in this session."}
        actions={<button type="button" className="btn small outline" disabled={!canRead || refreshing} onClick={() => preview ? setStatus((current) => current ?? PREVIEW_MCP_RUNTIME) : setRefreshRevision((value) => value + 1)}><Icon name="refresh" extra="xs" />{refreshing ? (zh ? "刷新中…" : "Refreshing…") : (zh ? "刷新连接状态" : "Refresh connections")}</button>} />
      {error ? <p className="runtime-catalog-notice error" role="alert"><Icon name="alert-c" extra="xs" /><span>{error}{status ? (zh ? " · 下方保留上次读取的状态。" : " · The last observed status is shown below.") : ""}</span></p> : null}
      {status?.available ? <>
        <div className="runtime-mcp-overview">
          <div className="runtime-mcp-overview-title"><span className={`runtime-mcp-state ${error ? "state-disconnected" : status.ready ? "state-ready" : status.settled ? "state-failed" : "state-pending"}`}><span aria-hidden="true" />{error ? (zh ? "等待刷新" : "Awaiting refresh") : overall}</span><span className="runtime-mcp-startup"><Icon name="clock" extra="xs" />{zh ? "启动等待" : "Startup wait"}<code>{status.startupTimeoutMs === 0 ? (zh ? "等待全部连接" : "Wait for all") : `${status.startupTimeoutMs} ms`}</code></span></div>
          <div className="runtime-mcp-metrics">
            <div className="runtime-mcp-metric"><strong>{ready}<small> / {servers.length}</small></strong><span>{zh ? "已就绪服务器" : "Servers ready"}</span></div>
            <div className="runtime-mcp-metric"><strong>{toolCount}</strong><span>{zh ? "已加载工具" : "Loaded tools"}</span></div>
            <div className="runtime-mcp-metric pending"><strong>{pending}</strong><span>{zh ? "正在连接" : "Connecting"}</span></div>
            <div className="runtime-mcp-metric attention"><strong>{attention}</strong><span>{zh ? "需要关注" : "Needs attention"}</span></div>
          </div>
          {servers.length ? <div className="runtime-mcp-readiness-track" aria-hidden="true">{([["ready", ready], ["pending", pending], ["attention", attention]] as const).map(([state, count]) => <span key={state} className={`state-${state}`} style={{ "--server-share": `${count / servers.length * 100}%` } as CSSProperties} />)}</div> : null}
        </div>
        <div className="runtime-mcp-toolbar">
          <div className="runtime-catalog-filters" aria-label={zh ? "连接状态筛选" : "Filter connection state"}>{([["all", zh ? "全部" : "All", servers.length], ["ready", zh ? "已就绪" : "Ready", ready], ["pending", zh ? "连接中" : "Connecting", pending], ["attention", zh ? "需关注" : "Attention", attention]] as const).map(([value, label, count]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}<span>{count}</span></button>)}</div>
          <div className="runtime-catalog-search"><Icon name="search" extra="xs" /><input type="search" aria-label={zh ? "筛选会话服务器或工具" : "Filter session servers or tools"} placeholder={zh ? "搜索服务器或工具…" : "Search servers or tools…"} value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        </div>
        {filtered.length ? <div className="runtime-mcp-rows">
          <div className="runtime-mcp-columns" aria-hidden="true"><span>{zh ? "服务器 / 连接方式" : "Server / transport"}</span><span>{zh ? "会话状态" : "Session status"}</span><span>{zh ? "工具" : "Tools"}</span><span>{zh ? "连接操作" : "Connection actions"}</span></div>
          {filtered.map((server, index) => <ServerRow key={`${preview ? "preview" : sessionId}-${server.name}`} server={server} paneId={`${paneId}-${index}`} zh={zh} props={props} preview={preview} authAvailable={authAvailable} onComplete={onComplete} />)}
        </div> : <CatalogEmpty icon="plug" title={servers.length ? (zh ? "没有匹配的连接" : "No matching connections") : (zh ? "当前会话没有 MCP 服务器" : "No MCP servers in this session")}>{servers.length ? (zh ? "调整状态筛选或搜索关键词。" : "Try another status filter or search term.") : (zh ? "添加服务器配置后，在新会话中加载。" : "Add a server configuration, then load it in a new session.")}</CatalogEmpty>}
        <footer className="runtime-catalog-footnote"><Icon name="pulse" extra="xs" /><span>{zh ? "会话状态自动更新。服务器配置页的连接测试是独立探测。" : "Session status updates automatically. Configuration tests are separate probes."}</span>{status.total > servers.length ? <span>{zh ? `显示 ${servers.length} / ${status.total} 个服务器` : `Showing ${servers.length} of ${status.total} servers`}</span> : null}</footer>
      </> : <CatalogEmpty icon={canRead && !status ? "pulse" : "plug"} title={status ? (zh ? "本会话未启用 MCP" : "MCP is not active in this session") : canRead ? (error ? (zh ? "连接状态暂不可用" : "Connection status unavailable") : (zh ? "读取会话连接…" : "Reading session connections…")) : (zh ? "连接活动会话后可用" : "Connect an active session")}>{status ? (zh ? "MCP 可能尚未初始化或已禁用。服务器配置仍可在另一页签管理。" : "MCP may be disabled or uninitialized. Server configurations are available in the other tab.") : canRead ? (zh ? "读取当前 Runtime 的实际工具就绪状态。" : "Read the actual tool readiness from the current Runtime.") : (zh ? "连接后可查看实际状态，并重新授权或重连服务器。" : "Read live status, re-authorize, or reconnect servers once a session is connected.")}</CatalogEmpty>}
    </section>
  );
}
