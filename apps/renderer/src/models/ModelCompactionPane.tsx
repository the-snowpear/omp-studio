import { AppSelect } from "../AppSelect";
import { useEffect, useRef, useState } from "react";
import type { AvailableModelRecord } from "@omp-studio/client-contract";
import type { CompactionPreview } from "@omp-studio/studio-protocol";
import { useFeatureSettings, type FeatureSettingsProps } from "../settings/useFeatureSettings";
import { useI18n } from "../i18n";
import { hostErrorMessage } from "../hostError";
import "../settings/featureSettings.css";

export function ModelCompactionPane(props: FeatureSettingsProps & { models: readonly AvailableModelRecord[] }) {
  const state = useFeatureSettings(props), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const models = props.models.filter(model => !model.kind || model.kind === "chat");
  const [selector, setSelector] = useState(""), [input, setInput] = useState("");
  const [plan, setPlan] = useState<CompactionPreview>(), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [confirmation, setConfirmation] = useState("");
  const generation = useRef(0), lock = useRef(false);
  const selected = models.find(row => row.selector === selector) ?? models[0];
  const thresholds = state.rows.find(row => row.key === "compaction.modelThresholds")?.value;
  useEffect(() => {
    generation.current++; lock.current = false; setBusy(false); setConfirmation(""); setNotice(""); setError("");
    const value = thresholds && typeof thresholds === "object" && !Array.isArray(thresholds) && selected ? thresholds[selected.selector] : undefined;
    setInput(value === undefined ? "" : String(value));
  }, [selected?.selector, thresholds, props.context?.sessionId]);
  useEffect(() => {
    const current = ++generation.current; setPlan(undefined); setError(""); setConfirmation("");
    if (!props.visible || !state.enabled || !selected) return;
    if (state.preview) { setPlan({ valid: true, summary: zh ? "演示：400K 基础窗口的 85%" : "Demo: 85% of a 400K base", window: 500000, trigger: 340000, extended: false }); return; }
    const timer = setTimeout(() => {
      void state.invoke("models.compaction.preview", { sessionId: props.context!.sessionId!, selector: selected.selector, input }).then(result => { if (current === generation.current) setPlan(result); })
        .catch(cause => { if (current === generation.current) setError(hostErrorMessage(cause, "Cannot preview compaction")); });
    }, 250);
    return () => { clearTimeout(timer); generation.current++; };
  }, [input, selected?.selector, props.visible, props.context?.sessionId, state.enabled, state.preview, state.invoke, zh]);
  async function save(confirmed = false) {
    if (lock.current || !selected || !plan?.valid) return;
    const current = generation.current; lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = state.preview ? { saved: true, confirmationRequired: false, summary: zh ? "演示压缩配置已保存。" : "Demo compaction setting saved." }
        : await state.invoke("models.compaction.set", { sessionId: props.context!.sessionId!, selector: selected.selector, input, confirmed });
      if (current !== generation.current) return;
      if (result.confirmationRequired) setConfirmation(result.summary); else { setConfirmation(""); setNotice(result.summary); }
    } catch (cause) { if (current === generation.current) setError(hostErrorMessage(cause, "Cannot save compaction")); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="feature-settings" aria-label={zh ? "模型压缩阈值" : "Model compaction thresholds"}>
    <header className="feature-settings-head"><div><span className="feature-eyebrow">{zh ? "上下文容量" : "CONTEXT CAPACITY"}{state.preview ? zh ? " · 演示" : " · DEMO" : ""}</span><h3>{zh ? "为每个模型设置压缩时机" : "Compaction timing per model"}</h3></div></header>
    <p className="feature-status">{zh ? "普通数值指定基础窗口，由原生策略计算触发点；百分比指定窗口占比；f400k 表示精确触发。留空恢复默认。" : "Numbers set a base window; native policy determines the trigger. Percentages use the window; f400k sets an exact trigger. Empty restores defaults."}</p>
    {!state.enabled ? <p className="feature-status">{zh ? "连接支持模型压缩配置的 Runtime 后可编辑。" : "Connect a compatible Runtime to edit compaction settings."}</p> : null}
    <div className="feature-actions"><AppSelect className="select" aria-label={zh ? "压缩配置模型" : "Compaction model"} value={selected?.selector ?? ""} disabled={busy || !models.length} onChange={event => setSelector(event.target.value)}>{models.map(model => <option key={model.selector} value={model.selector}>{model.name} · {model.provider}</option>)}</AppSelect><input className="input" aria-label={zh ? "压缩阈值" : "Compaction threshold"} value={input} maxLength={64} placeholder="400k / 80% / f400k" disabled={!state.enabled || busy} onChange={event => setInput(event.target.value)} /></div>
    {plan?.valid ? <div className="feature-detail"><div className="feature-meter" aria-hidden="true"><span style={{ width: `${plan.window && plan.trigger ? Math.min(100, 100 * plan.trigger / plan.window) : 0}%` }} /></div><p className="feature-status"><strong>{zh ? "压缩触发点" : "Compaction trigger"} {plan.trigger?.toLocaleString() ?? "—"}</strong> · {zh ? "窗口" : "Window"} {plan.window?.toLocaleString() ?? "—"}</p><p className="feature-status">{plan.summary}{plan.extended ? zh ? " · 将使用扩展上下文，可能产生长上下文费用。" : " · Extended context may incur higher prices." : ""}</p></div> : input && plan ? <p role="alert" className="feature-error">{zh ? "该值格式无效或超过模型支持的窗口。" : "Invalid value or larger than the supported context window."}</p> : null}
    {confirmation ? <div className="feature-detail" role="alertdialog" aria-label={zh ? "确认扩展上下文" : "Confirm extended context"}><p>{confirmation}</p><div className="feature-actions"><button className="btn primary" disabled={busy} onClick={() => void save(true)}>{zh ? "确认并保存" : "Confirm and save"}</button><button className="btn outline" disabled={busy} onClick={() => setConfirmation("")}>{zh ? "取消" : "Cancel"}</button></div></div> : <div className="feature-actions"><button className="btn primary" disabled={!state.enabled || !plan?.valid || busy} onClick={() => void save()}>{busy ? zh ? "保存中…" : "Saving…" : zh ? "保存模型阈值" : "Save model threshold"}</button></div>}
    {notice ? <p role="status" className="feature-status">{notice}</p> : null}{error || state.error ? <p role="alert" className="feature-error">{error || state.error}</p> : null}
  </section>;
}
