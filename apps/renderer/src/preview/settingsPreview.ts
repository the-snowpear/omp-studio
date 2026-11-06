/**
 * 设置页预览 fixtures（Phase 1）。
 *
 * 预览模式下设置页读这里：App 级设置演示值 + Runtime 设置的
 * 演示状态。演示控件只改本地 UI 状态，不写 appSettings 存储、不调
 * Host、不伪造 Studio Bridge 能力。真实模式不 import 本模块的运行态。
 */

import { useCallback, useState } from "react";

import { getAppSettings, type AppSettings } from "../settings/appSettings";
import type { RuntimeDemoApi } from "../settings/tabs";
import type { UpdatePrefs } from "../settings/updates";

export const PREVIEW_UPDATE_PREFS: UpdatePrefs = {
  mirrorPrefix: "",
  autoCheck: true,
  autoDownload: true,
  skippedAppVersion: "",
  runtimeChannel: "stable",
  preferHotUpdate: true,
  lastIndexSequence: 0,
};

/** App 级设置的演示值（预览模式显示，不落盘）。 */
export const PREVIEW_APP_SETTINGS: AppSettings = {
  language: "system",
  theme: "dark",
  density: "compact",
  agentRosterDensity: "standard",
  fileTypePalette: "cat",
  conversationWidthMode: "standard",
  conversationCustomWidth: 1024,
  uiFontFamily: "",
  uiFontSize: 14,
  terminalFontFamily: "Cascadia Code",
  terminalFontSize: 13,
  outputFontFamily: "",
  outputFontSize: 15,
  streaming: true,
  streamingCadenceHz: 60,
  toolActivity: "full",
  restoreLastProject: true,
  restoreLastSession: true,
  startupPage: "last",
  rememberLayout: true,
  perProjectLayout: true,
  notifyTaskDone: true,
  notifyErrors: true,
  notifyConfirmations: true,
  notifyLongTasks: true,
  dictationDeviceId: "",
  dictationToggleShortcut: "",
  showThinkingSummary: true,
  showToolIntent: true,
  showTokenUsage: false,
};

/** Demo catalog only; never presented as an inventory of the user's system. */
export const PREVIEW_FONT_FAMILIES = ["Cascadia Code", "Consolas", "JetBrains Mono", "Microsoft YaHei", "PingFang SC", "Segoe UI"];

/**
 * Runtime 级「尚未接入」行的演示初值，键与 settings/tabs.tsx 中
 * FutureRowDef.key 一一对应；缺省回落到行定义里的静态 value/on。
 */
export const PREVIEW_RUNTIME_SETTINGS: Readonly<Record<string, string | boolean>> = {
  "modelRoles.judge": "typesafe/jev-latest",
  "claudeResets.autoRedeem": "unset",
  "claudeResets.minBlockedMinutes": "60",
  "claudeResets.keepCredits": "0",
  "claudeResets.salvageHorizonHours": "12",
  "mcp.startupTimeoutMs": "250",
  "ttsr.judge": "auto",
  "edit.autoRepair.enabled": false,
  "features.unexpectedStopDetection": "mechanical",
  "providers.unexpectedStopModel": "online",
  extendedContext: true,
  "compaction.asyncEnabled": true,
  "compaction.methodOrder": "remote,snapcompact,handoff,shake,soft",
  "providers.openai-codex.codeMode": "off",
  "plan.autosave": true,
  "plan.autosaveDir": ".omp/plans/",
  "retry.waitForUsageReset": false,
  "compaction.experimentalContextManagement": false,
  "task.enableEffort": false,
  "task.maxEffort": "max",
  "task.agentServiceTierOverrides": JSON.stringify({ explore: "inherit" }),
  "providers.autoThinkingMaxEffort": "xhigh",
  "providers.judgmentProvider": "auto",
  "images.describeForTextModels": true,
  "images.questionTimeoutMs": "300000",
  "tools.speculativeExecution.enabled": false,

};

/** 预览模式的审批模式演示值。 */
export const PREVIEW_APPROVAL_MODE = "write" as const;

/** App 级设置的演示状态：只改本地，不写 appSettings 存储。 */
export function usePreviewAppSettings(): {
  app: AppSettings;
  patch: (next: Partial<AppSettings>) => void;
} {
  const [app, setApp] = useState<AppSettings>(() => {
    const appearance = getAppSettings();
    return { ...PREVIEW_APP_SETTINGS, theme: appearance.theme, density: appearance.density, language: appearance.language };
  });
  const patch = useCallback((next: Partial<AppSettings>) => {
    setApp((previous) => ({ ...previous, ...next }));
  }, []);
  return { app, patch };
}

/** Runtime 设置的演示读写面。 */
export function useRuntimeDemo(): RuntimeDemoApi {
  const [state, setState] = useState<Record<string, string | boolean>>({ ...PREVIEW_RUNTIME_SETTINGS });
  const value = useCallback((key: string): string => {
    const current = state[key];
    return typeof current === "string" ? current : "";
  }, [state]);
  const setValue = useCallback((key: string, next: string) => {
    setState((previous) => ({ ...previous, [key]: next }));
  }, []);
  const flag = useCallback((key: string): boolean => {
    const current = state[key];
    return typeof current === "boolean" ? current : current !== undefined;
  }, [state]);
  const toggle = useCallback((key: string) => {
    setState((previous) => ({ ...previous, [key]: !(typeof previous[key] === "boolean" ? previous[key] : previous[key] !== undefined) }));
  }, []);
  return { value, setValue, flag, toggle };
}
