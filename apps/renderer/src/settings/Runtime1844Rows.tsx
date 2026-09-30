import { useEffect, useState } from "react";
import { GUI_SETTING_DEFINITIONS, GUI_SETTING_KEYS, validateGuiSetting, type GuiSettingKey } from "@omp-studio/studio-protocol";
import type { StudioRuntimeSettingValue } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import type { RuntimeSettingsCtl } from "./tabs";
import { SettingRow, SettingSection, Switch } from "./SettingRow";

export function Runtime1844Rows({ runtime }: { runtime?: RuntimeSettingsCtl | undefined }) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const [persist, setPersist] = useState(true);
  return <SettingSection title={zh ? "运行与模型偏好" : "Runtime and model preferences"}>
    <label className="small muted">{zh ? "修改保存到 " : "Save changes to "}
      <select className="select" value={persist ? "global" : "session"} onChange={e => setPersist(e.target.value === "global")}>
        <option value="global">{zh ? "用户配置" : "User configuration"}</option>
        <option value="session">{zh ? "仅当前会话" : "Current session only"}</option>
      </select>
    </label>
    {GUI_SETTING_KEYS.map(key => <RuntimeSetting key={key} name={key} runtime={runtime} persist={persist} />)}
    {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
  </SettingSection>;
}

function RuntimeSetting({ name, runtime, persist }: { name: GuiSettingKey; runtime?: RuntimeSettingsCtl | undefined; persist: boolean }) {
  const { resolvedLanguage } = useI18n(); const zh = resolvedLanguage === "zh";
  const definition = GUI_SETTING_DEFINITIONS[name];
  const preview = runtime?.preview === true;
  const [demo, setDemo] = useState<unknown>(definition.default);
  const value = preview ? demo : runtime?.activation?.configured[name] ?? runtime?.snapshot?.[name];
  const [draft, setDraft] = useState(""); const [error, setError] = useState("");
  useEffect(() => { setDraft(typeof value === "object" ? JSON.stringify(value ?? {}, null, 2) : String(value ?? "")); setError(""); }, [value]);
  const enabled = preview || (value !== undefined && runtime?.set !== undefined);
  const disabled = !enabled || runtime?.pendingKey !== undefined;
  const source = preview ? "default" : runtime?.activation?.sources?.[name];
  const sourceLabels = zh ? { env: "环境变量", runtime: "会话覆盖", overlay: "启动覆盖", project: "项目配置", global: "用户配置", default: "默认值" } : { env: "Environment", runtime: "Session", overlay: "Startup overlay", project: "Project", global: "User", default: "Default" };
  const label = zh ? definition.zh : definition.en;
  const save = (next: unknown) => {
    try {
      validateGuiSetting(name, next); setError("");
      if (preview) setDemo(next); else runtime?.set?.(name, next as StudioRuntimeSettingValue, persist);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const hint = "note" in definition ? (zh ? definition.note : definition.noteEn) : "";
  return <SettingRow label={label} desc={hint} source={!enabled ? "unavailable" : source === "global" ? "user" : source === "project" ? "project" : source === "default" ? "default" : "runtime"}
    reason={zh ? "当前 Runtime 未提供此设置" : "Unavailable in this Runtime"}>
    <div style={{ display: "grid", gap: 6, minWidth: 200, maxWidth: 420 }}>
      {definition.type === "boolean" ? <Switch label={label} disabled={disabled} checked={value === true} onChange={save} /> :
        definition.type === "enum" ? <select className="select" aria-label={label} disabled={disabled} value={String(value ?? "")} onChange={e => save(e.target.value)}>
          {!enabled ? <option value="">—</option> : null}
          {definition.values.map(option => <option key={option} value={option} disabled={name === "spelling.autocomplete" && option === "apple" && !/Mac/i.test(navigator.platform)}>{option}</option>)}
        </select> : <>
          {definition.type === "thresholds" ? <textarea className="input" aria-label={label} disabled={disabled} rows={3} value={draft} onChange={e => setDraft(e.target.value)} /> :
            <input className="input" aria-label={label} disabled={disabled} type={definition.type === "number" ? "number" : "text"} min={0} value={draft} onChange={e => setDraft(e.target.value)} />}
          <button className="btn sm" disabled={disabled} onClick={() => { try { save(definition.type === "thresholds" ? JSON.parse(draft) : definition.type === "number" ? Number(draft) : draft); } catch (cause) { setError(String(cause)); } }}>{zh ? "应用" : "Apply"}</button>
        </>}
      <span className="small muted">{preview ? (zh ? "演示" : "Demo") : source ? sourceLabels[source] : "—"}{persist && (source === "project" || source === "overlay" || source === "env") ? (zh ? " · 保存后仍可能被更高层覆盖" : " · Higher layers may still override saved changes") : ""}</span>
      {enabled ? <span className="small muted">{zh ? "当前生效：" : "Effective: "}{JSON.stringify(preview ? demo : runtime?.snapshot?.[name]) ?? "—"}{runtime?.activation?.restartRequired.includes(name) ? (zh ? " · 需要重启 Runtime" : " · Runtime restart required") : ""}</span> : null}
      {error ? <span role="alert" className="small">{error}</span> : null}
    </div>
  </SettingRow>;
}
