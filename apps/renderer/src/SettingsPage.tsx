/**
 * 设置页（Phase 1 IA 重构）：7 个标签的壳。
 *
 * 职责原则：设置页只负责「改变全局行为」，不管理对象——模型 / Provider /
 * 角色 / Fallback 在模型配置页，能力启停在能力中心，子代理定义在模型配置
 * · 子代理，会话管理在历史页，Runtime / Bridge / 日志在诊断页。
 *
 * 数据面：真实模式读 appSettings 本地存储 + 审批模式（Host 快照），并可选接收
 * Runtime settings snapshot；预览模式读 preview/settingsPreview 演示值，演示控件只改本地 UI 状态。
 */

import { useEffect, useState } from "react";
import { tabPaneClass, tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { useI18n } from "./i18n";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_APP_SETTINGS, PREVIEW_APPROVAL_MODE, usePreviewAppSettings, useRuntimeDemo } from "./preview/settingsPreview";
import { type AppSettings, useAppSettings } from "./settings/appSettings";
import { SlidingTabs } from "./SlidingTabs";
import {
  AdvancedTab,
  ContextTab,
  FilesTab,
  GeneralTab,
  InteractionTab,
  PermissionsTab,
  TasksTab,
  type ApprovalModeId,
  type RuntimeDemoApi,
  type RuntimeSettingsCtl,
  type SettingsCtl,
} from "./settings/tabs";
import type {
  RuntimeSettingsReadModel,
  StudioCompactionSpeculation,
  StudioRuntimeSettingKey,
  StudioRuntimeSettingValue,
} from "@omp-studio/client-contract";

export const SETTINGS_INTENT_KEY = "omp.settingsIntent";

export type SettingsGroupId = "general" | "interaction" | "permissions" | "context" | "files" | "tasks" | "advanced";

type GroupId = SettingsGroupId;

/** Optional Runtime settings seam; App decides whether/how to persist writes. */
export interface RuntimeSettingsApi {
  readonly snapshot?: RuntimeSettingsReadModel;
  readonly compactionSpeculation?: StudioCompactionSpeculation;
  readonly pendingKey?: StudioRuntimeSettingKey;
  readonly error?: string;
  readonly onSet?: (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue) => void | Promise<void>;
}

const GROUP_IDS: ReadonlyArray<SettingsGroupId> = ["general", "interaction", "permissions", "context", "files", "tasks", "advanced"];

export function setSettingsIntent(group: SettingsGroupId): void {
  try {
    sessionStorage.setItem(SETTINGS_INTENT_KEY, JSON.stringify({ group }));
  } catch {
    /* sessionStorage may be blocked; navigation still opens the page. */
  }
}

function takeSettingsIntent(): SettingsGroupId | null {
  try {
    const raw = sessionStorage.getItem(SETTINGS_INTENT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SETTINGS_INTENT_KEY);
    const value = JSON.parse(raw) as { group?: unknown };
    return GROUP_IDS.some((id) => id === value.group) ? value.group as SettingsGroupId : null;
  } catch {
    return null;
  }
}

export function SettingsPage({
  approvalMode,
  onSetApprovalMode,
  runtimeSettings,
}: {
  /** 当前 Runtime 审批模式；undefined = 无 Runtime 快照。 */
  approvalMode?: ApprovalModeId;
  onSetApprovalMode: (mode: ApprovalModeId) => void;
  /** Optional Runtime settings read/write surface; omitted on older Runtime versions. */
  runtimeSettings?: RuntimeSettingsApi;
}) {
  const { t } = useI18n();
  const groups: ReadonlyArray<readonly [GroupId, string, string]> = [
    ["general", "settings", t("settings.tabs.general")],
    ["interaction", "message", t("settings.tabs.interaction")],
    ["permissions", "shield", t("settings.tabs.permissions")],
    ["context", "layers", t("settings.tabs.context")],
    ["files", "terminal", t("settings.tabs.files")],
    ["tasks", "play", t("settings.tabs.tasks")],
    ["advanced", "wrench", t("settings.tabs.advanced")],
  ];

  const [group, setGroup] = useState<GroupId>(() => takeSettingsIntent() ?? "general");
  const groupIndex = groups.findIndex(([id]) => id === group);
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(group, groupIndex >= 0 ? groupIndex : 0);
  const { preview } = usePreviewMode();

  const real = useAppSettings();
  const previewApp = usePreviewAppSettings();
  const rawRuntimeDemo = useRuntimeDemo();
  const [flash, setFlash] = useState<string | null>(null);
  const [runtimePendingKey, setRuntimePendingKey] = useState<StudioRuntimeSettingKey | undefined>(undefined);
  const [runtimeWriteError, setRuntimeWriteError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const flashDemo = () => setFlash(t("settings.general.demoFlash"));

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
    if (typeof value === "boolean") {
      if (demoRuntime.flag(key) !== value) demoRuntime.toggle(key);
      else flashDemo();
      return;
    }
    demoRuntime.setValue(key, Array.isArray(value) ? value.join(",") : String(value));
  };

  const setRealRuntimeSetting = async (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue): Promise<void> => {
    const onSet = runtimeSettings?.onSet;
    if (!onSet) return;
    setRuntimeWriteError(undefined);
    setRuntimePendingKey(key);
    try {
      await onSet(key, value);
    } catch (error) {
      setRuntimeWriteError(error instanceof Error && error.message.length > 0 ? error.message : t("settings.runtime.writeError"));
    } finally {
      setRuntimePendingKey((current) => current === key ? undefined : current);
    }
  };

  const ctl: SettingsCtl = preview
    ? {
      preview: true,
      app: previewApp.app,
      updateApp: (patch) => {
        previewApp.patch(patch);
        flashDemo();
      },
      resetApp: (keys) => {
        const patch: Partial<AppSettings> = {};
        for (const key of keys) {
          (patch as Record<string, unknown>)[key] = PREVIEW_APP_SETTINGS[key];
        }
        previewApp.patch(patch);
        flashDemo();
      },
      approvalMode: PREVIEW_APPROVAL_MODE,
      setApprovalMode: () => flashDemo(),
    }
    : {
      preview: false,
      app: real.settings,
      updateApp: real.update,
      resetApp: real.reset,
      approvalMode,
      setApprovalMode: onSetApprovalMode,
    };

  let runtime: RuntimeSettingsCtl = { preview: false };
  if (preview) {
    runtime = {
      preview: true,
      compactionSpeculation: "armed",
      set: setDemoRuntimeSetting,
    };
  } else {
    if (runtimeSettings?.snapshot !== undefined) runtime = { ...runtime, snapshot: runtimeSettings.snapshot };
    if (runtimeSettings?.compactionSpeculation !== undefined) runtime = { ...runtime, compactionSpeculation: runtimeSettings.compactionSpeculation };
    const pendingKey = runtimeSettings?.pendingKey ?? runtimePendingKey;
    if (pendingKey !== undefined) runtime = { ...runtime, pendingKey };
    const error = runtimeSettings?.error ?? runtimeWriteError;
    if (error !== undefined) runtime = { ...runtime, error };
    if (runtimeSettings?.onSet !== undefined) {
      runtime = { ...runtime, set: (key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue) => { void setRealRuntimeSetting(key, value); } };
    }
  }

  const pane = (id: GroupId) => ({
    className: `set-group ${tabPaneClass(tabPaneRole(id, incoming, outgoing, live), dir)}`,
    hidden: id !== incoming && id !== outgoing,
    "data-tab-pane": id,
    inert: id === outgoing ? true : undefined,
  });

  return (
    <div className="page-wide set-layout">
      <SlidingTabs
        id="setSide"
        ariaLabel={t("settings.title")}
        value={group}
        onChange={setGroup}
        items={groups.map(([id, icon, label]) => ({
          id,
          icon,
          label,
          buttonId: `setTab-${id}`,
          panelId: `set-${id}`,
        }))}
      />

      <div className="cap-main" id="setMain">
        {flash ? <div className="set-flash" role="status">{flash}</div> : null}
        <div className="cap-pane-stage" ref={stageRef}>
          <div {...pane("general")} id="set-general" role="tabpanel" aria-labelledby="setTab-general" tabIndex={0}>
            <GeneralTab ctl={ctl} />
          </div>
          <div {...pane("interaction")} id="set-interaction" role="tabpanel" aria-labelledby="setTab-interaction" tabIndex={0}>
            <InteractionTab ctl={ctl} demo={demoRuntime} />
          </div>
          <div {...pane("permissions")} id="set-permissions" role="tabpanel" aria-labelledby="setTab-permissions" tabIndex={0}>
            <PermissionsTab ctl={ctl} demo={demoRuntime} />
          </div>
          <div {...pane("context")} id="set-context" role="tabpanel" aria-labelledby="setTab-context" tabIndex={0}>
            <ContextTab demo={demoRuntime} runtime={runtime} />
          </div>
          <div {...pane("files")} id="set-files" role="tabpanel" aria-labelledby="setTab-files" tabIndex={0}>
            <FilesTab demo={demoRuntime} runtime={runtime} />
          </div>
          <div {...pane("tasks")} id="set-tasks" role="tabpanel" aria-labelledby="setTab-tasks" tabIndex={0}>
            <TasksTab demo={demoRuntime} runtime={runtime} />
          </div>
          <div {...pane("advanced")} id="set-advanced" role="tabpanel" aria-labelledby="setTab-advanced" tabIndex={0}>
            <AdvancedTab demo={demoRuntime} runtime={runtime} />
          </div>
        </div>
      </div>
    </div>
  );
}
