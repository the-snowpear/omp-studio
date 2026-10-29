import type { PanelDefinition } from "../dock/types";

export const WORKBENCH_PANELS: readonly PanelDefinition[] = [
  { id: "files", title: "Files", icon: "folder" },
  { id: "changes", title: "Changes", icon: "diff" },
  { id: "git", title: "Git", icon: "branch" },
  { id: "browser", title: "Browser", icon: "globe", initialHeight: 320 },
  { id: "computer", title: "Computer", icon: "monitor", initialHeight: 320 },
  { id: "agents", title: "Agents", icon: "bot" },
  { id: "terminal", title: "Terminal", icon: "terminal", minHeight: 240, initialHeight: 280 },
  { id: "problems", title: "Problems", icon: "alert-c" },
  { id: "tests", title: "Tests", icon: "test" },
  { id: "output", title: "Output", icon: "console" },
  { id: "logs", title: "OMP Logs", icon: "book" },
  { id: "pvlogs", title: "Preview Logs", icon: "globe" },
  { id: "btw", title: "BTW", icon: "sparkles", initialHeight: 360 },
];
