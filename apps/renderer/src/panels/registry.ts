import type { PanelDefinition } from "../dock/types";

const PANEL_ZH_LABELS: Record<string, { title?: string; menuTitle?: string }> = {
  "file-browser": { title: "文件浏览器", menuTitle: "文件浏览器 · File Browser" },
  "git-quick": { menuTitle: "Git 快捷卡" },
  commit: { title: "提交", menuTitle: "选择性提交" },
  computer: { menuTitle: "电脑 · Computer" },
  jobs: { menuTitle: "后台任务 · Background tasks" },
  "agent-detail": { title: "子 Agent" },
  "context-viewer": { title: "上下文查看器" },
  annotations: { title: "标注" },
  "token-counter": { title: "Token 计数", menuTitle: "离线 Token 计数" },
};

export function localizePanelDefinition(definition: PanelDefinition, zh: boolean): PanelDefinition {
  if (!zh) return definition;
  const labels = PANEL_ZH_LABELS[definition.id];
  return labels ? { ...definition, ...labels } : definition;
}

export const WORKBENCH_PANELS: readonly PanelDefinition[] = [
  { id: "files", title: "Explorer", icon: "file-tree" },
  { id: "file-browser", title: "File Browser", icon: "drive", minHeight: 260, initialHeight: 420 },
  { id: "changes", title: "Changes", icon: "diff", meter: true },
  { id: "git", title: "Git", icon: "branch", meter: true },
  { id: "git-quick", title: "Git", menuTitle: "Git Quick Card", icon: "branch", initialHeight: 320, meter: true },
  { id: "commit", title: "Commit", menuTitle: "Selective Commit", icon: "commit", minHeight: 280, initialHeight: 520 },
  { id: "browser", title: "Browser", icon: "globe", initialHeight: 320 },
  { id: "computer", title: "Computer", icon: "monitor", minHeight: 180, initialHeight: 440 },
  { id: "jobs", title: "Background tasks", icon: "terminal", meter: true, initialHeight: 256 },
  { id: "agents", title: "Agents", icon: "bot", meter: true },
  { id: "agent-detail", title: "Subagent", icon: "message", initialHeight: 480 },
  { id: "environment", title: "Environment", icon: "cpu" },
  { id: "context", title: "Context", icon: "layers", meter: true, initialHeight: 320 },
  { id: "context-viewer", title: "Context Inspector", icon: "layers", minHeight: 260, initialHeight: 500 },
  { id: "annotations", title: "Annotations", icon: "pencil", minHeight: 380, initialHeight: 500 },
  { id: "token-counter", title: "Token Counter", menuTitle: "Offline Token Counter", icon: "code", minHeight: 260, initialHeight: 420 },
  { id: "terminal", title: "Terminal", icon: "terminal", minHeight: 240, initialHeight: 280 },
  { id: "problems", title: "Problems", icon: "alert-c" },
  { id: "tests", title: "Tests", icon: "test" },
  { id: "output", title: "Output", icon: "console" },
  { id: "logs", title: "OMP Logs", icon: "book" },
  { id: "pvlogs", title: "Preview Logs", icon: "globe" },
  { id: "btw", title: "BTW", icon: "sparkles", initialHeight: 360 },
];
