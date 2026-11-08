import { TimeTravelSettings } from "./settings/TimeTravelSettings";
import { FileViewerSettings, OfficeComponentSettings } from "./files/FileViewerSettings";
import { SessionWorktreesPane } from "./workspaces/SessionWorktreesPane";
import { BackgroundSettingsPane } from "./settings/BackgroundSettingsPane";
import { FeatureSettingsPane } from "./settings/FeatureSettingsPane";
import { DictationSettingsPane } from "./settings/DictationSettingsPane";
import { PredictionSettingsPane } from "./settings/PredictionSettingsPane";
import "./composer/prediction.css";
import { NativePreferencesPane, type NativePreferencesContext } from "./settings/NativePreferencesPane";
import { ArtifactStorageSettings } from "./media/ArtifactLibraryPane";
/**
 * 设置页：按用途分类、搜索和定位具体设置。
 *
 * 职责原则：设置页只负责「改变全局行为」，不管理对象——模型 / Provider /
 * 角色 / Fallback 在模型配置页，能力启停在能力中心，子代理定义在模型配置
 * · 子代理，会话管理在历史页，Runtime / Bridge / 日志在诊断页。
 *
 * 数据面：真实模式读取本机偏好与 Host / Runtime 设置；预览控件只改演示状态。
 */

import { useEffect, useRef, useState } from "react";
import { tabPaneClass, tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { useI18n } from "./i18n";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_APP_SETTINGS, PREVIEW_APPROVAL_MODE, usePreviewAppSettings, useRuntimeDemo } from "./preview/settingsPreview";
import { type AppSettings, useAppSettings } from "./settings/appSettings";
import { ConversationWidthProvider, useConversationWidth } from "./settings/ConversationWidthContext";
import { SlidingTabs } from "./SlidingTabs";
import type { IconName } from "./icons";
import {
  ContextTab,
  FilesTab,
  InteractionTab,
  PermissionsTab,
  TasksTab,
} from "./settings/SettingsPanels";
import { AdvancedTab } from "./settings/UpdateSettings";
import { Runtime1830Rows, RuntimeUpgradeRows } from "./settings/ModelServicesSettings";
import type {
  ApprovalModeId,
  RuntimeDemoApi,
  RuntimeSettingsCtl,
  SettingsCtl,
} from "./settings/tabs";
import type {
  RuntimeSettingsReadModel,
  StudioCompactionSpeculation,
  StudioRuntimeSettingKey,
  StudioRuntimeSettingValue,
  StudioRuntimeSettingsActivation,
} from "@omp-studio/client-contract";
import { LocalSettings } from "./settings/LocalSettings";
import { Runtime1844Rows } from "./settings/Runtime1844Rows";
import { AppSelect } from "./AppSelect";
import { SettingsScopeProvider, useSettingsScope } from "./settings/SettingsScope";
import { UnsupportedSettings } from "./settings/UnsupportedSettings";
import { GUI_GROUPS, SETTINGS_CATALOG, SETTINGS_GROUPS, resolveSettingsGroup, type ActiveSettingsGroup } from "./settings/catalog";
import { GUI_SETTING_DEFINITIONS } from "@omp-studio/studio-protocol";
import { MemoryCredentialPane } from "./settings/MemoryCredentialPane";

import { takeSettingsIntent } from "./pageIntents";
export { SETTINGS_INTENT_KEY, setSettingsIntent, type SettingsGroupId } from "./pageIntents";

type GroupId = ActiveSettingsGroup;

/** Optional Runtime settings seam; App decides whether/how to persist writes. */
export interface RuntimeSettingsApi {
  readonly snapshot?: RuntimeSettingsReadModel;
  readonly activation?: StudioRuntimeSettingsActivation;
  readonly compactionSpeculation?: StudioCompactionSpeculation;
  readonly pendingKey?: StudioRuntimeSettingKey;
  readonly error?: string;
  readonly onSet?: (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist?: boolean) => void | Promise<void>;
}

/** Reuse the global provider; standalone settings surfaces keep a local demo boundary. */
export function SettingsPage(props: Parameters<typeof SettingsPageContent>[0]) {
  return <SettingsScopeProvider><ConversationWidthProvider><SettingsPageContent {...props} /></ConversationWidthProvider></SettingsScopeProvider>;
}

function SettingsPageContent({
  client,
  approvalMode,
  onSetApprovalMode,
  onForgetApprovals,
  runtimeSettings,
  nativeContext,
  onOpenWorktree,
  predictionSessionId,
  predictionAvailable = false,
  onDictationModels,
  onOpenModels,
  memoryTargetId = null,
}: {
  client?: import("@omp-studio/client-contract").StudioClient;
  /** 当前 Runtime 审批模式；undefined = 无 Runtime 快照。 */
  approvalMode?: ApprovalModeId;
  onSetApprovalMode: (mode: ApprovalModeId) => void;
  /** Clears remembered approvals in the active Runtime; omitted without a session. */
  onForgetApprovals?: () => Promise<void>;
  /** Optional Runtime settings read/write surface; omitted on older Runtime versions. */
  runtimeSettings?: RuntimeSettingsApi;
  nativeContext?: NativePreferencesContext | undefined;
  onOpenWorktree?: ((workspaceId: string) => Promise<void>) | undefined;
  predictionSessionId?: string | undefined;
  predictionAvailable?: boolean;
  onDictationModels?: (() => void) | undefined;
  onOpenModels?: ((tab: "providers" | "roles") => void) | undefined;
  memoryTargetId?: string | null | undefined;
}) {
  const { t, resolvedLanguage } = useI18n();
  const zh = resolvedLanguage === "zh";
  const groups: ReadonlyArray<readonly [GroupId, IconName, string]> = SETTINGS_GROUPS.map(([id, icon, cn, en]) => [id, icon, zh ? cn : en]);

  const [initialIntent] = useState(() => takeSettingsIntent());
  const [group, setGroup] = useState<GroupId>(() => initialIntent ? resolveSettingsGroup(initialIntent.group) : "general");
  const [visited, setVisited] = useState<ReadonlySet<GroupId>>(() => new Set([initialIntent ? resolveSettingsGroup(initialIntent.group) : "general"]));
  const [target, setTarget] = useState<string | undefined>(initialIntent?.setting ?? (initialIntent?.group === "background" ? "background" : undefined));
  const [query, setQuery] = useState("");
  const [inspectBackend, setInspectBackend] = useState<"mnemopi" | "hindsight" | undefined>();
  const [scope, setScope] = useSettingsScope();
  const [previewValues, setPreviewValues] = useState<Partial<RuntimeSettingsReadModel>>({});
  useEffect(() => { setInspectBackend(undefined); }, [previewValues["memory.backend"], runtimeSettings?.snapshot?.["memory.backend"]]);
  useEffect(() => { setVisited(current => current.has(group) ? current : new Set([...current, group])); }, [group]);
  const groupIndex = groups.findIndex(([id]) => id === group);
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(group, groupIndex >= 0 ? groupIndex : 0);
  const { preview, marks } = usePreviewMode();

  const real = useAppSettings();
  const conversationWidth = useConversationWidth();
  const previewApp = usePreviewAppSettings();
  const rawRuntimeDemo = useRuntimeDemo();
  const [flash, setFlash] = useState<string | null>(null);
  const [runtimePendingKey, setRuntimePendingKey] = useState<StudioRuntimeSettingKey | undefined>(undefined);
  const [runtimeWriteError, setRuntimeWriteError] = useState<string | undefined>(undefined);
  const [runtimeNotice, setRuntimeNotice] = useState<string | undefined>(undefined);
  const runtimeEpoch = useRef(0);

  useEffect(() => {
    runtimeEpoch.current++;
    setRuntimePendingKey(undefined);
    setRuntimeWriteError(undefined);
    setRuntimeNotice(undefined);
    return () => { runtimeEpoch.current++; };
  }, [nativeContext?.sessionId]);

  useEffect(() => {
    if (!runtimeNotice) return;
    const timer = window.setTimeout(() => setRuntimeNotice(undefined), 3000);
    return () => window.clearTimeout(timer);
  }, [runtimeNotice]);

  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const flashDemo = () => { if (marks) setFlash(t("settings.general.demoFlash")); };

  const demoRuntime: RuntimeDemoApi | undefined = preview
    ? {
      value: rawRuntimeDemo.value,
      setValue: (key, value) => {
        rawRuntimeDemo.setValue(key, value);
        flashDemo();
      },
      flag: rawRuntimeDemo.flag,
      toggle: (key) => {
        rawRuntimeDemo.toggle(key);
        flashDemo();
      },
    }
    : undefined;

  const setDemoRuntimeSetting = (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue): void => {
    if (!demoRuntime) return;
    if (key in GUI_SETTING_DEFINITIONS) setPreviewValues(current => ({ ...current, [key]: value }));
    if (typeof value === "boolean") {
      if (demoRuntime.flag(key) !== value) demoRuntime.toggle(key);
      else flashDemo();
      return;
    }
    demoRuntime.setValue(key, Array.isArray(value) ? value.join(",") : typeof value === "object" ? JSON.stringify(value) : String(value));
  };

  const setRealRuntimeSetting = async (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist?: boolean): Promise<void> => {
    const onSet = runtimeSettings?.onSet;
    if (!onSet) return;
    const epoch = runtimeEpoch.current;
    setRuntimeWriteError(undefined);
    setRuntimeNotice(undefined);
    setRuntimePendingKey(key);
    try {
      if (persist === undefined) await onSet(key, value);
      else await onSet(key, value, persist);
      if (runtimeEpoch.current === epoch) setRuntimeNotice(zh ? "设置已保存。" : "Setting saved.");
    } catch (error) {
      if (runtimeEpoch.current === epoch) setRuntimeWriteError(error instanceof Error && error.message.length > 0 ? error.message : t("settings.runtime.writeError"));
    } finally {
      if (runtimeEpoch.current === epoch) setRuntimePendingKey((current) => current === key ? undefined : current);
    }
  };

  const ctl: SettingsCtl = preview
    ? {
      preview: true,
      app: {
        ...previewApp.app,
        conversationWidthMode: conversationWidth.mode,
        conversationCustomWidth: conversationWidth.customWidth,
      },
      updateApp: (patch) => {
        previewApp.patch(patch);
        conversationWidth.update(patch);
        flashDemo();
      },
      resetApp: (keys) => {
        const patch: Partial<AppSettings> = {};
        for (const key of keys) {
          (patch as Record<string, unknown>)[key] = PREVIEW_APP_SETTINGS[key];
        }
        previewApp.patch(patch);
        conversationWidth.update(patch);
        flashDemo();
      },
      approvalMode: PREVIEW_APPROVAL_MODE,
      setApprovalMode: () => flashDemo(),
      forgetApprovals: async () => flashDemo(),
    }
    : {
      preview: false,
      app: real.settings,
      updateApp: real.update,
      resetApp: real.reset,
      approvalMode,
      setApprovalMode: onSetApprovalMode,
      ...(onForgetApprovals === undefined ? {} : { forgetApprovals: onForgetApprovals }),
    };

  let runtime: RuntimeSettingsCtl = { preview: false };
  if (preview) {
    runtime = {
      preview: true,
      compactionSpeculation: "armed",
      previewValues,
      set: (key, value) => setDemoRuntimeSetting(key, value),
    };
  } else {
    if (runtimeSettings?.snapshot !== undefined) runtime = { ...runtime, snapshot: runtimeSettings.snapshot };
    if (runtimeSettings?.activation !== undefined) runtime = { ...runtime, activation: runtimeSettings.activation };
    if (runtimeSettings?.compactionSpeculation !== undefined) runtime = { ...runtime, compactionSpeculation: runtimeSettings.compactionSpeculation };
    const pendingKey = runtimeSettings?.pendingKey ?? runtimePendingKey;
    if (pendingKey !== undefined) runtime = { ...runtime, pendingKey };
    const error = runtimeSettings?.error ?? runtimeWriteError;
    if (error !== undefined) runtime = { ...runtime, error };
    if (runtimeSettings?.onSet !== undefined) {
      runtime = { ...runtime, set: (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist?: boolean) => { void setRealRuntimeSetting(key, value, persist ?? (scope === "global")); } };
    }
  }

  const searchText = query.trim().toLocaleLowerCase();
  const results = searchText ? SETTINGS_CATALOG.filter(entry => [entry.zh, entry.en, entry.id, entry.keywords].some(value => value?.toLocaleLowerCase().includes(searchText)))
    .filter((entry, index, items) => items.findIndex(other => other.group === entry.group && other.zh === entry.zh && other.en === entry.en) === index) : [];

  useEffect(() => {
    if (!target || query.trim()) return;
    const entry = SETTINGS_CATALOG.find(item => item.id === target);
    if (!entry || entry.group !== group) return;
    let frame = 0;
    let attempts = 0;
    let element: HTMLElement | undefined;
    const find = () => {
      const panel = document.getElementById(`set-${group}`);
      const label = zh ? entry.targetZh : entry.targetEn;
      element = Array.from(panel?.querySelectorAll<HTMLElement>("[data-setting-label], h3, h4, summary") ?? [])
        .find(candidate => candidate.dataset.settingLabel === label || candidate.textContent?.trim().startsWith(label));
      if (element) {
        element.scrollIntoView?.({ block: "center", behavior: "smooth" });
        element.classList.add("settings-search-highlight");
        const control = element.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex='0']");
        if (control) control.focus({ preventScroll: true });
        else { element.tabIndex = -1; element.focus({ preventScroll: true }); }
      } else if (++attempts < 240) frame = requestAnimationFrame(find);
    };
    frame = requestAnimationFrame(find);
    const timer = window.setTimeout(() => { element?.classList.remove("settings-search-highlight"); setTarget(undefined); }, 4500);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); element?.classList.remove("settings-search-highlight"); };
  }, [target, group, query, zh, incoming]);

  const groupContent = (id: GroupId) => {
    const visible = group === id;
    switch (id) {
      case "general": return <><LocalSettings ctl={ctl} section="general" /><TimeTravelSettings client={client} visible={visible} /></>;
      case "appearance": return <><LocalSettings ctl={ctl} section="appearance" /><BackgroundSettingsPane ctl={ctl} visible={visible} onDemoAction={flashDemo} /></>;
      case "interaction": return <>
        <LocalSettings ctl={ctl} section="interaction" />
        <InteractionTab ctl={ctl} prediction={undefined} />
        <Runtime1844Rows runtime={runtime} names={GUI_GROUPS.interaction} title={zh ? "消息与回答" : "Messages and responses"} />
        {preview || nativeContext?.capabilities?.capabilities.some(item => item.id === "prediction.status" && item.grade !== "unavailable")
          ? <PredictionSettingsPane client={client} context={nativeContext} visible={visible} />
          : <><Runtime1844Rows runtime={runtime} names={["spelling.autocomplete"]} title={zh ? "预测输入" : "Input prediction"} />{predictionAvailable ? <PredictionSettings client={client} sessionId={predictionSessionId} available={predictionAvailable} /> : null}</>}
        <FeatureSettingsPane group="interaction" client={client} context={nativeContext} visible={visible} />
        <NativePreferencesPane client={client} context={nativeContext} visible={visible} groups={["titles"]} />
      </>;
      case "voice": return <><DictationSettingsPane client={client} context={nativeContext} visible={visible} {...(onDictationModels ? { onModels: onDictationModels } : {})} /><FeatureSettingsPane group="voice" client={client} context={nativeContext} visible={visible} /></>;
      case "context": return <><ContextTab demo={demoRuntime} runtime={runtime} /><Runtime1844Rows runtime={runtime} names={GUI_GROUPS.context} inspectBackend={inspectBackend} title={zh ? "压缩与记忆" : "Compaction and memory"} /><MemoryCredentialPane runtime={runtime} targetId={memoryTargetId} client={client} inspect={inspectBackend === "hindsight"} /><p className="settings-link-row"><button className="btn small outline" disabled={!onOpenModels} onClick={() => onOpenModels?.("roles")}>{zh ? "管理模型专属压缩阈值" : "Manage per-model compaction thresholds"}</button></p><FeatureSettingsPane group="context" excludeKeys={["retry.fallbackOn"]} client={client} context={nativeContext} visible={visible} /></>;
      case "files": return <><FileViewerSettings /><FilesTab demo={demoRuntime} runtime={runtime} /><Runtime1844Rows runtime={runtime} names={GUI_GROUPS.files} title={zh ? "编辑、诊断与 Shell" : "Editing, diagnostics and shell"} /><NativePreferencesPane client={client} context={nativeContext} visible={visible} groups={["tools"]} /></>;
      case "tasks": return <><TasksTab demo={demoRuntime} runtime={runtime} /><Runtime1844Rows runtime={runtime} names={GUI_GROUPS.tasks} title={zh ? "子任务与代理" : "Subagents and tasks"} /><SessionBudgetPane client={client} sessionId={nativeContext?.sessionId} available={nativeContext?.available === true} visible={visible} capabilities={nativeContext?.capabilities} /><FeatureSettingsPane group="tasks" excludeKeys={["bash.gitGuard"]} client={client} context={nativeContext} visible={visible} /><SessionWorktreesPane client={client} context={nativeContext} visible={visible} onOpenWorkspace={onOpenWorktree} /><NativePreferencesPane client={client} context={nativeContext} visible={visible} groups={["advisor"]} /><AdvisorConfigPane client={client} context={nativeContext} visible={visible} /></>;
      case "models": return <><div className="settings-link-row"><button className="btn small outline" disabled={!onOpenModels} onClick={() => onOpenModels?.("providers")}>{zh ? "管理 Provider" : "Manage providers"}</button><button className="btn small outline" disabled={!onOpenModels} onClick={() => onOpenModels?.("roles")}>{zh ? "管理模型角色" : "Manage model roles"}</button></div><Runtime1844Rows runtime={runtime} names={GUI_GROUPS.models} title={zh ? "模型服务与重试" : "Model services and retries"} /><Runtime1830Rows runtime={runtime} demo={demoRuntime} /><RuntimeUpgradeRows runtime={runtime} demo={demoRuntime} /><FeatureSettingsPane group="models" client={client} context={nativeContext} visible={visible} /><FeatureSettingsPane group="context" keys={["retry.fallbackOn"]} client={client} context={nativeContext} visible={visible} /></>;
      case "permissions": return <><PermissionsTab ctl={ctl} /><FeatureSettingsPane group="permissions" client={client} context={nativeContext} visible={visible} /><FeatureSettingsPane group="tasks" keys={["bash.gitGuard"]} client={client} context={nativeContext} visible={visible} /></>;
      case "maintenance": return <><OfficeComponentSettings /><LocalSettings ctl={ctl} section="maintenance" /><AdvancedTab demo={demoRuntime} runtime={runtime} /><FeatureSettingsPane group="experimental" client={client} context={nativeContext} visible={visible} /><FeatureSettingsPane group="maintenance" client={client} context={nativeContext} visible={visible} /><ArtifactStorageSettings client={client} /><NativePreferencesPane client={client} context={nativeContext} visible={visible} groups={["diagnostics"]} /></>;
      case "unsupported": return <UnsupportedSettings />;
    }
  };

  return (
    <div className="page-wide set-layout">
      <aside className="settings-sidebar">
        <label className="settings-search-label" htmlFor="settings-search">{zh ? "搜索设置" : "Search settings"}</label>
        <input id="settings-search" className="input settings-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={zh ? "名称或配置键" : "Name or key"} />
        <SlidingTabs id="setSide" ariaLabel={t("settings.title")} value={group} onChange={next => { setGroup(next); setQuery(""); setTarget(undefined); setInspectBackend(undefined); }}
          items={groups.map(([id, icon, label]) => ({ id, icon, label, buttonId: `setTab-${id}`, panelId: `set-${id}` }))} />
      </aside>
      <div className="cap-main" id="setMain">
        {flash ? <div className="set-flash" role="status">{flash}</div> : null}
        {runtimeNotice ? <div className="set-flash" role="status">{runtimeNotice}</div> : null}
        {searchText ? <div className="settings-search-results" role="region" aria-label={zh ? "搜索结果" : "Search results"}>
          <h3>{zh ? "搜索结果" : "Search results"}</h3>
          <p className="desc" role="status">{results.length ? (zh ? `找到 ${results.length} 项` : `${results.length} results`) : (zh ? "没有找到匹配的设置。" : "No matching settings.")}</p>
          {results.map(entry => <button type="button" className="settings-search-result" key={entry.id} onClick={() => { setInspectBackend(entry.id.startsWith("hindsight.") ? "hindsight" : entry.id.startsWith("mnemopi.") ? "mnemopi" : undefined); setGroup(entry.group); setQuery(""); setTarget(entry.id); }}>
            <span>{zh ? entry.zh : entry.en}</span><small>{groups.find(([id]) => id === entry.group)?.[2]}</small>
          </button>)}
        </div> : null}
        <div className="cap-pane-stage" ref={stageRef} hidden={!!searchText}>
          {groups.filter(([id]) => visited.has(id) || id === incoming || id === outgoing).map(([id,, label]) =>
            <div className={`set-group ${tabPaneClass(tabPaneRole(id, incoming, outgoing, live), dir)}`} data-tab-pane={id}
              hidden={id !== incoming && id !== outgoing} inert={id === outgoing ? true : undefined}
              id={`set-${id}`} key={id} role="tabpanel" aria-labelledby={`setTab-${id}`} tabIndex={0}>
              {id !== "unsupported" ? <><h3>{label}{preview && marks ? <span className="chip amber xs demo-chip">{t("common.demo")}</span> : null}</h3>
                <p className="desc">{zh ? "本机外观和应用偏好保存在此设备；运行设置可选择用户配置或当前会话。" : "Appearance and app preferences are stored on this device; Runtime settings can target user configuration or the current session."}</p></> : null}
              {id !== "general" && id !== "appearance" && id !== "unsupported" ? <label className="settings-scope small muted">{zh ? "运行设置保存到" : "Save Runtime settings to"}<AppSelect className="select" aria-label={zh ? "运行设置保存范围" : "Runtime setting scope"} value={scope} onChange={event => setScope(event.target.value as "global" | "session")}><option value="global">{zh ? "用户配置" : "User configuration"}</option><option value="session">{zh ? "仅当前会话" : "Current session only"}</option></AppSelect></label> : null}
              {groupContent(id)}
            </div>)}
        </div>
      </div>
    </div>
  );
}
import { PredictionSettings } from "./settings/PredictionSettings";
import { AdvisorConfigPane } from "./settings/AdvisorConfigPane";
import { SessionBudgetPane } from "./models/SessionBudgetPane";
