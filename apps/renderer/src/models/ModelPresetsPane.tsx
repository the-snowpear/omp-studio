import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandInput } from "@omp-studio/client-contract";
import type { ModelPresetResult, ModelPresetRow, SessionOptionsResultMap } from "@omp-studio/studio-protocol";
import { usePreviewMode } from "../preview/PreviewContext";
import { useI18n } from "../i18n";
import { hostErrorMessage, waitReceipt } from "../hostError";
import { WorkspaceEmpty } from "../workspaces/Workspace";
import { PREVIEW_MODEL_PRESETS } from "../preview/sessionOptionsPreview";
import type { SessionOptionsProps } from "./SessionOptionsPane";
import "./sessionOptions.css";

export function ModelPresetsPane({ client, sessionId, available, visible = true, capabilities }: SessionOptionsProps) {
  const { preview } = usePreviewMode(); const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [rows, setRows] = useState<ModelPresetRow[]>([]); const [selected, setSelected] = useState<string>();
  const [name, setName] = useState(""); const [error, setError] = useState(""); const [result, setResult] = useState<ModelPresetResult>();
  const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<{ kind: "models.presets.save" | "models.presets.apply" | "models.presets.delete"; name: string }>();
  const epoch = useRef(0); const lock = useRef(false);
  const supports = (id: string) => preview || capabilities?.capabilities.some(item => item.id === id && item.grade !== "unavailable") === true;
  const enabled = preview || (available && !!sessionId && supports("models.presets.list"));
  const invoke = useCallback(async <K extends keyof SessionOptionsResultMap>(kind: K, input: CommandInput<K>): Promise<SessionOptionsResultMap[K]> => {
    const handle = await client.command(kind, input); return (await waitReceipt<{ result: SessionOptionsResultMap[K] }>(client, handle.requestId)).result;
  }, [client]);
  useEffect(() => { epoch.current++; lock.current = false; setBusy(false); setError(""); setResult(undefined); setConfirm(undefined); setSelected(undefined); setRows(preview ? structuredClone(PREVIEW_MODEL_PRESETS) : []); return () => { epoch.current++; }; }, [sessionId, preview]);
  useEffect(() => {
    if (preview || !visible || !enabled || !sessionId) return; let active = true;
    void invoke("models.presets.list", { sessionId }).then(value => { if (active) setRows(value.presets); }).catch(cause => { if (active) setError(hostErrorMessage(cause, zh ? "预设读取失败" : "Cannot read presets")); });
    return () => { active = false; };
  }, [preview, visible, enabled, sessionId, invoke, zh]);
  const apply = async () => {
    if (!confirm || lock.current || !enabled) return; const generation = epoch.current; lock.current = true; setBusy(true); setError(""); setResult(undefined);
    try {
      if (preview) {
        if (confirm.kind === "models.presets.delete") setRows(value => value.filter(row => row.name !== confirm.name));
        else if (confirm.kind === "models.presets.apply") setRows(value => value.map(row => ({ ...row, active: row.name === confirm.name })));
        else setRows(value => [...value.filter(row => row.name !== confirm.name), { ...structuredClone(PREVIEW_MODEL_PRESETS[0]!), name: confirm.name, active: false }]);
        setResult({ outcome: confirm.kind === "models.presets.delete" ? "deleted" : confirm.kind === "models.presets.apply" ? "switched" : "saved" });
      } else {
        const outcome = await invoke(confirm.kind, { sessionId: sessionId!, name: confirm.name });
        if (generation !== epoch.current) return; setResult(outcome);
        const value = await invoke("models.presets.list", { sessionId: sessionId! }); if (generation === epoch.current) setRows(value.presets);
      }
      if (generation === epoch.current) { setSelected(confirm.name); setConfirm(undefined); }
    } catch (cause) { if (generation === epoch.current) setError(hostErrorMessage(cause, zh ? "预设操作失败" : "Preset operation failed")); }
    finally { if (generation === epoch.current) { lock.current = false; setBusy(false); } }
  };
  const picked = rows.find(row => row.name === selected) ?? rows.find(row => row.active) ?? rows[0];
  const outcomeLabel = result ? ({ saved: zh ? "预设已保存" : "Preset saved", deleted: zh ? "预设已删除" : "Preset deleted", switched: zh ? "预设已切换" : "Preset applied", missing: zh ? "预设不存在" : "Preset missing", project: zh ? "此预设仍由项目或覆盖配置定义，请在对应配置中删除。" : "This preset remains defined in a project or overlay. Remove it in that configuration.", invalid: zh ? "预设配置无效" : "Invalid preset", unavailable: zh ? "预设模型不可用，当前会话保持不变。" : "Preset model unavailable. Current session preserved.", failed: zh ? "切换失败，请检查已写入的角色配置。" : "Switch failed. Review the role configuration that was saved." })[result.outcome] : "";
  return <div className="model-presets-pane">
    <p className="muted">{zh ? "预设保存完整角色链和推理档位。切换时由原生配置层级决定生效值，并报告覆盖冲突。" : "Presets save role chains and thinking levels. Native configuration scopes determine effective values and report conflicts."}{preview ? zh ? " · 演示" : " · Demo" : ""}</p>
    {!enabled ? <p role="status">{zh ? "连接支持模型预设的 Runtime 后可管理预设。" : "Connect a Runtime with model preset support to manage presets."}</p> : null}
    <div className="session-options-row"><label>{zh ? "保存当前配置为" : "Save current setup as"}<input className="input" value={name} maxLength={128} onChange={event => setName(event.target.value)} placeholder={zh ? "名称：以字母开头" : "Name: start with a letter"} /></label><button className="btn primary" disabled={!enabled || busy || !supports("models.presets.save") || !/^[a-zA-Z][\w-]*$/u.test(name)} onClick={() => setConfirm({ kind: "models.presets.save", name })}>{zh ? "保存预设" : "Save preset"}</button></div>
    {error ? <p className="session-options-error" role="alert">{error}</p> : null}
    {result ? <div className="session-options-note" role="status"><strong>{outcomeLabel}</strong>{result.reason ? <span>{result.reason}</span> : null}{result.shadowOwner ? <span>{zh ? "同名预设被覆盖" : "Same-name preset shadowed"} · {result.shadowOwner}</span> : null}{result.shadowed?.map(row => <span key={row.role}>{row.role}: {row.expected ?? "—"} → {row.actual ?? "—"} ({row.source})</span>)}{result.shadowedThinking ? <span>{zh ? "推理档位被覆盖" : "Thinking level shadowed"}: {result.shadowedThinking.expected} → {result.shadowedThinking.actual ?? "—"} ({result.shadowedThinking.source})</span> : null}</div> : null}
    {confirm ? <div className="session-options-confirm" role="dialog" aria-label={zh ? "确认预设操作" : "Confirm preset action"}><strong>{confirm.kind === "models.presets.delete" ? zh ? "删除预设" : "Delete preset" : confirm.kind === "models.presets.save" ? zh ? "保存完整配置" : "Save complete setup" : zh ? "切换角色与模型" : "Apply roles and model"} · {confirm.name}</strong><p>{confirm.kind === "models.presets.apply" ? zh ? "当前角色链将由此预设替换。缺失模型会阻止切换并显示原因。" : "This preset replaces current role chains. A missing model blocks switching and reports the reason." : zh ? "此操作写入原生全局配置。同名预设可能被项目或覆盖配置遮盖。" : "This writes native global configuration. Project or overlay configuration may shadow the same name."}</p><button className="btn primary" disabled={busy} onClick={() => void apply()}>{zh ? "确认" : "Confirm"}</button><button className="btn outline" disabled={busy} onClick={() => setConfirm(undefined)}>{zh ? "取消" : "Cancel"}</button></div> : null}
    {picked ? <div className="model-presets"><div className="model-presets-list" aria-label={zh ? "模型预设" : "Model presets"}>{rows.map(row => <button type="button" aria-pressed={row.name === picked.name} key={row.name} onClick={() => setSelected(row.name)}><b>{row.name}</b>{row.active ? <span className="chip blue xs">{zh ? "生效中" : "Active"}</span> : null}</button>)}</div><section className="model-presets-detail"><h3>{picked.name}</h3><p className="small muted">{zh ? "来源" : "Source"} · {picked.source} · {zh ? "推理档位" : "Thinking"} · {picked.thinking ?? "—"}</p>{picked.error ? <p role="alert">{picked.error}</p> : null}<dl>{Object.entries(picked.roles).map(([role, selector]) => <div key={role} style={{ display: "contents" }}><dt>{role}</dt><dd className="mono">{selector}</dd></div>)}</dl><div className="session-options-row"><button className="btn primary" disabled={!enabled || busy || !!picked.error || !supports("models.presets.apply")} onClick={() => setConfirm({ kind: "models.presets.apply", name: picked.name })}>{zh ? "应用预设" : "Apply preset"}</button><button className="btn outline danger" disabled={!enabled || busy || !supports("models.presets.delete")} onClick={() => setConfirm({ kind: "models.presets.delete", name: picked.name })}>{zh ? "删除" : "Delete"}</button></div></section></div> : <WorkspaceEmpty title={zh ? "还没有模型预设" : "No model presets"}>{zh ? "配置好角色后保存，以便在不同任务之间切换。" : "Save configured roles to switch between tasks."}</WorkspaceEmpty>}
  </div>;
}
