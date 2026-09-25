import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput, StudioClient } from "@omp-studio/client-contract";
import type { McpRuntimeStatus, PromptTemplateRow, RuntimeCatalogResultMap } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { PREVIEW_MCP_RUNTIME, PREVIEW_TEMPLATE, PREVIEW_TEMPLATE_TEXT } from "../preview/runtimeCatalogPreview";
import "./runtimeCatalog.css";

interface Props { client: StudioClient; sessionId?: string | undefined; available: boolean }
function useCatalog(client: StudioClient, sessionId?: string) {
  return useCallback(async <K extends keyof RuntimeCatalogResultMap>(kind: K, input: CommandInput<K>): Promise<RuntimeCatalogResultMap[K]> => {
    if (!sessionId) throw new Error("No active Runtime session");
    const handle = await client.command(kind, input);
    return (await waitReceipt<{ result: RuntimeCatalogResultMap[K] }>(client, handle.requestId)).result;
  }, [client, sessionId]);
}
export function McpRuntimePane({ client, sessionId, available }: Props) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [status, setStatus] = useState<McpRuntimeStatus>(); const [error, setError] = useState("");
  const invoke = useCatalog(client, sessionId);
  useEffect(() => {
    setError(""); setStatus(preview ? PREVIEW_MCP_RUNTIME : undefined);
    if (preview || !available || !sessionId) return;
    let active = true; let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { if (!document.hidden) { const value = await invoke("mcp.runtime.status", { sessionId }); if (active) { setStatus(value); setError(""); } } }
      catch (cause) { if (active) { setError(hostErrorMessage(cause, "Runtime MCP status unavailable")); setStatus(undefined); } }
      finally { if (active) timer = setTimeout(() => void poll(), 4000); }
    };
    void poll(); return () => { active = false; clearTimeout(timer); };
  }, [invoke, preview, sessionId, available]);
  const states = zh ? { ready: "工具就绪", pending: "连接 / 加载中", failed: "启动失败", disconnected: "未连接" } : { ready: "Tools ready", pending: "Connecting / loading", failed: "Startup failed", disconnected: "Disconnected" };
  return <section className="runtime-catalog-pane" aria-label={zh ? "Runtime MCP 就绪状态" : "Runtime MCP readiness"}>
    <h3>{zh ? "当前 Runtime" : "Current Runtime"}{preview ? zh ? " · 演示" : " · Demo" : ""}</h3>
    <p className="small muted">{zh ? "这里显示当前会话的实际连接与工具就绪状态。下方配置列表的测试结果是独立探测。" : "Actual connections and tool readiness in this session. Tests in the configuration list below are separate probes."}</p>
    {error ? <p role="alert">{error}</p> : null}
    {status ? <><p className="small">{zh ? "启动等待设置" : "Startup wait setting"}: {status.startupTimeoutMs === 0 ? zh ? "等待所有初始连接" : "Wait for all initial connections" : `${status.startupTimeoutMs} ms`} · {!status.available ? zh ? "就绪状态未知" : "Readiness unknown" : status.ready ? zh ? "全部就绪" : "All ready" : status.settled ? zh ? "已结束，存在不可用项" : "Settled with unavailable servers" : zh ? "仍在等待" : "Still waiting"}</p>
      {!status.available ? <p className="muted">{zh ? "本会话没有可用的 MCP Manager，可能尚未初始化或已禁用。" : "This session has no MCP manager; it may be disabled or uninitialized."}</p> : <div className="runtime-mcp-rows">{status.servers.map((server, index) => <div key={server.name + index}><strong>{server.name}</strong><span className={`chip xs ${server.state === "ready" ? "green" : server.state === "pending" ? "amber" : "gray"}`}>{states[server.state]}</span><span className="small muted">{server.tools} {zh ? "个工具" : "tools"}</span></div>)}{!status.servers.length ? <p className="small muted">{zh ? "当前 Runtime 没有发现 MCP 服务器。" : "No MCP servers discovered in this Runtime."}</p> : null}{status.total > status.servers.length ? <p>{zh ? "仅显示前 500 项" : "Showing the first 500 servers"}</p> : null}</div>}
    </> : <p className="muted">{available && sessionId ? zh ? "读取 Runtime 状态…" : "Reading Runtime status…" : zh ? "连接活动会话后可读取实际就绪状态。" : "Connect an active session to read readiness."}</p>}
  </section>;
}

export function PromptTemplatesPane({ client, sessionId, available, onInsert }: Props & { onInsert?: ((text: string) => void) | undefined }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [rows, setRows] = useState<PromptTemplateRow[]>([]); const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState<PromptTemplateRow>(); const [content, setContent] = useState(""); const [args, setArgs] = useState("");
  const [prepared, setPrepared] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const generation = useRef(0); const busyRef = useRef(false); const invoke = useCatalog(client, sessionId);
  const load = useCallback(async (after?: string) => {
    const epoch = generation.current;
    if (preview) { setRows([PREVIEW_TEMPLATE]); setCursor(undefined); return; }
    if (!available || !sessionId) { setRows([]); return; }
    const result = await invoke("templates.list", { sessionId, ...(after ? { cursor: after } : {}), limit: 50 });
    if (epoch === generation.current) { setRows(current => after ? [...current, ...result.templates] : result.templates); setCursor(result.nextCursor); }
  }, [invoke, sessionId, available, preview]);
  useEffect(() => {
    generation.current++; busyRef.current = false; setBusy(false); setRows([]); setSelected(undefined); setContent(""); setArgs(""); setPrepared(""); setError("");
    const epoch = generation.current;
    void load().catch(cause => { if (epoch === generation.current) setError(hostErrorMessage(cause, "Prompt templates unavailable")); });
    return () => { generation.current++; };
  }, [load]);
  const run = async (action: (epoch: number) => Promise<void>) => {
    if (busyRef.current) return;
    const epoch = generation.current; busyRef.current = true; setBusy(true); setError("");
    try { await action(epoch); } catch (cause) { if (epoch === generation.current) setError(hostErrorMessage(cause, "Template operation failed")); }
    finally { if (epoch === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const canRead = preview || (available && !!sessionId);
  return <section className="runtime-catalog-pane" aria-label={zh ? "提示词模板" : "Prompt templates"}>
    <div className="runtime-template-toolbar"><h3>{zh ? "提示词模板" : "Prompt templates"}{preview ? zh ? " · 演示" : " · Demo" : ""}</h3><button className="btn small outline" disabled={busy || !canRead} onClick={() => void run(async () => { setSelected(undefined); setPrepared(""); setContent(""); await load(); })}>{zh ? "刷新模板列表" : "Refresh templates"}</button></div>
    <p className="small muted">{zh ? "当前会话已加载的用户 / 项目模板。支持上游位置参数和模板语法；先预览展开结果，再放入主对话输入框。磁盘模板修改后需重建运行会话。" : "User/project templates loaded by the current session. Uses native positional arguments and template syntax. Preview the expansion, then insert it into the main Composer. Recreate the Runtime session after editing template files."}</p>
    {error ? <p role="alert">{error}</p> : null}
    {!canRead ? <p className="muted">{zh ? "连接活动会话后可用。" : "Connect an active session to use templates."}</p> : null}
    <div className="runtime-template-layout"><div className="runtime-template-list">{rows.map(row => <button key={row.id} className={selected?.id === row.id ? "selected" : ""} disabled={busy} onClick={() => void run(async epoch => {
      setPrepared(""); setContent(""); setArgs("");
      const value = preview ? { template: row, content: PREVIEW_TEMPLATE_TEXT } : await invoke("templates.get", { sessionId: sessionId!, id: row.id, version: row.version });
      if (epoch === generation.current) { setSelected(value.template); setContent(value.content); }
    })}><strong>{row.name}</strong><span className="small muted">{row.description}</span><span className="small">{row.source}</span></button>)}{canRead && !rows.length ? <p className="muted">{zh ? "当前会话没有已加载模板。" : "No templates are loaded in this session."}</p> : null}{cursor ? <button className="btn small" disabled={busy} onClick={() => void run(async () => load(cursor))}>{zh ? "更多模板" : "More templates"}</button> : null}</div>
    {selected ? <div className="runtime-template-editor"><h4>{selected.name}</h4><pre>{content}</pre><label>{zh ? "参数（可用引号包住含空格的参数）" : "Arguments (quote values containing spaces)"}<input className="input" maxLength={32000} value={args} onChange={event => { setArgs(event.target.value); setPrepared(""); }} /></label><button className="btn small outline" disabled={busy || !canRead} onClick={() => void run(async epoch => {
      const text = preview ? PREVIEW_TEMPLATE_TEXT.replace("$ARGUMENTS", args) : (await invoke("templates.prepare", { sessionId: sessionId!, id: selected.id, version: selected.version, arguments: args })).text;
      if (epoch === generation.current) setPrepared(text);
    })}>{zh ? "预览展开结果" : "Preview expansion"}</button>{prepared ? <><textarea className="input mono" aria-label={zh ? "展开的提示词" : "Expanded prompt"} readOnly rows={8} value={prepared} /><button className="btn small primary" disabled={busy || !onInsert} onClick={() => { try { onInsert?.(prepared); } catch (cause) { setError(hostErrorMessage(cause, "Cannot insert template")); } }}>{zh ? "放入主对话输入框" : "Insert into main Composer"}</button></> : null}</div> : null}</div>
  </section>;
}
