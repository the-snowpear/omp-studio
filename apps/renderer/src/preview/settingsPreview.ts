/**
 * 设置页预览 fixtures（Phase 1）。
 *
 * 预览模式下设置页读这里：App 级设置演示值 + 「尚未接入」Runtime 行的
 * 演示状态。演示控件只改本地 UI 状态，不写 appSettings 存储、不调
 * Host、不伪造 Studio Bridge 能力。真实模式不 import 本模块的运行态。
 */

import { useCallback, useState } from "react";

import type { AppSettings } from "../settings/appSettings";
import type { RuntimeDemoApi } from "../settings/tabs";

/** App 级设置的演示值（预览模式显示，不落盘）。 */
export const PREVIEW_APP_SETTINGS: AppSettings = {
  language: "system",
  theme: "dark",
  density: "compact",
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
  showThinkingSummary: true,
  showToolIntent: true,
  showTokenUsage: false,
};

/**
 * Runtime 级「尚未接入」行的演示初值，键与 settings/tabs.tsx 中
 * FutureRowDef.key 一一对应；缺省回落到行定义里的静态 value/on。
 */
export const PREVIEW_RUNTIME_SETTINGS: Readonly<Record<string, string | boolean>> = {
  "edit.autoRepair.enabled": false,
  "features.unexpectedStopDetection": "mechanical",
  "providers.unexpectedStopModel": "online",
  extendedContext: true,
  "compaction.asyncEnabled": true,
  "compaction.methodOrder": "remote,snapcompact,handoff,shake,soft",
  "providers.openai-codex.codeMode": "off",
  "input.steering": "一次处理一条",
  "input.followup": "一次处理全部",
  "input.interrupt": "立即中断",
  "input.paste": "自动转文件",
  "input.autocomplete": "8 条",
  "input.emoji": true,
  "reply.style": "Pragmatic",
  "reply.detail": "Concise",
  "tool.fileRead": "允许",
  "tool.fileWrite": "允许",
  "tool.outside": "询问",
  "tool.bash": "允许",
  "tool.network": "询问",
  "tool.browser": "询问",
  "tool.computer": "禁止",
  "tool.github": "询问",
  "tool.fetch": "允许",
  "tool.mcp": "询问",
  "security.outside": "每次询问",
  "security.bashRules": "默认规则集",
  "compact.auto": true,
  "compact.strategy": "Snapcompact",
  "compact.threshold": "80%",
  "compact.midTurn": false,
  "compact.idle": true,
  "compact.promote": false,
  "compact.pruneReads": true,
  "workspace.extraDirs": "已配置 2 个目录",
  "workspace.tree": true,
  "workspace.restore": true,
  "memory.backend": "Hindsight",
  "memory.recall": true,
  "memory.retain": true,
  "memory.injectLimit": "8 条",
  "memory.debug": false,
  "edit.mode": "Hashline",
  "edit.fuzzy": true,
  "edit.fuzzyThreshold": "默认",
  "edit.guardGenerated": true,
  "edit.seenLine": true,
  "read.lineNumbers": true,
  "read.limit": "2000 行",
  "read.summary": true,
  "read.markdown": "渲染",
  "read.previewLength": "标准",
  "lsp.enabled": true,
  "lsp.lazy": true,
  "lsp.shared": true,
  "lsp.formatOnWrite": false,
  "lsp.diagOnWrite": true,
  "lsp.diagOnEdit": true,
  "shell.enabled": true,
  "shell.longCommand": true,
  "shell.direnv": true,
  "shell.minimizer": true,
  "shell.runtimes": "自动检测",
  "plan.enabled": true,
  "plan.default": true,
  "goal.enabled": true,
  "goal.status": true,
  "goal.autoplay": "自动继续",
  "loop.mode": "Compact",
  "exec.async": true,
  "exec.toolTimeout": "10 分钟",
  "exec.maxConcurrency": "4",
  "exec.polling": "自适应",
  "task.maxConcurrency": "8",
  "task.maxDepth": "3",
  "task.maxRuntime": "30 分钟",
  "task.budget": "默认",
  "task.preferDelegate": true,
  "task.isolation": "共享工作区",
  "task.merge": "Patch",
  "advanced.retry": "指数退避",
  "advanced.retryCount": "3",
  "advanced.loopGuard": true,
  "advanced.repeatThreshold": "10",
};

/** 预览模式的审批模式演示值。 */
export const PREVIEW_APPROVAL_MODE = "write" as const;

/** App 级设置的演示状态：只改本地，不写 appSettings 存储。 */
export function usePreviewAppSettings(): {
  app: AppSettings;
  patch: (next: Partial<AppSettings>) => void;
} {
  const [app, setApp] = useState<AppSettings>(PREVIEW_APP_SETTINGS);
  const patch = useCallback((next: Partial<AppSettings>) => {
    setApp((previous) => ({ ...previous, ...next }));
  }, []);
  return { app, patch };
}

/** Runtime「尚未接入」行的演示读写面。 */
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
