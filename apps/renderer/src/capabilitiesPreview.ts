/**
 * Preview-only MCP / Slash catalog, ported from
 * ui_reference/ver1/assets/js/mock-data.js. Used by the capabilities page
 * until Host exposes matching read models (Slash) or for MCP demo stories.
 */

export type McpStatus = "connected" | "reconnecting" | "disabled" | "error";

export type PreviewMcp = {
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

export function createPreviewMcp(): PreviewMcp[] {
  return [
    { name: "filesystem", transport: "stdio", status: "connected", tools: 12, resources: 0, prompts: 0, last: "2m ago" },
    { name: "github", transport: "http · :38412", status: "connected", tools: 26, resources: 4, prompts: 2, last: "38s ago" },
    { name: "playwright", transport: "stdio", status: "reconnecting", tools: 18, resources: 0, prompts: 0, last: "失败 3 次" },
    { name: "sqlite-sessions", transport: "stdio", status: "disabled", tools: 7, resources: 2, prompts: 0, last: "—" },
  ];
}

export function createPreviewSlashCommands(): PreviewSlash[] {
  return [
    { name: "/compact", desc: "立即压缩当前会话上下文", src: "内置", args: "[focus?]", ok: true },
    { name: "/review", desc: "对当前 Changes 发起代码审查", src: "内置", args: "[path?]", ok: true },
    { name: "/test", desc: "运行测试并汇总失败详情", src: "内置", args: "[suite?]", ok: true },
    { name: "/upstream-sync", desc: "执行上游同步流程", src: "Skill", args: "<tag>", ok: true },
    { name: "/graph", desc: "生成代码审查依赖图", src: "Skill", args: "[entry?]", ok: true },
    { name: "/worktree-new", desc: "在新 Worktree 中开始对话", src: "Plugin", args: "<branch>", ok: true },
    { name: "/handoff", desc: "将会话交接给新 Thread", src: "内置", args: "", ok: true },
    { name: "/doctor", desc: "打开诊断中心", src: "内置", args: "", ok: true },
  ];
}
