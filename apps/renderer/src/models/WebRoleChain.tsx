import { useEffect, useState } from "react";
import { modelAcceptsRole, type AvailableModelRecord, type StudioClient, type WebSearchRouting } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";

export function WebRoleChain({ client, preview, routing, models, onSaved, onPreviewSave }: {
  client: StudioClient; preview: boolean; routing: WebSearchRouting; models: readonly AvailableModelRecord[];
  onSaved(): void; onPreviewSave(next: WebSearchRouting): void;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [primary, setPrimary] = useState(routing.primary);
  const [fallbacks, setFallbacks] = useState<readonly string[] | null>(routing.fallbacks);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = models.filter(row => modelAcceptsRole("web", row));
  useEffect(() => { setPrimary(routing.primary); setFallbacks(routing.fallbacks); }, [routing]);
  const save = async () => {
    if (preview) { onPreviewSave({ ...routing, primary, fallbacks, migratedLegacy: false }); return; }
    setBusy(true); setError("");
    try { const handle = await client.command("models.webSearch.set", { routing: { primary, fallbacks } }); await waitReceipt(client, handle.requestId); onSaved(); }
    catch (cause) { setError(hostErrorMessage(cause, "Cannot save search routing")); }
    finally { setBusy(false); }
  };
  return <section className="wsx-section">
    <div className="wsx-section-head"><b>{zh ? "Web 模型角色" : "Web model role"}</b>{preview ? <span className="chip gray">{zh ? "演示" : "Demo"}</span> : null}</div>
    <p className="small muted">{zh ? "主模型与回退顺序使用 OMP 原生模型选择器。留空主模型遵循原生默认；显式空回退链表示不再尝试其他模型。新会话后生效。" : "Primary and fallback order use native model selectors. An empty primary uses the native default; an explicit empty fallback chain disables further attempts. Applies to new sessions."}</p>
    {routing.migratedLegacy ? <p className="small muted">{zh ? "已按上游规则展示旧配置的迁移结果；保存时写入新格式。" : "Showing the upstream migration of legacy settings. Save to write the new format."}</p> : null}
    <div className="wsx-params-grid">
      <label className="wsx-field"><span>{zh ? "主模型" : "Primary model"}</span><select value={primary} disabled={busy} onChange={event => setPrimary(event.target.value)}><option value="">{zh ? "原生默认" : "Native default"}</option>{primary && !candidates.some(row => row.selector === primary) ? <option value={primary}>{primary} · {zh ? "当前配置" : "configured"}</option> : null}{candidates.map(row => <option key={row.selector} value={row.selector}>{row.name} · {row.selector}</option>)}</select></label>
      <label className="wsx-field"><span>{zh ? "回退方式" : "Fallback mode"}</span><select value={fallbacks === null ? "native" : "explicit"} disabled={busy} onChange={event => setFallbacks(event.target.value === "native" ? null : [])}><option value="native">{zh ? "原生默认顺序" : "Native priority defaults"}</option><option value="explicit">{zh ? "显式链" : "Explicit chain"}</option></select></label>
    </div>
    {fallbacks === null ? <p className="small muted mono" style={{ overflowWrap: "anywhere" }}>{routing.defaultCandidates.join(" → ")}</p> : <>
      {fallbacks.map((selector, index) => <div className="wsx-chain-row" key={selector}><span className="wsx-rank">{index + 1}</span><span className="mono" style={{ flex: 1 }}>{selector}</span><button type="button" className="btn small" aria-label={zh ? "上移" : "Move up"} disabled={busy || !index} onClick={() => { const next = [...fallbacks]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setFallbacks(next); }}>↑</button><button type="button" className="btn small" aria-label={zh ? "下移" : "Move down"} disabled={busy || index === fallbacks.length - 1} onClick={() => { const next = [...fallbacks]; [next[index + 1], next[index]] = [next[index]!, next[index + 1]!]; setFallbacks(next); }}>↓</button><button type="button" className="btn small" disabled={busy} onClick={() => setFallbacks(fallbacks.filter(item => item !== selector))}>{zh ? "移除" : "Remove"}</button></div>)}
      {!fallbacks.length ? <p className="small muted">{zh ? "不回退到其他模型" : "No fallback models"}</p> : null}
      <select className="select" aria-label={zh ? "添加回退模型" : "Add fallback model"} value="" disabled={busy} onChange={event => { if (event.target.value) setFallbacks([...fallbacks, event.target.value]); }}><option value="">{zh ? "添加回退模型…" : "Add fallback model…"}</option>{candidates.filter(row => row.selector !== primary && !fallbacks.includes(row.selector)).map(row => <option key={row.selector} value={row.selector}>{row.name} · {row.selector}</option>)}</select>
    </>}
    {error ? <p role="alert">{error}</p> : null}
    <div style={{ marginTop: 12 }}><button type="button" className="btn small primary" disabled={busy} onClick={() => void save()}>{zh ? "保存搜索链" : "Save search chain"}</button></div>
  </section>;
}
