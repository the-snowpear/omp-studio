import { useEffect, useRef, useState } from "react";
import type { JsonValue, StudioClient } from "@omp-studio/client-contract";
import type { StudioWebMcpCatalog, WebMcpInvokeResult, WebMcpToolRecord } from "@omp-studio/studio-protocol";
import { JsonTree } from "../conversation/JsonTree";
import { Icon } from "../icons";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_WEBMCP, PREVIEW_WEBMCP_RESULT } from "../preview/webmcpPreview";
import type { Copy } from "./BrowserToolbar";

export function WebMcpPane({ client, sessionId, pageId, documentId, agentControl, visible, copy, onBack }: {
  client?: StudioClient | undefined; sessionId: string; pageId: string; documentId?: string | undefined;
  agentControl: boolean; visible: boolean; copy: Copy; onBack(): void;
}) {
  const { preview, marks } = usePreviewMode();
  const [catalog, setCatalog] = useState<StudioWebMcpCatalog>(), [selected, setSelected] = useState<WebMcpToolRecord>();
  const [input, setInput] = useState("{}"), [result, setResult] = useState<WebMcpInvokeResult>(), [error, setError] = useState(""), [busy, setBusy] = useState(false), [revision, refresh] = useState(0);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    setCatalog(undefined); setSelected(undefined); setResult(undefined); setError(""); setBusy(false);
    if (!visible) return;
    if (preview) { setCatalog({ ...PREVIEW_WEBMCP, pageId }); return; }
    if (!client) return;
    setBusy(true);
    void client.query("browser.webmcp.list", { sessionId, pageId }).then(value => { if (current === epoch.current) setCatalog(value); }).catch(cause => { if (current === epoch.current) setError(hostErrorMessage(cause, "WebMCP unavailable")); }).finally(() => { if (current === epoch.current) setBusy(false); });
    return () => { epoch.current++; };
  }, [client, sessionId, pageId, documentId, visible, preview, revision]);
  const choose = async (tool: WebMcpToolRecord) => {
    const current = epoch.current; setSelected(tool); setInput("{}"); setResult(undefined); setError("");
    if (preview || !client) return;
    try {
      const value = await client.query("browser.webmcp.list", { sessionId, pageId, options: { name: tool.name, frame: tool.frameId } });
      if (current === epoch.current) { setCatalog(value); setSelected(value.tools[0]); }
    } catch (cause) { if (current === epoch.current) setError(hostErrorMessage(cause, "Tool metadata unavailable")); }
  };
  const invoke = async () => {
    if (busy || !selected || !catalog?.documentId) return;
    const current = epoch.current; setBusy(true); setError("");
    try {
      const params: unknown = JSON.parse(input);
      if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error(copy("参数需要是 JSON 对象", "Parameters must be a JSON object"));
      if (preview) { setResult(PREVIEW_WEBMCP_RESULT); return; }
      if (!client) return;
      const handle = await client.command("browser.webmcp.invoke", { sessionId, pageId, documentId: catalog.documentId, name: selected.name, params: params as Record<string, unknown>, options: { frame: selected.frameId } });
      const receipt = await waitReceipt<{ result: WebMcpInvokeResult }>(client, handle.requestId, 30000);
      if (current === epoch.current) setResult(receipt.result);
    } catch (cause) { if (current === epoch.current) setError(hostErrorMessage(cause, "WebMCP invocation failed")); }
    finally { if (current === epoch.current) setBusy(false); }
  };
  return <div className="mb-view"><header className="mb-view-header"><button type="button" className="icon-btn" aria-label={copy("返回网页", "Back to page")} onClick={onBack}><Icon name="arrow-l" extra="sm" /></button><h2>WebMCP</h2>{preview && marks ? <span className="chip gray">{copy("演示", "Demo")}</span> : null}<button type="button" className="btn small ghost" disabled={busy || !preview && !client} onClick={() => refresh(value => value + 1)}>{copy("刷新工具", "Refresh tools")}</button></header>
    <div className="mb-view-body"><p className="mb-view-empty">{copy("当前网页向 Agent 提供的工具。名称、参数说明和结果来自网页。", "Tools this page exposes to agents. Names, parameter descriptions and results come from the page.")}</p>
      {error ? <p role="alert">{error}</p> : null}{!preview && !client ? <p>{copy("当前 Runtime 不支持此页面的 WebMCP 查询。", "This Runtime cannot inspect WebMCP on this page.")}</p> : null}
      {catalog?.status === "unavailable" ? <p role="status">{catalog.reason}</p> : null}{busy ? <p role="status">{copy("正在处理…", "Working…")}</p> : null}
      <div className="mb-section"><div className="mb-row-actions">{catalog?.tools.map(tool => <button type="button" key={`${tool.frameId}:${tool.name}`} className="btn small outline" disabled={busy} onClick={() => void choose(tool)}>{tool.name}</button>)}</div></div>
      {catalog?.status === "ready" && !catalog.tools.length ? <p>{copy("此页面尚未注册工具。", "This page has not registered tools.")}</p> : null}
      {selected ? <section className="mb-section"><h3>{selected.name}</h3><p>{selected.description}</p><p className="small muted">{selected.origin} · {selected.frameId}</p>{selected.inputSchema !== undefined ? <JsonTree value={selected.inputSchema as JsonValue} label={copy("参数结构", "Input schema")} /> : null}<label className="mb-field"><span>{copy("调用参数 (JSON)", "Parameters (JSON)")}</span><textarea className="input mono" rows={6} value={input} onChange={event => setInput(event.target.value)} disabled={busy} /></label><div className="mb-section-actions"><button type="button" className="btn small primary" disabled={busy || !agentControl || !catalog?.invocationAvailable || !catalog.documentId} onClick={() => void invoke()}>{copy("调用工具", "Invoke tool")}</button></div></section> : null}
      {catalog?.status === "ready" && !catalog.invocationAvailable ? <p className="small muted">{copy("当前 Chromium 可列出工具；调用需要 Chromium 149 或更新版本。", "This Chromium can list tools; invocation requires Chromium 149 or newer.")}</p> : null}
      {!agentControl ? <p className="small muted">{copy("将此聊天的浏览器控制权交给 Agent 后可调用工具。", "Return this chat's browser control to the agent to invoke tools.")}</p> : null}
      {result ? <section className="mb-section">{result.ok ? <JsonTree value={result.result as JsonValue} label={copy("工具结果", "Tool result")} /> : <p role="alert">{result.error}</p>}</section> : null}
    </div></div>;
}
