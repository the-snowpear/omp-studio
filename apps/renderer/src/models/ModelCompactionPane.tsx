import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AvailableModelRecord, ModelProviderRecord } from "@omp-studio/client-contract";
import type { CompactionPreview, FeatureSettingValue } from "@omp-studio/studio-protocol";
import { useFeatureSettings, type FeatureSettingsProps } from "../settings/useFeatureSettings";
import { useI18n } from "../i18n";
import { Icon } from "../icons";
import { usePreviewMode } from "../preview/PreviewContext";
import { previewModelCompaction } from "../preview/modelCompactionPreview";
import { hostErrorMessage } from "../hostError";
import { MOTION_MS } from "../motion";
import { RoleModelPicker } from "./config/RoleControls";
import { groupModelsByProvider } from "./modelPresentation";
import "./modelCompaction.css";

function tokenInput(tokens: number): string {
  for (const [suffix, scale] of [["b", 1_000_000_000], ["m", 1_000_000], ["k", 1_000]] as const) {
    if (tokens > 0 && tokens % scale === 0) return `${tokens / scale}${suffix}`;
  }
  return String(tokens);
}

function entryInput(value: FeatureSettingValue | undefined): string {
  if (typeof value === "number") return tokenInput(value);
  if (typeof value !== "string") return "";
  const fixed = /^f(\d+)$/i.exec(value);
  return fixed ? `f${tokenInput(Number(fixed[1]))}` : value;
}

export function ModelCompactionPane(props: FeatureSettingsProps & {
  models: readonly AvailableModelRecord[];
  providers?: readonly ModelProviderRecord[];
  initialSelector?: string | undefined;
  onSaved?: () => void | Promise<void>;
}) {
  const state = useFeatureSettings(props);
  const { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const models = useMemo(() => props.models.filter(model => !model.kind || model.kind === "chat"), [props.models]);
  const [selector, setSelector] = useState(props.initialSelector ?? "");
  const [input, setInput] = useState("");
  const [plan, setPlan] = useState<CompactionPreview>();
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [planning, setPlanning] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const owner = useRef(0);
  const selected = models.find(model => model.selector === selector) ?? (selector ? undefined : models[0]);
  const enabled = state.enabled && state.supports("models.compaction.preview") && state.supports("models.compaction.set");
  const thresholds = state.rows.find(row => row.key === "compaction.modelThresholds")?.value;
  const entries = thresholds && typeof thresholds === "object" && !Array.isArray(thresholds) ? thresholds : {};
  const storedInput = entryInput(selected ? entries[selected.selector] : undefined);
  const dirty = input.trim() !== storedInput;

  useEffect(() => { setSelector(props.initialSelector ?? ""); }, [props.initialSelector]);
  useEffect(() => {
    owner.current++;
    setBusy(false); setConfirmation(""); setNotice(""); setError("");
    return () => { owner.current++; };
  }, [selected?.selector, props.context?.sessionId, props.client, state.preview]);
  useEffect(() => { setInput(storedInput); }, [selected?.selector, storedInput]);

  useEffect(() => {
    let active = true;
    setPlan(undefined); setError(""); setConfirmation(""); setPlanning(false);
    if (!props.visible || !enabled || state.loading || !selected) return;
    if (state.preview) { setPlan(previewModelCompaction(selected, input).plan); return; }
    setPlanning(true);
    const timer = setTimeout(() => {
      void state.invoke("models.compaction.preview", { sessionId: props.context!.sessionId!, selector: selected.selector, input })
        .then(result => { if (active) setPlan(result); })
        .catch(cause => { if (active) setError(hostErrorMessage(cause, zh ? "无法读取压缩预览" : "Cannot preview compaction")); })
        .finally(() => { if (active) setPlanning(false); });
    }, MOTION_MS.slow);
    return () => { active = false; clearTimeout(timer); };
  }, [input, selected?.selector, selected?.contextWindow, selected?.maxContextWindow, props.visible, props.context?.sessionId, enabled, state.loading, state.preview, state.invoke, zh]);

  async function save(confirmed = false) {
    if (busy || !selected || !plan?.valid || !enabled) return;
    const current = owner.current;
    setBusy(true); setError(""); setNotice("");
    try {
      if (state.preview) {
        const result = previewModelCompaction(selected, input);
        if (result.plan.extended && !confirmed) { setConfirmation(zh ? "此设置将启用扩展上下文窗口，确认后保存。" : "This setting opens the extended context window. Confirm to save."); return; }
        const next = { ...entries };
        if (result.entry === null) delete next[selected.selector];
        else next[selected.selector] = result.entry;
        await state.save("compaction.modelThresholds", next, "global");
        if (current === owner.current) {
          setConfirmation("");
          if (marks) setNotice(zh ? "演示：压缩配置已保存。" : "Demo: compaction setting saved.");
        }
      } else {
        const result = await state.invoke("models.compaction.set", { sessionId: props.context!.sessionId!, selector: selected.selector, input, confirmed });
        if (current !== owner.current) return;
        if (result.confirmationRequired) { setConfirmation(result.summary); return; }
        setConfirmation(""); setNotice(result.summary);
        await state.refresh();
        if (current === owner.current) await props.onSaved?.();
      }
    } catch (cause) {
      if (current === owner.current) setError(hostErrorMessage(cause, zh ? "无法保存压缩设置" : "Cannot save compaction"));
    } finally { if (current === owner.current) setBusy(false); }
  }

  const ratio = plan?.window && plan.trigger !== undefined ? Math.min(100, plan.trigger / plan.window * 100) : undefined;
  const mode = !input.trim() ? "default" : input.trim().endsWith("%") ? "percent" : /^f/i.test(input.trim()) ? "fixed" : "base";
  const exampleBase = tokenInput(Math.min(selected?.contextWindow ?? 400_000, 400_000));
  const exampleFixed = `f${tokenInput(Math.floor((selected?.contextWindow ?? 500_000) * .8))}`;
  const inputDisabled = !enabled || state.loading || busy || !selected;
  const formats = [
    { id: "default", label: zh ? "默认" : "Default", input: "" },
    { id: "base", label: zh ? "基础窗口" : "Token base", input: exampleBase },
    { id: "percent", label: zh ? "窗口比例" : "Percentage", input: "80%" },
    { id: "fixed", label: zh ? "精确触发" : "Exact trigger", input: exampleFixed },
  ];

  return <section className="mc-compaction" aria-label={zh ? "模型压缩阈值" : "Model compaction thresholds"} aria-busy={busy || state.loading}>
    <header className="mc-role-section-head">
      <span className="mc-role-section-icon"><Icon name="layers" /></span>
      <div><h3>{zh ? "上下文压缩" : "Context compaction"}</h3><p>{zh ? "按模型设置压缩时机，所有使用该模型的角色共享。" : "Set when each model compacts its context, shared across its roles."}</p></div>
      <span className="mc-compaction-scope">{zh ? "全局配置" : "Global config"}{state.preview && marks ? zh ? " · 演示" : " · Demo" : ""}</span>
    </header>
    <div className="mc-compaction-body">
      <div className="mc-compaction-editor">
        <div className="mc-compaction-field">
          <label>{zh ? "模型" : "Model"}</label>
          <RoleModelPicker ariaLabel={zh ? "压缩配置模型" : "Compaction model"} value={selected?.selector ?? selector} groups={groupModelsByProvider(models, props.providers ?? [])} disabled={busy || !models.length} onChange={setSelector} />
          {selected ? <span className="mc-compaction-model-id">{selected.selector}</span> : null}
        </div>
        <div className="mc-compaction-field">
          <label htmlFor={`${uid}-threshold`}>{zh ? "压缩阈值" : "Compaction threshold"}<span>{dirty ? zh ? "未保存" : "Unsaved" : storedInput ? zh ? "已自定义" : "Customized" : zh ? "继承默认" : "Inherited"}</span></label>
          <input ref={inputRef} id={`${uid}-threshold`} className="input mono" value={input} maxLength={64} placeholder={`${exampleBase} / 80% / ${exampleFixed}`} disabled={inputDisabled} aria-label={zh ? "压缩阈值" : "Compaction threshold"} aria-describedby={`${uid}-hint`} aria-invalid={plan?.valid === false} onChange={event => { setInput(event.target.value); setNotice(""); }} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing && !planning) { event.preventDefault(); void save(Boolean(confirmation)); } }} />
          <div className="mc-compaction-formats" role="group" aria-label={zh ? "阈值格式" : "Threshold format"}>
            {formats.map(format => <button key={format.id} type="button" aria-pressed={mode === format.id} disabled={inputDisabled} onClick={() => { setInput(format.input); setNotice(""); inputRef.current?.focus(); }}>{format.label}</button>)}
          </div>
        </div>
        <p id={`${uid}-hint`} className="mc-compaction-hint">{zh ? "数值为基础窗口，由原生策略计算触发点；百分比按窗口计算，f 前缀指定精确触发点。留空恢复默认。" : "Numbers set a token base; percentages use the window; an f prefix sets an exact trigger. Leave empty to restore defaults."}</p>
      </div>
      <div className="mc-compaction-preview" aria-live="polite" aria-busy={planning}>
        <div className="mc-compaction-preview-head"><span>{zh ? "触发点预览" : "Trigger preview"}</span><span>{planning || state.loading ? zh ? "计算中…" : "Calculating…" : plan?.valid ? zh ? "原生策略" : "Native policy" : ""}</span></div>
        <div className="mc-compaction-stats">
          <div><strong>{plan?.valid ? plan.trigger?.toLocaleString() ?? "—" : "—"}</strong><span>{zh ? "压缩触发 / tokens" : "Compaction trigger / tokens"}</span></div>
          <div><strong>{plan?.valid ? plan.window?.toLocaleString() ?? "—" : "—"}</strong><span>{zh ? "上下文窗口 / tokens" : "Context window / tokens"}</span></div>
        </div>
        <div className="mc-compaction-meter" role={ratio === undefined ? undefined : "meter"} aria-label={zh ? "压缩触发点占上下文窗口的比例" : "Compaction trigger as a share of the context window"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio} style={{ "--compaction-share": `${ratio ?? 0}%` } as CSSProperties}><span className="mc-compaction-used" /><span className="mc-compaction-notch" /></div>
        <div className="mc-compaction-scale"><span>0</span><span>{ratio === undefined ? "—" : `${Number(ratio.toFixed(1))}%`}</span><span>{zh ? "窗口上限" : "Window limit"}</span></div>
        <p className="mc-compaction-basis">{plan?.valid ? plan.summary || (zh ? "自动压缩已关闭，或模型未提供窗口信息。" : "Auto-compaction is off, or the context window is unknown.") : plan ? zh ? "输入无效或超过模型支持的窗口。" : "Invalid input or larger than the supported window." : !models.length ? zh ? "暂无可配置的对话模型。" : "No chat models to configure." : !selected ? zh ? "选择一个对话模型以编辑压缩阈值。" : "Select a chat model to edit its compaction threshold." : !enabled ? zh ? "连接支持模型压缩配置的 Runtime 后可编辑。" : "Connect a compatible Runtime to edit compaction settings." : zh ? "等待原生策略预览…" : "Waiting for the native preview…"}</p>
        {plan?.extended ? <p className="mc-compaction-warning"><Icon name="alert" extra="sm" />{zh ? "使用扩展上下文窗口" : "Uses the extended context window"}</p> : null}
      </div>
    </div>
    <footer className="mc-compaction-footer">
      <span className="mc-compaction-save-status">{notice ? <span role="status"><Icon name="check" extra="sm" />{notice}</span> : zh ? "按模型共享 · 保存至全局 config.yml" : "Shared per model · saved to global config.yml"}</span>
      {!confirmation ? <button type="button" className="btn small primary" disabled={inputDisabled || planning || !plan?.valid || !dirty} onClick={() => void save()}><Icon name="check" extra="sm" />{busy ? zh ? "保存中…" : "Saving…" : input.trim() ? zh ? "保存阈值" : "Save threshold" : zh ? "恢复默认" : "Restore default"}</button> : null}
    </footer>
    {confirmation ? <div className="mc-compaction-confirm" role="alertdialog" aria-label={zh ? "确认扩展上下文" : "Confirm extended context"}><Icon name="alert" /><div><strong>{zh ? "确认启用扩展窗口" : "Confirm the extended window"}</strong><p>{confirmation}</p></div><button type="button" className="btn small outline" disabled={busy} onClick={() => setConfirmation("")}>{zh ? "取消" : "Cancel"}</button><button type="button" className="btn small primary" disabled={busy} onClick={() => void save(true)}>{zh ? "确认并保存" : "Confirm and save"}</button></div> : null}
    {error || state.error ? <p role="alert" className="mc-compaction-error"><Icon name="alert" extra="sm" />{error || state.error}</p> : null}
  </section>;
}
