import { useCallback, useEffect, useRef, useState } from "react";
import type { StudioClient } from "@omp-studio/client-contract";
import type { SessionBudgetState, SessionOptionsResultMap } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { hostErrorMessage, waitReceipt } from "../hostError";

const DEMO_BUDGET: SessionBudgetState = { treeSpent: 2.48, warnCost: 5, maxCost: 10, limitReached: false, warnSource: "global", maxSource: "global" };

export function SessionBudgetPane({ client, sessionId, available, visible = true }: { client?: StudioClient | undefined; sessionId?: string | undefined; available: boolean; visible?: boolean }) {
  const { preview } = usePreviewMode();
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [budget, setBudget] = useState<SessionBudgetState>();
  const [warn, setWarn] = useState(""); const [cap, setCap] = useState("");
  const [scope, setScope] = useState<"session" | "global">("session");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [supported, setSupported] = useState(false);
  const generation = useRef(0); const locked = useRef(false);
  const applyState = (next: SessionBudgetState) => { setBudget(next); setWarn(next.warnCost === null ? "" : String(next.warnCost)); setCap(next.maxCost === null ? "" : String(next.maxCost)); };
  const invoke = useCallback(async <K extends "session.budget.get" | "session.budget.set" | "session.budget.clearOverride">(kind: K, fields: Record<string, unknown> = {}): Promise<SessionOptionsResultMap[K]> => {
    if (!client || !sessionId) throw Error("Runtime unavailable");
    const handle = await client.command(kind, { sessionId, ...fields } as never);
    return (await waitReceipt<{ result: SessionOptionsResultMap[K] }>(client, handle.requestId)).result;
  }, [client, sessionId]);
  useEffect(() => {
    const epoch = ++generation.current; locked.current = false; setBusy(false); setError(""); setSupported(preview); setBudget(undefined);
    if (!visible) return;
    if (preview) { applyState({ ...DEMO_BUDGET }); return; }
    if (client && sessionId && available) void client.query("capabilities.get", {}).then(async manifest => {
      if (generation.current !== epoch) return;
      const canRead = manifest.capabilities.some(row => row.id === "session.budget.get" && row.grade !== "unavailable");
      setSupported(canRead);
      if (canRead) { const result = await invoke("session.budget.get"); if (generation.current === epoch) applyState(result); }
    }).catch(cause => { if (generation.current === epoch) setError(hostErrorMessage(cause, zh ? "预算读取失败" : "Budget unavailable")); });
    return () => { generation.current++; };
  }, [preview, visible, client, sessionId, available, invoke, zh]);
  const save = async (clear = false) => {
    if (locked.current || !supported) return;
    const warnCost = warn.trim() ? Number(warn) : null; const maxCost = cap.trim() ? Number(cap) : null;
    if (!clear && [warnCost, maxCost].some(value => value !== null && (!Number.isFinite(value) || value <= 0))) { setError(zh ? "输入正数 USD 金额，留空表示不限制。" : "Enter a positive USD amount; blank means no threshold."); return; }
    const epoch = generation.current; locked.current = true; setBusy(true); setError("");
    try {
      const next = preview ? clear ? { ...DEMO_BUDGET } : { ...budget!, warnCost, maxCost, limitReached: maxCost !== null && budget!.treeSpent >= maxCost, warnSource: scope === "session" ? "runtime" as const : "global" as const, maxSource: scope === "session" ? "runtime" as const : "global" as const }
        : clear ? await invoke("session.budget.clearOverride") : await invoke("session.budget.set", { warnCost, maxCost, scope });
      if (generation.current === epoch) applyState(next);
    } catch (cause) { if (generation.current === epoch) setError(hostErrorMessage(cause, zh ? "预算保存失败" : "Could not save budget")); }
    finally { if (generation.current === epoch) { locked.current = false; setBusy(false); } }
  };
  return <section className="session-options-card" aria-label={zh ? "会话费用预算" : "Session cost budget"}>
    <h3>{zh ? "会话费用预算" : "Session cost budget"}{preview ? <span className="chip gray xs">{zh ? "演示" : "Demo"}</span> : null}</h3>
    <p className="muted">{zh ? "按原生 USD 费用统计主会话、子代理和旁路请求。达到上限后拒绝下一次请求，已在运行的请求可能使总额超出上限；留空不限制。" : "Native USD spend covers the main session, subagents and side requests. The cap blocks the next request; requests already in flight may exceed it. Leave blank for no threshold."}</p>
    {budget ? <p role="status">{zh ? "会话树累计" : "Session-tree spend"} ${budget.treeSpent.toFixed(4)} · {budget.limitReached ? zh ? "已到上限，可调整预算后继续" : "Cap reached; adjust it to continue" : zh ? "未到上限" : "Below cap"} · {zh ? "来源" : "Source"}: {budget.warnSource} / {budget.maxSource}</p> : <p className="muted">{supported ? zh ? "正在读取…" : "Loading…" : zh ? "连接支持预算的 Runtime 后可用。" : "Connect a Runtime with budget support."}</p>}
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="session-options-row"><label>{zh ? "警告金额（USD）" : "Warning (USD)"}<input className="input" type="number" min="0.0001" step="any" value={warn} disabled={!budget || busy} onChange={event => setWarn(event.target.value)} /></label><label>{zh ? "费用上限（USD）" : "Cap (USD)"}<input className="input" type="number" min="0.0001" step="any" value={cap} disabled={!budget || busy} onChange={event => setCap(event.target.value)} /></label><label>{zh ? "保存范围" : "Scope"}<AppSelect className="select" value={scope} disabled={busy} onChange={event => setScope(event.target.value as typeof scope)}><option value="session">{zh ? "当前会话" : "This session"}</option><option value="global">{zh ? "用户配置" : "User settings"}</option></AppSelect></label></div>
      <div className="media-toolbar"><button className="btn small outline" disabled={!budget || busy}>{busy ? zh ? "保存中…" : "Saving…" : zh ? "保存预算" : "Save budget"}</button><button type="button" className="btn small ghost" disabled={!budget || busy} onClick={() => void save(true)}>{zh ? "清除会话覆盖" : "Clear session override"}</button></div>
    </form>{error ? <p role="alert">{error}</p> : null}
  </section>;
}
