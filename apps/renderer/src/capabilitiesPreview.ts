/**
 * Preview-only MCP / Slash catalog, ported from
 * ui_reference/ver1/assets/js/mock-data.js. Used by the capabilities page
 * until Host exposes matching read models (Slash) or for MCP demo stories.
 */

export type McpStatus = "connected" | "reconnecting" | "disabled" | "error";

import { isZh } from "./i18n";

export type PreviewMcp = {
  instructions?: boolean;
  name: string;
  transport: string;
  status: McpStatus;
  tools: number;
  resources: number;
  prompts: number;
  last: string;
};

export type PreviewSlash = {
  name: string;
  desc: string;
  src: string;
  args: string;
  ok: boolean;
};

export function createPreviewMcp(zh = isZh()): PreviewMcp[] {
  return [
    { name: "filesystem", transport: "stdio", status: "connected", tools: 12, resources: 0, prompts: 0, last: "2m ago" },
    { name: "github", transport: "http · :38412", status: "connected", tools: 26, resources: 4, prompts: 2, last: "38s ago" },
    { name: "playwright", transport: "stdio", status: "reconnecting", tools: 18, resources: 0, prompts: 0, last: zh ? "失败 3 次" : "3 failures" },
    { name: "sqlite-sessions", transport: "stdio", status: "disabled", tools: 7, resources: 2, prompts: 0, last: "—" },
  ];
}

export function createPreviewSlashCommands(zh = isZh()): PreviewSlash[] {
  const builtin = zh ? "内置" : "Built-in";
  return [
    { name: "/compact", desc: zh ? "立即压缩当前会话上下文" : "Compact the current session context now", src: builtin, args: "[focus?]", ok: true },
    { name: "/review", desc: zh ? "对当前 Changes 发起代码审查" : "Start a code review on current Changes", src: builtin, args: "[path?]", ok: true },
    { name: "/test", desc: zh ? "运行测试并汇总失败详情" : "Run tests and summarize failure details", src: builtin, args: "[suite?]", ok: true },
    { name: "/upstream-sync", desc: zh ? "执行上游同步流程" : "Run the upstream sync workflow", src: "Skill", args: "<tag>", ok: true },
    { name: "/graph", desc: zh ? "生成代码审查依赖图" : "Generate a code review dependency graph", src: "Skill", args: "[entry?]", ok: true },
    { name: "/worktree-new", desc: zh ? "在新 Worktree 中开始对话" : "Start a conversation in a new worktree", src: "Plugin", args: "<branch>", ok: true },
    { name: "/handoff", desc: zh ? "将会话交接给新 Thread" : "Hand off the session to a new thread", src: builtin, args: "", ok: true },
    { name: "/doctor", desc: zh ? "打开诊断中心" : "Open Diagnostics", src: builtin, args: "", ok: true },
  ];
}
