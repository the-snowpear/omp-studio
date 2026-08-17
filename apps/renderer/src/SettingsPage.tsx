/**
 * 设置页（Phase 1 IA 重构）：7 个标签的壳。
 *
 * 职责原则：设置页只负责「改变全局行为」，不管理对象——模型 / Provider /
 * 角色 / Fallback 在模型配置页，能力启停在能力中心，子代理定义在模型配置
 * · 子代理，会话管理在历史页，Runtime / Bridge / 日志在诊断页。
 *
 * 数据面：真实模式读 appSettings 本地存储 + 审批模式（Host 快照）；
 * 预览模式读 preview/settingsPreview 演示值，演示控件只改本地 UI 状态。
 */

import { useEffect, useState } from "react";
import { tabPaneClass, tabPaneRole, useOverlappingTabs } from "./pageTransition";
import { usePreviewMode } from "./preview/PreviewContext";
import { PREVIEW_APPROVAL_MODE, usePreviewAppSettings, useRuntimeDemo } from "./preview/settingsPreview";
import { useAppSettings } from "./settings/appSettings";
import { SlidingTabs } from "./SlidingTabs";
import { AdvancedTab, ContextTab, FilesTab, GeneralTab, InteractionTab, PermissionsTab, TasksTab, type ApprovalModeId, type RuntimeDemoApi, type SettingsCtl } from "./settings/tabs";

export const SETTINGS_INTENT_KEY = "omp.settingsIntent";

export type SettingsGroupId = "general" | "interaction" | "permissions" | "context" | "files" | "tasks" | "advanced";

type GroupId = SettingsGroupId;

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

const GROUPS: ReadonlyArray<readonly [GroupId, string, string]> = [
  ["general", "settings", "常规"],
  ["interaction", "message", "对话与交互"],
  ["permissions", "shield", "权限与安全"],
  ["context", "layers", "上下文与记忆"],
  ["files", "terminal", "文件与终端"],
  ["tasks", "play", "任务与执行"],
  ["advanced", "wrench", "高级"],
];

export function SettingsPage({
  approvalMode,
  onSetApprovalMode,
}: {
  /** 当前 Runtime 审批模式；undefined = 无 Runtime 快照。 */
  approvalMode?: ApprovalModeId;
  onSetApprovalMode: (mode: ApprovalModeId) => void;
}) {
  const [group, setGroup] = useState<GroupId>(() => takeSettingsIntent() ?? "general");
  const groupIndex = GROUPS.findIndex(([id]) => id === group);
  const { incoming, outgoing, dir, live, stageRef } = useOverlappingTabs(group, groupIndex);
  const { preview } = usePreviewMode();

  const real = useAppSettings();
  const previewApp = usePreviewAppSettings();
  const rawRuntimeDemo = useRuntimeDemo();
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    if (flash === null) return;
    const timer = window.setTimeout(() => setFlash(null), 2400);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const flashDemo = () => setFlash("演示：仅改动预览状态，未写入设置存储与 Host");

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

  const ctl: SettingsCtl = preview
    ? {
      preview: true,
      app: previewApp.app,
      updateApp: (patch) => {
        previewApp.patch(patch);
        flashDemo();
      },
      resetApp: () => flashDemo(),
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
        ariaLabel="设置分组"
        value={group}
        onChange={setGroup}
        items={GROUPS.map(([id, icon, label]) => ({
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
            <ContextTab demo={demoRuntime} />
          </div>
          <div {...pane("files")} id="set-files" role="tabpanel" aria-labelledby="setTab-files" tabIndex={0}>
            <FilesTab demo={demoRuntime} />
          </div>
          <div {...pane("tasks")} id="set-tasks" role="tabpanel" aria-labelledby="setTab-tasks" tabIndex={0}>
            <TasksTab demo={demoRuntime} />
          </div>
          <div {...pane("advanced")} id="set-advanced" role="tabpanel" aria-labelledby="setTab-advanced" tabIndex={0}>
            <AdvancedTab demo={demoRuntime} />
          </div>
        </div>
      </div>
    </div>
  );
}
