import { AppSelect } from "../AppSelect";
import { useEffect, useRef, useState } from "react";
import type { AvailableModelRecord } from "@omp-studio/client-contract";
import type { StudioRuntimeSettingsGetResult } from "@omp-studio/studio-protocol";
import type { FeatureSettingsProps } from "../settings/useFeatureSettings";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { createPreviewModelConfig } from "../preview/modelConfigFixtures";
import { loadRuntimeModels } from "../models/runtimeModels";
import { hostErrorMessage, waitReceipt } from "../hostError";
import "../settings/featureSettings.css";

export function JudgeModelPane(props: FeatureSettingsProps) {
  const { preview } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [models, setModels] = useState<AvailableModelRecord[]>([]), [configured, setConfigured] = useState(""), [selected, setSelected] = useState("");
  const [persist, setPersist] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const epoch = useRef(0), lock = useRef(false);
  const supports = (id: string) => props.context?.capabilities?.capabilities.some(row => row.id === id && row.grade !== "unavailable") === true;
  const enabled = preview || !!(props.client && props.context?.available && props.context.sessionId && supports("runtime.settings.get") && supports("runtime.settings.set"));
  useEffect(() => {
    const current = ++epoch.current; setModels([]); setConfigured(""); setSelected(""); setError(""); setNotice(""); lock.current = false; setBusy(false);
    if (!props.visible || !enabled) return;
    if (preview) { const choices = createPreviewModelConfig().availableModels.filter(row => row.kind === "judge" || row.kind === "chat" || !row.kind); setModels([...choices]); setConfigured(choices.find(row => row.kind === "judge")?.selector ?? ""); return; }
    void (async () => {
      const [choices, handle] = await Promise.all([loadRuntimeModels(props.client!, () => current === epoch.current), props.client!.command("runtime.settings.get", { keys: ["modelRoles.judge"] })]);
      const settings = await waitReceipt<StudioRuntimeSettingsGetResult>(props.client!, handle.requestId);
      if (current !== epoch.current) return;
      setModels(choices.filter(row => row.kind === "judge" || row.kind === "chat" || !row.kind)); setConfigured(String(settings.values["modelRoles.judge"] ?? ""));
    })().catch(cause => { if (current === epoch.current) setError(hostErrorMessage(cause, "Cannot read judge models")); });
    return () => { epoch.current++; };
  }, [props.client, props.context?.sessionId, props.visible, enabled, preview]);
  async function save() {
    if (lock.current || !enabled || !selected) return;
    const current = epoch.current; lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      if (!preview) { const handle = await props.client!.command("runtime.settings.set", { key: "modelRoles.judge", value: selected, persist }); await waitReceipt(props.client!, handle.requestId); }
      if (current === epoch.current) { setConfigured(selected); setNotice(zh ? "已更新 Judge 模型，新批次使用此配置。" : "Judge model updated for new batches."); }
    } catch (cause) { if (current === epoch.current) setError(hostErrorMessage(cause, "Cannot update judge model")); }
    finally { if (current === epoch.current) { lock.current = false; setBusy(false); } }
  }
  return <section className="feature-settings" aria-label={zh ? "评判模型" : "Judge model"}><header className="feature-settings-head"><div><span className="feature-eyebrow">{zh ? "评测配置" : "EVALUATION SETTINGS"}{preview ? " · DEMO" : ""}</span><h3>{zh ? "评判模型" : "Judge model"}</h3></div></header><p className="feature-status">{zh ? "使用已连接的原生评判模型或聊天模型。批处理沿用原生问题分组、重试和部分成功用量统计。" : "Use a connected native judge or chat model. Native batching, retries and partial-success usage accounting apply."}</p><p className="small"><span className="muted">{zh ? "当前 Judge 配置" : "Current judge configuration"} · </span><code>{configured || (zh ? "原生默认角色链" : "Native default role chain")}</code></p><div className="feature-actions"><AppSelect className="select" aria-label={zh ? "选择评判模型" : "Select judge model"} value={selected} disabled={!enabled || busy || !models.length} onChange={event => setSelected(event.target.value)}><option value="">{zh ? "选择模型…" : "Choose a model…"}</option><optgroup label={zh ? "原生评判模型" : "Native judges"}>{models.filter(row => row.kind === "judge").map(row => <option key={row.selector} value={row.selector}>{row.name} · {row.provider}</option>)}</optgroup><optgroup label={zh ? "聊天模型" : "Chat models"}>{models.filter(row => row.kind !== "judge").map(row => <option key={row.selector} value={row.selector}>{row.name} · {row.provider}</option>)}</optgroup></AppSelect><label className="small"><input type="checkbox" checked={persist} disabled={busy} onChange={event => setPersist(event.target.checked)} />{zh ? "保存到用户配置" : "Save to user settings"}</label><button className="btn outline" disabled={!enabled || busy || !selected} onClick={() => void save()}>{zh ? "应用模型" : "Apply model"}</button></div>{!enabled ? <p className="feature-status">{zh ? "连接支持评测的 Runtime 后可配置。" : "Connect an evaluation-capable Runtime to configure the judge."}</p> : null}{error ? <p role="alert" className="feature-error">{error}</p> : null}{notice ? <p role="status" className="feature-status">{notice}</p> : null}</section>;
}
