import { AppSelect } from "../AppSelect";
import { Fragment, useEffect, useState } from "react";
import { GUI_SETTING_DEFINITIONS, GUI_SETTING_KEYS, validateGuiSetting, type GuiSettingKey } from "@omp-studio/studio-protocol";
import type { StudioRuntimeSettingValue } from "@omp-studio/client-contract";
import { useI18n } from "../i18n";
import { usePreviewMode } from "../preview/PreviewContext";
import type { RuntimeSettingsCtl } from "./tabs";
import { SettingRow, SettingSection, Switch } from "./SettingRow";
import { useHasSettingsScope, useSettingsScope } from "./SettingsScope";

export function Runtime1844Rows({ runtime, names = GUI_SETTING_KEYS, title, inspectBackend }: {
  runtime?: RuntimeSettingsCtl | undefined;
  names?: readonly GuiSettingKey[] | undefined;
  title?: string | undefined;
  inspectBackend?: "mnemopi" | "hindsight" | undefined;
}) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const [scope, setScope] = useSettingsScope();
  const sharedScope = useHasSettingsScope();
  const backend = runtime?.preview ? runtime.previewValues?.["memory.backend"] ?? "off" : runtime?.snapshot?.["memory.backend"];
  const firstInspected = inspectBackend && backend !== inspectBackend ? names.find(key => key.startsWith(`${inspectBackend}.`)) : undefined;
  return <SettingSection title={title ?? (zh ? "运行与模型偏好" : "Runtime and model preferences")}>
    {!sharedScope ? <label className="small muted settings-scope">{zh ? "修改保存到 " : "Save changes to "}
      <AppSelect className="select" aria-label={zh ? "运行设置保存范围" : "Runtime setting scope"} value={scope} onChange={e => setScope(e.target.value as "global" | "session")}>
        <option value="global">{zh ? "用户配置" : "User configuration"}</option>
        <option value="session">{zh ? "仅当前会话" : "Current session only"}</option>
      </AppSelect>
    </label> : null}
    {names.filter(key => !key.startsWith("mnemopi.") && !key.startsWith("hindsight.") || key.startsWith("mnemopi.") && (backend === "mnemopi" || inspectBackend === "mnemopi" || backend === undefined && key === "mnemopi.scoping") || key.startsWith("hindsight.") && (backend === "hindsight" || inspectBackend === "hindsight")).map(key => <Fragment key={key}>
      {key === firstInspected ? <p className="small muted">{zh ? `当前未启用 ${inspectBackend}；以下配置在选择该后端后生效。` : `${inspectBackend} is not active; these settings apply when it is selected.`}</p> : null}
      <RuntimeSetting name={key} runtime={runtime} persist={scope === "global"} />
    </Fragment>)}
    {runtime?.error ? <p role="alert">{runtime.error}</p> : null}
  </SettingSection>;
}

function RuntimeSetting({ name, runtime, persist }: { name: GuiSettingKey; runtime?: RuntimeSettingsCtl | undefined; persist: boolean }) {
  const { resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const { marks } = usePreviewMode();
  const definition = GUI_SETTING_DEFINITIONS[name];
  const preview = runtime?.preview === true;
  const value = preview ? (runtime?.previewValues?.[name] ?? definition.default) : runtime?.activation?.configured[name] ?? runtime?.snapshot?.[name];
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setDraft(definition.type === "strings" && Array.isArray(value) ? value.join("\n") : typeof value === "object" ? JSON.stringify(value ?? {}, null, 2) : String(value ?? "")); setError(""); }, [value, definition.type]);
  const enabled = preview || value !== undefined;
  const readOnly = enabled && !preview && runtime?.set === undefined;
  const globalOnly = name === "plan.defaultOnStartup";
  const disabled = !enabled || readOnly || runtime?.pendingKey !== undefined || (globalOnly && !persist);
  const source = preview ? "default" : runtime?.activation?.sources?.[name];
  const canOverride = source === "env" || source === "overlay";
  const label = zh ? definition.zh : definition.en;
  const save = (next: unknown) => {
    try {
      validateGuiSetting(name, next);
      setError("");
      runtime?.set?.(name, next as StudioRuntimeSettingValue, persist);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const hint = "note" in definition ? (zh ? definition.note : definition.noteEn) : "";
  const higher = (persist && (source === "project" || source === "overlay" || source === "env" || source === "runtime")) || (!persist && canOverride);
  const restart = runtime?.activation?.restartRequired.includes(name);
  const effectiveNumber = typeof value !== "number" ? undefined : name === "read.defaultLimit" ? Math.max(1, Math.min(3000, value)) : name === "async.maxJobs" ? Math.max(1, Math.floor(Math.min(100, value))) : name === "mnemopi.recallLimit" ? Math.max(1, Math.floor(value)) : name === "mnemopi.injectionTokenLimit" ? Math.max(256, Math.floor(value)) : name === "tools.maxTimeout" && value <= 0 ? 0 : undefined;
  const optionLabel = (option: string) => {
    const translations: Record<string, [string, string]> = {
      "all": ["一次处理全部", "All at once"], "one-at-a-time": ["一次处理一条", "One at a time"],
      "immediate": ["立即", "Immediately"], "wait": ["当前工具完成后", "After the current tool"],
      "default": ["默认", "Default"], "friendly": ["友好", "Friendly"], "pragmatic": ["务实", "Pragmatic"],
      "none": ["不指定", "None"], "low": ["简洁", "Concise"], "medium": ["适中", "Balanced"], "high": ["详细", "Detailed"],
      "auto": ["自动", "Auto"], "off": ["关闭", "Off"],
      "local": ["本地摘要", "Local summaries"], "global": ["全局", "Global"], "per-project": ["按项目", "Per project"], "per-project-tagged": ["按项目并共享召回", "Per project with shared recall"],
      "prompt": ["重复提示", "Repeat prompt"], "compact": ["压缩后重复", "Compact and repeat"], "reset": ["新会话", "New session"], "branch": ["分支合并", "Branch merge"], "patch": ["补丁", "Patch"],
    };
    return translations[option]?.[zh ? 0 : 1] ?? option;
  };
  return <SettingRow label={label} desc={hint} source={!enabled ? "unavailable" : source === "global" ? "user" : source ?? "runtime"}
    reason={zh ? "连接支持此设置的 Runtime 后可配置。" : "Connect a Runtime that supports this setting."}>
    <div className="runtime-setting-control">
      {definition.type === "boolean" ? <Switch label={label} disabled={disabled} checked={value === true} onChange={save} /> :
        definition.type === "enum" ? <AppSelect className="select" aria-label={label} disabled={disabled} value={String(value ?? "")} onChange={e => save(e.target.value)}>
          {!enabled ? <option value="">—</option> : null}
          {definition.values.map(option => <option key={option} value={option} disabled={name === "spelling.autocomplete" && option === "apple" && !/Mac/i.test(navigator.platform)}>{optionLabel(option)}</option>)}
        </AppSelect> : <>
          {definition.type === "thresholds" || definition.type === "strings" ? <textarea className="input" aria-label={label} disabled={disabled} rows={3} value={draft} onChange={e => setDraft(e.target.value)} /> :
            <input className="input" aria-label={label} disabled={disabled} type={definition.type === "number" ? "number" : "text"} min={definition.type === "number" ? ("min" in definition ? definition.min : 0) : undefined} max={definition.type === "number" && "max" in definition ? definition.max : undefined} step={definition.type === "number" && "step" in definition ? definition.step : undefined} value={draft} onChange={e => setDraft(e.target.value)} />}
          <button className="btn small" disabled={disabled || (definition.type !== "string" && definition.type !== "strings" && draft.trim() === "")} onClick={() => { try { save(definition.type === "thresholds" ? JSON.parse(draft) : definition.type === "strings" ? draft.split(/\r?\n/u).map(line => line.trim()).filter(Boolean) : definition.type === "number" ? Number(draft) : draft); } catch (cause) { setError(String(cause)); } }}>{zh ? "应用" : "Apply"}</button>
        </>}
      {preview && marks ? <span className="small muted">{zh ? "演示" : "Demo"}</span> : null}
      {readOnly ? <span className="small muted">{zh ? "当前 Runtime 只提供读取" : "Read-only in this Runtime"}</span> : null}
      {globalOnly && !persist ? <span className="small muted">{zh ? "新会话默认模式只能保存到用户配置。" : "The new-session default can only be saved to user configuration."}</span> : null}
      {higher ? <span className="small muted">{zh ? "当前值被更高层配置覆盖：" : "Higher-priority value: "}{JSON.stringify(runtime?.snapshot?.[name])}</span> : null}
      {effectiveNumber !== undefined && effectiveNumber !== value ? <span className="small muted">{zh ? "Runtime 实际使用：" : "Effective Runtime value: "}{effectiveNumber}</span> : null}
      {name === "edit.mode" && runtime?.activation?.resolvedEditMode && runtime.activation.resolvedEditMode !== value ? <span className="small muted">{zh ? "当前模型实际使用：" : "Effective mode for this model: "}{runtime.activation.resolvedEditMode}</span> : null}
      {restart ? <span className="small muted">{zh ? "已保存，需重启 Runtime" : "Saved; Runtime restart required"}</span> : null}
      {error ? <span role="alert" className="small">{error}</span> : null}
    </div>
  </SettingRow>;
}
