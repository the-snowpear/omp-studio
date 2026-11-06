import { useEffect, useRef, useState } from "react";
import type { FeatureSettingKey, FeatureSettingRow, FeatureSettingValue } from "@omp-studio/studio-protocol";
import { AppSelect } from "../AppSelect";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import { PREVIEW_COMPUTER_SETTINGS } from "../preview/computerPreview";
import { useFeatureSettings, type FeatureSettingsProps } from "../settings/useFeatureSettings";
import { useSettingsScope } from "../settings/SettingsScope";
import { Switch } from "../settings/SettingRow";
import { computerCommand } from "./workspaceSource";
import { hostErrorMessage } from "../hostError";
import "./computerWorkspace.css";

type ComputerSetting = { key: FeatureSettingKey; zh: string; en: string; hint: string; hintEn: string; min?: number; max?: number; options?: Array<[string, string, string]> };
export const COMPUTER_SETTING_DEFINITIONS: ComputerSetting[] = [
  { key: "computer.enabled", zh: "允许电脑操作", en: "Allow computer use", hint: "允许原生电脑调用，具体输入仍遵守审批。关闭本次会话时先停止；全局默认不改写会话覆盖，重新启用不会恢复授权。", hintEn: "Allow native computer calls, subject to input approval. Disabling this session first stops it. Global defaults preserve session overrides; re-enabling does not resume authorization." },
  { key: "computer.display", zh: "原生默认显示器", en: "Native default display", hint: "输入 active（当前）、all（全部）或原生显示器 ID。与面板的固定观察目标无关。", hintEn: "Enter active, all, or a native display ID. Independent of the panel's fixed observation target." },
  { key: "computer.maxWidth", zh: "截图最大宽度", en: "Maximum capture width", hint: "原生截图配置上限；实际图像尺寸还受模型和目标限制，以画面标注为准。", hintEn: "Native capture limit. The model and target may further limit actual image dimensions.", min: 1, max: 16384 },
  { key: "computer.maxHeight", zh: "截图最大高度", en: "Maximum capture height", hint: "截图原始像素不一定等于显示器全分辨率。", hintEn: "Received image pixels are not necessarily the full display resolution.", min: 1, max: 16384 },
  { key: "computer.backgroundFallback", zh: "后台输入不可用时", en: "When background input is unavailable", hint: "接管前台仍遵守原生审批；拒绝会同时禁止代理自行抢占前台。", hintEn: "Foreground takeover still requires native approval. Refuse also prevents the agent from taking the foreground.", options: [["takeover", "请求接管前台", "Request foreground takeover"], ["refuse", "拒绝", "Refuse"]] },
];
const SOURCE: Record<FeatureSettingRow["source"], [string, string]> = { env: ["环境变量", "Environment"], runtime: ["本次会话", "Session"], overlay: ["运行覆盖", "Overlay"], project: ["项目配置", "Project"], global: ["全局默认", "Global default"], default: ["原生默认", "Native default"] };

export function ComputerSettings(props: FeatureSettingsProps & { onSaved?(): void; previewEnabled?: boolean | undefined; onPreviewEnabled?(enabled: boolean): void }) {
  const state = useFeatureSettings(props), { preview, marks } = usePreviewMode(), { resolvedLanguage } = useI18n(), zh = resolvedLanguage === "zh";
  const [scope, setScope] = useSettingsScope("session");
  const [demoRows, setDemoRows] = useState(() => PREVIEW_COMPUTER_SETTINGS.map(row => row.key === "computer.enabled" && props.previewEnabled !== undefined ? { ...row, value: props.previewEnabled } : row));
  useEffect(() => { if (props.previewEnabled !== undefined) setDemoRows(current => current.map(row => row.key === "computer.enabled" ? { ...row, value: props.previewEnabled! } : row)); }, [props.previewEnabled]);
  const previewGlobalValues = useRef(new Map<FeatureSettingKey, FeatureSettingValue>());
  const [stopping, setStopping] = useState(false), [error, setError] = useState("");
  const lock = useRef(false), generation = useRef(0);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [props.context?.sessionId, preview]);
  const rows = preview ? demoRows : state.rows;
  const disabled = !state.enabled || !state.supports("preferences.features.set") || state.busy || state.loading || stopping;
  const save = async (key: FeatureSettingKey, value: FeatureSettingValue) => {
    if (lock.current || disabled) return;
    lock.current = true; setError("");
    const stamp = generation.current;
    try {
      if (scope === "session" && key === "computer.enabled" && value === false && !preview) {
        if (!props.client || !props.context?.sessionId || !state.supports("computer.control.stop")) throw Error(zh ? "请先升级 Runtime，以确认停止后再关闭电脑能力。" : "Upgrade Runtime so a stop can be confirmed before disabling computer use.");
        setStopping(true);
        const control = await computerCommand(props.client, "computer.control.stop", { sessionId: props.context.sessionId, reason: "disable" });
        if (stamp !== generation.current) return;
        if (control.status !== "stopped") throw Error(zh ? "停止尚未完全确认，未修改启用设置。" : "Stop is not fully confirmed; the enabled setting was not changed.");
      }
      const keepsSessionOverride = scope === "global" && rows.find(row => row.key === key)?.source === "runtime";
      if (preview) {
        if (scope === "global") previewGlobalValues.current.set(key, value);
        setDemoRows(current => current.map(row => row.key === key && !keepsSessionOverride ? { ...row, value, source: scope === "session" ? "runtime" : "global" } : row));
      } else await state.save(key, value, scope);
      if (preview && key === "computer.enabled" && !keepsSessionOverride) props.onPreviewEnabled?.(value === true);
      if (stamp === generation.current) props.onSaved?.();
    } catch (cause) { if (stamp === generation.current) setError(hostErrorMessage(cause, zh ? "无法保存电脑设置" : "Cannot save Computer settings")); }
    finally { lock.current = false; if (stamp === generation.current) setStopping(false); }
  };
  const clear = async (key: FeatureSettingKey) => {
    if (lock.current || disabled) return;
    lock.current = true; setError("");
    const stamp = generation.current;
    try {
      if (!preview && key === "computer.enabled") {
        if (!props.client || !props.context?.sessionId || !state.supports("computer.control.stop")) throw Error(zh ? "请先升级 Runtime，以确认停止后恢复继承。" : "Upgrade Runtime to confirm a stop before inheriting the enabled setting.");
        setStopping(true);
        const control = await computerCommand(props.client, "computer.control.stop", { sessionId: props.context.sessionId, reason: "disable" });
        if (stamp !== generation.current) return;
        if (control.status !== "stopped") throw Error(zh ? "停止尚未完全确认，未清除会话覆盖。" : "Stop is not confirmed; the override was not cleared.");
      }
      if (preview) {
        const globalValue = previewGlobalValues.current.get(key);
        const value = globalValue ?? PREVIEW_COMPUTER_SETTINGS.find(item => item.key === key)!.value;
        setDemoRows(current => current.map(row => row.key === key ? { ...row, value, source: globalValue === undefined ? "default" : "global" } : row));
        if (key === "computer.enabled") props.onPreviewEnabled?.(value === true);
      } else await state.clear(key);
      if (stamp === generation.current) props.onSaved?.();
    } catch (cause) { if (stamp === generation.current) setError(hostErrorMessage(cause, zh ? "无法恢复继承" : "Cannot restore inherited settings")); }
    finally { lock.current = false; if (stamp === generation.current) setStopping(false); }
  };
  return <section className="cw-settings" aria-label={zh ? "电脑操作设置" : "Computer use settings"}>
    <header><h3>{zh ? "电脑操作" : "Computer use"}{preview && marks ? zh ? " · 演示" : " · Demo" : ""}</h3><label>{zh ? "保存到" : "Save to"}<AppSelect aria-label={zh ? "电脑设置保存范围" : "Computer settings scope"} value={scope} disabled={disabled} onChange={event => setScope(event.target.value as typeof scope)}><option value="session">{zh ? "本次会话" : "This session"}</option><option value="global">{zh ? "全局默认" : "Global defaults"}</option></AppSelect></label></header>
    <p className="cw-subtle">{scope === "session" ? zh ? "只覆盖本次会话。清除覆盖后恢复继承。" : "Override this session only. Clear an override to inherit again." : zh ? "全局修改影响继承该值的会话，不覆盖明确的项目或会话配置。下方生效值来自当前会话，不代表被覆盖的全局默认。" : "Global changes affect inheriting sessions, preserving explicit project and session overrides. Effective values below belong to this session, not an overridden global default."}</p>
    {!state.enabled ? <p>{zh ? "当前 Runtime 没有可读取的电脑设置。" : "Computer settings are unavailable from this Runtime."}</p> : null}
    {COMPUTER_SETTING_DEFINITIONS.map(definition => <ComputerSettingRow key={definition.key} scope={scope} definition={definition} row={rows.find(row => row.key === definition.key)} zh={zh} disabled={disabled} onSave={value => void save(definition.key, value)} onClear={() => void clear(definition.key)} canClear={state.supports("preferences.features.clearOverride")} />)}
    {stopping ? <p role="status">{zh ? "先停止本会话的电脑操作…" : "Stopping computer actions before disabling…"}</p> : null}
    {error || state.error ? <p className="cw-error" role="alert">{error || state.error}</p> : null}
    {state.notice && !preview ? <p role="status">{zh ? "已保存；显示的是当前生效值与来源。" : "Saved; current effective values and their sources are shown."}</p> : null}
    <p className="cw-subtle">{zh ? "额外观察画面只作短期缓存，不自动进入对话或产物库。重要画面请显式保存；清理观察缓存不等于删除原生工具截图。" : "Extra observation is temporary and does not automatically enter the conversation or artifact library. Explicitly save important frames; clearing observation does not delete native tool captures."}</p>
  </section>;
}
function ComputerSettingRow({ definition, row, zh, disabled, onSave, onClear, canClear, scope }: { scope: "session" | "global"; definition: ComputerSetting; row?: FeatureSettingRow | undefined; zh: boolean; disabled: boolean; onSave(value: FeatureSettingValue): void; onClear(): void; canClear: boolean }) {
  const label = zh ? definition.zh : definition.en;
  const [draft, setDraft] = useState(String(row?.value ?? ""));
  useEffect(() => setDraft(String(row?.value ?? "")), [row?.value]);
  const unavailable = disabled || !row;
  return <div className="cw-setting-row" data-setting-label={label}><div><strong>{label}</strong><p>{zh ? definition.hint : definition.hintEn}</p><span className="cw-setting-source">{row ? `${zh ? "生效值" : "Effective"}：${String(row.value)} · ${SOURCE[row.source][zh ? 0 : 1]}` : zh ? "此 Runtime 未提供该设置" : "This Runtime does not expose this setting"}</span></div>
    {definition.key === "computer.enabled" && scope === "global" ? <AppSelect aria-label={zh ? "全局默认电脑操作" : "Global default computer use"} value="" disabled={unavailable} onChange={event => onSave(event.target.value === "true")}><option value="">{zh ? "选择要保存的全局默认" : "Choose a new global default"}</option><option value="true">{zh ? "启用" : "Enable"}</option><option value="false">{zh ? "关闭" : "Disable"}</option></AppSelect> : definition.key === "computer.enabled" ? <Switch checked={row?.value === true} label={label} disabled={unavailable} onChange={onSave} /> : definition.options ? <AppSelect aria-label={label} value={String(row?.value ?? "")} disabled={unavailable} onChange={event => onSave(event.target.value)}>{!row ? <option value="">—</option> : null}{definition.options.map(([value, cn, en]) => <option key={value} value={value}>{zh ? cn : en}</option>)}</AppSelect> : definition.key === "computer.display" ? <><input className="input" aria-label={label} value={draft} disabled={unavailable} onChange={event => setDraft(event.target.value)} /><button className="cw-button" disabled={unavailable || !draft.trim() || draft === row?.value} onClick={() => onSave(draft.trim())}>{zh ? "应用" : "Apply"}</button></> : <><input className="input" type="number" aria-label={label} min={definition.min} max={definition.max} step={1} value={draft} disabled={unavailable} onChange={event => setDraft(event.target.value)} /><button className="cw-button" disabled={unavailable || !draft || !Number.isInteger(Number(draft)) || Number(draft) < definition.min! || Number(draft) > definition.max! || String(row?.value) === draft} onClick={() => onSave(Number(draft))}>{zh ? "应用" : "Apply"}</button></>}
    {row?.source === "runtime" ? <button className="cw-button" disabled={unavailable || !canClear} onClick={onClear}>{definition.key === "computer.enabled" ? zh ? "停止并恢复继承" : "Stop and inherit" : zh ? "清除会话覆盖" : "Clear session override"}</button> : null}
  </div>;
}
