import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { AdvisorConfigRow, AdvisorConfigView } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "../hostError";
import type { NativePreferencesContext } from "./NativePreferencesPane";

const DEMO: AdvisorConfigView = { scope: "project", version: "demo", warnings: [], active: 0, document: { instructions: "检查任务与验收是否一致。", advisors: [{ name: "Reviewer", model: "demo/reason", enabled: false, scope: "all", includeReasoning: false, tools: ["read", "grep", "glob"], reviewMode: "turn", reviewInterval: 1 }] } };
export function AdvisorConfigPane({ client, context, visible }: { client?: StudioClient | undefined; context?: NativePreferencesContext | undefined; visible: boolean }) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [scope, setScope] = useState<"user" | "project">("project"); const [view, setView] = useState<AdvisorConfigView>(); const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [review, setReview] = useState(false); const epoch = useRef(0);
  const available = preview || !!(client && context?.available && context.sessionId && context.capabilities?.capabilities.some(cap => cap.id === "advisors.config.get" && cap.grade !== "unavailable"));
  useEffect(() => {
    const generation = ++epoch.current; setView(undefined); setSelected(0); setError(""); setReview(false);
    if (!visible) return;
    if (preview) { setView({ ...DEMO, scope, document: structuredClone(DEMO.document) }); return; }
    if (!available || !client || !context?.sessionId) return;
    setBusy(true);
    void client.command("advisors.config.get", { sessionId: context.sessionId, scope }).then(handle => waitReceipt<{ result: AdvisorConfigView }>(client, handle.requestId)).then(result => { if (generation === epoch.current) setView(result.result); }).catch(cause => { if (generation === epoch.current) setError(hostErrorMessage(cause, "Advisor configuration unavailable")); }).finally(() => { if (generation === epoch.current) setBusy(false); });
    return () => { epoch.current++; };
  }, [visible, preview, available, client, context?.sessionId, scope]);
  const row = view?.document.advisors[selected];
  const patch = (change: Partial<AdvisorConfigRow>) => setView(current => current ? { ...current, document: { ...current.document, advisors: current.document.advisors.map((row, index) => index === selected ? { ...row, ...change } : row) } } : current);
  const save = async () => {
    if (!view || busy || !available) return; const generation = epoch.current; setBusy(true); setError("");
    try {
      if (preview) { setReview(false); setView(current => current ? { ...current, active: current.document.advisors.filter(row => row.enabled !== false).length } : current); return; }
      const handle = await client!.command("advisors.config.save", { sessionId: context!.sessionId!, scope, version: view.version, document: view.document });
      const result = await waitReceipt<{ result: AdvisorConfigView }>(client!, handle.requestId);
      if (generation === epoch.current) { setView(result.result); setReview(false); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, "Advisor save failed")); }
    finally { if (generation === epoch.current) setBusy(false); }
  };
  return <section className="session-options-card" aria-label={zh ? "WATCHDOG 审阅代理" : "WATCHDOG advisors"}>
    <h3>WATCHDOG {zh ? "审阅代理" : "advisors"}{preview ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}</h3>
    <p className="muted">{zh ? "配置原生审阅代理。保存会重载当前会话的原生 roster；启用审阅可能额外调用模型。作用范围不是配置文件的存储范围。" : "Configure native advisors. Saving reloads this session's native roster; enabled reviews may make billed requests. Session scope differs from file storage scope."}</p>
    <label>{zh ? "配置来源" : "Storage scope"}<AppSelect className="select" value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}><option value="project">{zh ? "当前项目" : "Project"}</option><option value="user">{zh ? "用户配置" : "User"}</option></AppSelect></label>
    {!available ? <p role="status">{zh ? "连接支持 Advisor 配置的 Runtime 后可用。" : "Connect a compatible Runtime."}</p> : null}
    {view ? <><p className="small muted">{zh ? "当前活跃" : "Active"}: {view.active}</p><div className="session-options-row"><AppSelect className="select" aria-label="Advisor" value={String(selected)} disabled={busy || !view.document.advisors.length} onChange={event => setSelected(Number(event.target.value))}>{view.document.advisors.map((row, index) => <option key={index} value={index}>{row.name}</option>)}</AppSelect><button type="button" className="btn small outline" disabled={busy} onClick={() => { setSelected(view.document.advisors.length); setView(current => current ? { ...current, document: { ...current.document, advisors: [...current.document.advisors, { name: "New advisor", enabled: false, scope: "all", includeReasoning: true }] } } : current); }}>{zh ? "添加" : "Add"}</button><button type="button" className="btn small danger" disabled={busy || !row} onClick={() => { setView(current => current ? { ...current, document: { ...current.document, advisors: current.document.advisors.filter((_, index) => index !== selected) } } : current); setSelected(0); }}>{zh ? "移除" : "Remove"}</button></div>
      {row ? <div className="media-parameter-grid"><label>{zh ? "名称" : "Name"}<input className="input" value={row.name} disabled={busy} onChange={event => patch({ name: event.target.value })} /></label><label>{zh ? "模型或角色" : "Model or role"}<input className="input" value={row.model ?? ""} disabled={busy} placeholder="@advisor" onChange={event => patch({ model: event.target.value })} /></label><label>{zh ? "作用范围" : "Session scope"}<AppSelect className="select" value={row.scope ?? "all"} disabled={busy} onChange={event => patch({ scope: event.target.value as "main" | "subagent" | "all" })}><option value="main">{zh ? "仅主会话" : "Main only"}</option><option value="subagent">{zh ? "仅子代理" : "Subagents only"}</option><option value="all">{zh ? "全部" : "All"}</option></AppSelect></label><label><input type="checkbox" checked={row.includeReasoning !== false} disabled={busy} onChange={event => patch({ includeReasoning: event.target.checked })} />{zh ? "审阅公开推理内容" : "Include reasoning"}</label><label><input type="checkbox" checked={row.enabled !== false} disabled={busy} onChange={event => patch({ enabled: event.target.checked })} />{zh ? "启用此审阅代理" : "Enable advisor"}</label><label>{zh ? "工具（逗号分隔，空值不给工具）" : "Tools (comma separated; blank grants none)"}<input className="input" value={row.tools?.join(", ") ?? ""} disabled={busy} onChange={event => patch({ tools: event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} /></label><label>{zh ? "审阅指令" : "Instructions"}<textarea className="input" rows={4} value={row.instructions ?? ""} disabled={busy} onChange={event => patch({ instructions: event.target.value })} /></label></div> : null}
      <label>{zh ? "共享审阅指令" : "Shared instructions"}<textarea className="input" rows={3} value={view.document.instructions ?? ""} disabled={busy} onChange={event => setView(current => current ? { ...current, document: { ...current.document, instructions: event.target.value } } : current)} /></label>
      {view.warnings.map((warning, index) => <p key={index} role="alert">{warning}</p>)}<button className="btn small outline" disabled={busy || !!view.warnings.length} onClick={() => setReview(true)}>{zh ? "保存并重载" : "Save and reload"}</button>
    </> : null}{error ? <p role="alert">{error}</p> : null}{busy ? <p role="status">{zh ? "处理中…" : "Working…"}</p> : null}
    {review ? <div className="media-review"><p>{zh ? "确认修改 WATCHDOG 并重载审阅代理？启用项可能在下一次审阅时调用模型并计费。" : "Save WATCHDOG and reload advisors? Enabled entries may make billed requests on their next review."}</p><button className="btn small primary" disabled={busy} onClick={() => void save()}>{zh ? "确认保存" : "Confirm save"}</button><button className="btn small ghost" disabled={busy} onClick={() => setReview(false)}>{zh ? "取消" : "Cancel"}</button></div> : null}
  </section>;
}
