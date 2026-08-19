import type { SessionHistoryEntry } from "@omp-studio/client-contract";
import type { CapTab } from "./CapabilitiesPage";
import type { PageRoute } from "./HomePage";
import type { McTab } from "./ModelConfigPage";
import { PREVIEW_HISTORY, PREVIEW_PROJECTS } from "./preview/fixtures";
import type { SettingsGroupId } from "./SettingsPage";
import type { DrawerItem } from "./skillsPreview";

export type SideTab = "changes" | "git" | "preview" | "agents" | "btw";
export type BottomTab = "terminal" | "problems" | "tests" | "output" | "logs" | "pvlogs";

export type PaletteAction =
  | { kind: "route"; route: PageRoute }
  | { kind: "diagnostics"; intent?: "check-update" | "reconnect" | "restart" }
  | { kind: "newChat" }
  | { kind: "pickProject" }
  | { kind: "selectThread"; entry: SessionHistoryEntry }
  | { kind: "previewThread"; threadId: string }
  | { kind: "selectProject"; id: string; name: string }
  | { kind: "previewProject"; id: string }
  | { kind: "toggleSidebar" }
  | { kind: "toggleBottom" }
  | { kind: "toggleSide" }
  | { kind: "openSkills" }
  | { kind: "toggleTheme" }
  | { kind: "openBottom"; tab: BottomTab }
  | { kind: "openSide"; tab: SideTab }
  | { kind: "openSettings"; group: SettingsGroupId }
  | { kind: "openModelConfig"; tab: McTab }
  | { kind: "openCapabilities"; tab: CapTab; name?: string };

export type PaletteItem = {
  id: string;
  icon: string;
  label: string;
  meta?: string;
  hint?: string;
  keywords?: string;
  recentIndex?: number;
  disabled?: boolean;
  disabledReason?: string;
  action: PaletteAction;
};

export type PaletteGroup = {
  id: string;
  label: string;
  items: PaletteItem[];
};

export type PaletteCatalogInput = {
  preview: boolean;
  historyEntries: ReadonlyArray<SessionHistoryEntry>;
  workspaces: ReadonlyArray<{ workspaceId: string; name: string }>;
  activeProjectName?: string;
  inventory: ReadonlyArray<DrawerItem>;
  query: string;
};

function findPreviewThreadByTitle(title: string): { projectId: string; threadId: string; projectName: string } | undefined {
  for (const project of PREVIEW_PROJECTS) {
    const thread = project.threads.find((entry) => entry.title === title);
    if (thread) return { projectId: project.id, threadId: thread.id, projectName: project.name };
  }
  return undefined;
}

function matches(item: PaletteItem, query: string): boolean {
  if (!query) return true;
  const haystack = `${item.label} ${item.meta ?? ""} ${item.keywords ?? ""} ${item.hint ?? ""}`;
  return haystack.toLowerCase().includes(query);
}

function recents(input: PaletteCatalogInput): PaletteItem[] {
  if (input.preview) {
    return PREVIEW_HISTORY.slice(0, 9).map((row, index) => {
      const hit = findPreviewThreadByTitle(row.title);
      const recentIndex = index + 1;
      return {
        id: `recent-${row.id}`,
        icon: "message",
        label: row.title,
        meta: row.project,
        hint: `Ctrl+${recentIndex}`,
        keywords: `${row.branch} ${row.model}`,
        recentIndex,
        action: hit
          ? { kind: "previewThread", threadId: hit.threadId }
          : { kind: "route", route: "workbench" },
      };
    });
  }
  return input.historyEntries.slice(0, 9).map((entry, index) => {
    const recentIndex = index + 1;
    return {
      id: `recent-${entry.historyId}`,
      icon: "message",
      label: entry.title,
      ...(input.activeProjectName ? { meta: input.activeProjectName } : {}),
      hint: `Ctrl+${recentIndex}`,
      keywords: entry.summary ?? "",
      recentIndex,
      action: { kind: "selectThread", entry },
    };
  });
}

function staticGroups(preview: boolean): PaletteGroup[] {
  return [
    {
      id: "recommended",
      label: "推荐",
      items: [
        {
          id: "new-chat",
          icon: "plus",
          label: "新建对话",
          hint: "Ctrl+Shift+O",
          keywords: "new chat thread",
          action: { kind: "newChat" },
        },
        { id: "pick-folder", icon: "folder-open", label: "打开本地文件夹", keywords: "open project workspace folder", action: { kind: "pickProject" } },
        { id: "history", icon: "history", label: "会话历史", keywords: "time travel", action: { kind: "route", route: "history" } },
      ],
    },
    {
      id: "pages",
      label: "页面",
      items: [
        { id: "page-workbench", icon: "layout", label: "工作台", action: { kind: "route", route: "workbench" } },
        { id: "page-home", icon: "home", label: "首页", keywords: "项目主页", action: { kind: "route", route: "home" } },
        { id: "page-hub", icon: "bot", label: "Agent Hub", action: { kind: "route", route: "agent-hub" } },
        { id: "page-cap", icon: "package", label: "能力中心", action: { kind: "route", route: "capabilities" } },
        { id: "page-mc", icon: "server", label: "模型配置", action: { kind: "route", route: "model-config" } },
        { id: "page-set", icon: "settings", label: "设置", action: { kind: "route", route: "settings" } },
        { id: "page-diag", icon: "pulse", label: "诊断中心", action: { kind: "route", route: "diagnostics" } },
        { id: "runtime-reconnect", icon: "refresh", label: "重新连接 Runtime", keywords: "reconnect ensure 断开 重连", action: { kind: "diagnostics", intent: "reconnect" } },
        { id: "runtime-restart", icon: "refresh", label: "重启 Runtime", keywords: "restart force 重启", action: { kind: "diagnostics", intent: "restart" } },
      ],
    },
    {
      id: "panels",
      label: "面板",
      items: [
        { id: "toggle-sidebar", icon: "layout", label: "切换侧栏", hint: "Ctrl+B", action: { kind: "toggleSidebar" } },
        { id: "toggle-bottom", icon: "rows", label: "切换底部面板", hint: "Ctrl+J", action: { kind: "toggleBottom" } },
        { id: "toggle-side", icon: "panel", label: "切换右侧面板", action: { kind: "toggleSide" } },
        { id: "open-terminal", icon: "terminal", label: "打开终端", action: { kind: "openBottom", tab: "terminal" } },
        { id: "open-problems", icon: "alert", label: "打开 Problems", action: { kind: "openBottom", tab: "problems" } },
        { id: "open-tests", icon: "test", label: "打开 Tests", action: { kind: "openBottom", tab: "tests" } },
        { id: "open-output", icon: "console", label: "打开 Output", action: { kind: "openBottom", tab: "output" } },
        { id: "open-logs", icon: "pulse", label: "打开 OMP Logs", action: { kind: "openBottom", tab: "logs" } },
        { id: "open-pvlogs", icon: "globe", label: "打开 Preview Logs", action: { kind: "openBottom", tab: "pvlogs" } },
        { id: "open-changes", icon: "diff", label: "打开 Changes", action: { kind: "openSide", tab: "changes" } },
        { id: "open-git", icon: "branch", label: "打开 Git", keywords: "git branch commit push pull stage", action: { kind: "openSide", tab: "git" } },
        { id: "open-preview", icon: "eye", label: "打开 Preview", action: { kind: "openSide", tab: "preview" } },
        { id: "open-agents", icon: "bot", label: "打开 Agents", action: { kind: "openSide", tab: "agents" } },
        { id: "open-btw", icon: "sparkles", label: "打开 BTW 面板", keywords: "btw 旁路 side channel 提问", action: { kind: "openSide", tab: "btw" } },
        { id: "open-skills", icon: "layers", label: "打开技能与插件", hint: "Ctrl+Shift+K", keywords: "skills plugins drawer", action: { kind: "openSkills" } },
      ],
    },
    {
      id: "config",
      label: "配置",
      items: [
        { id: "set-general", icon: "settings", label: "设置 · 常规", keywords: "general 主题 密度 通知 启动 布局", action: { kind: "openSettings", group: "general" } },
        { id: "set-interaction", icon: "message", label: "设置 · 对话与交互", keywords: "interaction steering 中断 粘贴 thinking 工具意图", action: { kind: "openSettings", group: "interaction" } },
        { id: "set-permissions", icon: "shield", label: "设置 · 权限与安全", keywords: "permissions 审批 always ask write yolo 工具级", action: { kind: "openSettings", group: "permissions" } },
        { id: "set-context", icon: "layers", label: "设置 · 上下文与记忆", keywords: "context compact 压缩 记忆 memory hindsight mnemopi", action: { kind: "openSettings", group: "context" } },
        { id: "set-files", icon: "terminal", label: "设置 · 文件与终端", keywords: "files edit mode hashline lsp shell 终端", action: { kind: "openSettings", group: "files" } },
        { id: "set-tasks", icon: "play", label: "设置 · 任务与执行", keywords: "tasks plan goal loop 子任务 并发", action: { kind: "openSettings", group: "tasks" } },
        { id: "set-advanced", icon: "wrench", label: "设置 · 高级", keywords: "advanced 配置层级 重试 循环保护", action: { kind: "openSettings", group: "advanced" } },
        { id: "mc-providers", icon: "server", label: "模型配置 · 供应商", action: { kind: "openModelConfig", tab: "providers" } },
        { id: "mc-roles", icon: "steering", label: "模型配置 · 角色", action: { kind: "openModelConfig", tab: "roles" } },
        { id: "mc-subagents", icon: "bot", label: "模型配置 · 子代理", action: { kind: "openModelConfig", tab: "subagents" } },
        { id: "cap-skills", icon: "book", label: "能力中心 · Skills", action: { kind: "openCapabilities", tab: "skills" } },
        { id: "cap-plugins", icon: "package", label: "能力中心 · Plugins", action: { kind: "openCapabilities", tab: "plugins" } },
        { id: "cap-mcp", icon: "plug", label: "能力中心 · MCP", action: { kind: "openCapabilities", tab: "mcp" } },
        { id: "cap-slash", icon: "slash", label: "能力中心 · Slash Commands", action: { kind: "openCapabilities", tab: "slash" } },
        { id: "toggle-theme", icon: "light", label: "切换主题", keywords: "dark light 亮 暗", action: { kind: "toggleTheme" } },
      ],
    },
  ];
}

function projectItems(input: PaletteCatalogInput): PaletteItem[] {
  if (input.preview) {
    return PREVIEW_PROJECTS.map((project) => ({
      id: `proj-${project.id}`,
      icon: "folder",
      label: project.name,
      meta: project.branch,
      keywords: project.path,
      action: { kind: "previewProject", id: project.id },
    }));
  }
  return input.workspaces.map((workspace) => ({
    id: `proj-${workspace.workspaceId}`,
    icon: "folder",
    label: workspace.name,
    action: { kind: "selectProject", id: workspace.workspaceId, name: workspace.name },
  }));
}

function inventoryItems(input: PaletteCatalogInput): PaletteItem[] {
  return input.inventory.map((item) => ({
    id: `inv-${item.kind}-${item.name}`,
    icon: item.kind === "skill" ? "book" : "package",
    label: item.name,
    meta: item.kind === "skill" ? "Skill" : "Plugin",
    keywords: item.kind === "skill" ? item.desc : item.src,
    action: {
      kind: "openCapabilities",
      tab: item.kind === "skill" ? "skills" : "plugins",
      name: item.name,
    },
  }));
}

export function buildPaletteGroups(input: PaletteCatalogInput): PaletteGroup[] {
  const query = input.query.trim().toLowerCase();
  const groups: PaletteGroup[] = [];
  const chat = recents(input).filter((item) => matches(item, query));
  if (chat.length) groups.push({ id: "chat", label: "聊天", items: chat });
  for (const group of staticGroups(input.preview)) {
    const items = group.items.filter((item) => matches(item, query));
    if (items.length) groups.push({ ...group, items });
  }
  const projects = projectItems(input).filter((item) => matches(item, query));
  if (projects.length) groups.push({ id: "projects", label: "项目", items: projects });
  if (query) {
    const inventory = inventoryItems(input).filter((item) => matches(item, query));
    if (inventory.length) groups.push({ id: "inventory", label: "技能与插件", items: inventory });
  }
  return groups;
}

export function flattenPaletteItems(groups: ReadonlyArray<PaletteGroup>): PaletteItem[] {
  return groups.flatMap((group) => group.items);
}
