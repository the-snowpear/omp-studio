/**
 * Preview-only MCP / Host Tools / Slash catalog, ported from
 * ui_reference/ver1/assets/js/mock-data.js. Used by the capabilities page
 * until Host exposes matching read models.
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

export type PreviewHostTool = {
  name: string;
  desc: string;
  registered: boolean;
  calls: number;
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

export function createPreviewHostTools(): PreviewHostTool[] {
  return [
    { name: "preview.open", desc: "打开 / 刷新 Preview 页面", registered: true, calls: 142 },
    { name: "preview.screenshot", desc: "Preview 页面截图", registered: true, calls: 56 },
    { name: "preview.dom", desc: "读取 Preview DOM 摘要", registered: true, calls: 23 },
    { name: "editor.openExternal", desc: "在外部编辑器打开文件", registered: true, calls: 31 },
    { name: "system.reveal", desc: "在系统文件管理器中显示", registered: true, calls: 18 },
    { name: "browser.controlled", desc: "受控浏览器页面操作", registered: false, calls: 0 },
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
