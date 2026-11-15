/**
 * Composer `/` is a session-command menu, not a skill picker.
 * Catalog covers OMP builtins; execution prefers typed Studio commands,
 * then operator.invoke, then existing UI. Skills stay out of this list.
 */

import type { CommandName, ThreadId } from "@omp-studio/client-contract";
import type { CommandSource, OperatorCommandManifest, OperatorCommandManifestEntry } from "@omp-studio/studio-protocol";

import { isZh, pickLocale } from "../i18n";
import { snapshotFromDoc, snapshotIsEmpty } from "./serialize";
import type { ComposerDoc, ComposerSnapshot } from "./types";

export type SlashGroup = "session" | "mode" | "model" | "context" | "capability" | "workspace" | "collab" | "help";

export type SlashNativeUi =
  | "model-picker"
  | "mode-picker"
  | "mode-toggles"
  | "settings"
  | "model-config"
  | "capabilities-mcp"
  | "capabilities-plugins"
  | "capabilities-slash"
  | "agent-hub"
  | "history"
  | "new-chat"
  | "command-palette"
  | "skills-drawer"
  | "session-tree"
  | "user-message-branch"
  | "context-viewer"
  | "local-files"
  | "plan-review";

export type SlashSelect = "run-now" | "complete-args" | "native-ui" | "chip";

export type SlashTyped = {
  readonly name: CommandName;
  readonly fromArgs?: (args: string) => Record<string, unknown>;
};

export type SlashSubcommand = {
  readonly name: string;
  readonly description: string;
  readonly usage?: string;
};

export type StudioSlashCommand = {
  readonly side?: boolean;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly group: SlashGroup;
  readonly allowArgs: boolean;
  readonly hint?: string;
  readonly subcommands?: readonly SlashSubcommand[];
  readonly availability: "available" | "hidden" | "disabled";
  readonly disabledReason?: string;
  readonly risk: "normal" | "sensitive" | "destructive";
  readonly select: SlashSelect;
  readonly ui?: SlashNativeUi;
  readonly typed?: SlashTyped;
  readonly invokeId?: string;
  /** Runtime manifest source; absent for legacy static entries. */
  readonly source?: CommandSource;
};

export type SlashDraft = {
  readonly name: string;
  readonly args: string;
  readonly text: string;
};

export type SlashExecute =
  | { readonly kind: "native-ui"; readonly ui: SlashNativeUi }
  | { readonly kind: "typed"; readonly name: CommandName; readonly input: Record<string, unknown> }
  | { readonly kind: "invoke"; readonly commandId: string; readonly arguments: string }
  | { readonly kind: "none" };

export const SLASH_GROUP_KEY: Record<SlashGroup, string> = {
  session: "composer.slashGroupSession",
  mode: "composer.slashGroupMode",
  model: "composer.slashGroupModel",
  context: "composer.slashGroupContext",
  capability: "composer.slashGroupCapability",
  workspace: "composer.slashGroupWorkspace",
  collab: "composer.slashGroupCollab",
  help: "composer.slashGroupHelp",
};

export const SLASH_GROUP_LABEL: Record<SlashGroup, string> = {
  session: "Session",
  mode: "Mode",
  model: "Model",
  context: "Context",
  capability: "Capability",
  workspace: "Workspace",
  collab: "Collaboration",
  help: "Help",
};

const GROUP_ORDER: readonly SlashGroup[] = ["mode", "model", "session", "context", "capability", "workspace", "collab", "help"];

export const MODE_MUTEX = ["plan", "vibe", "goal"] as const;
export const MODE_SOLO = ["fast", "prewalk", "loop"] as const;
export const MODE_CHIP_NAMES: ReadonlySet<string> = new Set([...MODE_MUTEX, ...MODE_SOLO]);

function cmd(
  name: string,
  description: string,
  group: SlashGroup,
  extra: Partial<Omit<StudioSlashCommand, "name" | "description" | "group">> = {},
): StudioSlashCommand {
  return {
    name,
    aliases: extra.aliases ?? [],
    description,
    group,
    allowArgs: extra.allowArgs === true,
    availability: extra.availability ?? "available",
    risk: extra.risk ?? "normal",
    select: extra.select ?? (extra.ui !== undefined ? "native-ui" : extra.allowArgs === true ? "complete-args" : "run-now"),
    ...(extra.hint === undefined ? {} : { hint: extra.hint }),
    ...(extra.subcommands === undefined ? {} : { subcommands: extra.subcommands }),
    ...(extra.disabledReason === undefined ? {} : { disabledReason: extra.disabledReason }),
    ...(extra.ui === undefined ? {} : { ui: extra.ui }),
    ...(extra.typed === undefined ? {} : { typed: extra.typed }),
    ...(extra.invokeId === undefined ? {} : { invokeId: extra.invokeId }),
  };
}

function bareSlashName(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function normalizedSlashName(name: string): string {
  return bareSlashName(name).trim().toLowerCase();
}

function manifestMatchesStatic(entry: OperatorCommandManifestEntry, command: StudioSlashCommand): boolean {
  if (command.invokeId === entry.id) return true;
  if (entry.source !== "builtin") return false;
  const manifestNames = [entry.name, ...entry.aliases].map(normalizedSlashName);
  return [command.name, ...command.aliases].some((name) => manifestNames.includes(normalizedSlashName(name)));
}

function manifestGroup(source: CommandSource): SlashGroup {
  if (source === "file-command") return "workspace";
  if (source === "skill" || source === "extension" || source === "prompt-template") return "capability";
  return "help";
}

function manifestAllowsArgs(entry: OperatorCommandManifestEntry): boolean {
  return entry.argumentSchema !== undefined && Object.keys(entry.argumentSchema).length > 0;
}

function hasLocalSlashMapping(metadata: StudioSlashCommand | undefined): boolean {
  return (metadata?.select === "native-ui" && metadata.ui !== undefined) || metadata?.typed !== undefined;
}

function manifestAvailability(entry: OperatorCommandManifestEntry, metadata: StudioSlashCommand | undefined): StudioSlashCommand["availability"] {
  if (entry.presentation === "terminal" && !hasLocalSlashMapping(metadata)) return "disabled";
  return entry.availability === "available" ? "available" : "disabled";
}

function manifestDisabledReason(entry: OperatorCommandManifestEntry, metadata: StudioSlashCommand | undefined, zh: boolean): string | undefined {
  if (entry.presentation === "terminal" && !hasLocalSlashMapping(metadata)) {
    return zh ? "此指令需要终端交互，暂不能在 Studio 中执行" : "This command requires an interactive terminal and cannot run in Studio yet";
  }
  if (entry.availability === "available") return undefined;
  return entry.availability === "blocked"
    ? (zh ? "Runtime 已阻止此指令" : "Blocked by Runtime")
    : (zh ? "Runtime 已禁用此指令" : "Disabled by Runtime");
}

/**
 * Project the Runtime operator manifest into the slash-command presentation.
 *
 * An omitted manifest is the compatibility path used by preview/legacy callers
 * and returns the existing static catalog. Once a manifest is supplied, it is
 * the complete Runtime set: static entries may only enrich a matching row
 * (native UI, typed mapping, group, and argument hints), never add a command.
 */
export function mergeSlashCatalogWithManifest(manifest?: OperatorCommandManifest, zh = isZh()): StudioSlashCommand[] {
  if (manifest === undefined) return visibleSlashCatalog(zh);

  return manifest.commands.map((entry) => {
    const rawMetadata = BUILTIN_SLASH_CATALOG.find((command) => manifestMatchesStatic(entry, command));
    const metadata = rawMetadata ? localizeSlashCommand(rawMetadata, zh) : undefined;
    const schemaAllowsArgs = manifestAllowsArgs(entry);
    const allowArgs = metadata?.allowArgs === true || schemaAllowsArgs;
    const localSelect = metadata?.select === "native-ui" || metadata?.typed !== undefined
      ? metadata.select
      : undefined;
    const select = localSelect ?? (allowArgs ? "complete-args" : "run-now");
    const aliases = [...new Set(entry.aliases.map(bareSlashName).filter((alias) => alias.length > 0))];
    const name = bareSlashName(entry.name);
    const disabledReason = manifestDisabledReason(entry, metadata, zh);
    return {
      name,
      aliases,
      description: entry.description || metadata?.description || name,
      group: metadata?.group ?? manifestGroup(entry.source),
      allowArgs,
      ...(metadata?.hint === undefined && allowArgs ? { hint: "[arguments]" } : metadata?.hint === undefined ? {} : { hint: metadata.hint }),
      ...(metadata?.subcommands === undefined ? {} : { subcommands: metadata.subcommands }),
      availability: manifestAvailability(entry, metadata),
      ...(disabledReason === undefined ? {} : { disabledReason }),
      risk: entry.risk,
      select,
      ...(metadata?.ui === undefined ? {} : { ui: metadata.ui }),
      ...(metadata?.typed === undefined ? {} : { typed: metadata.typed }),
      invokeId: entry.id,
      source: entry.source,
      ...(entry.side ? { side: true } : {}),
    } satisfies StudioSlashCommand;
  });
}

function onOffStatus(extra: string): readonly SlashSubcommand[] {
  return [
    { name: "on", description: `Enable ${extra}` },
    { name: "off", description: `Disable ${extra}` },
    { name: "status", description: `Show ${extra} status` },
  ];
}

/** Full OMP builtin catalog for the composer `/` menu. Hidden entries stay resolvable by alias. */
export const BUILTIN_SLASH_CATALOG: readonly StudioSlashCommand[] = [
  cmd("help", "List available slash commands", "help", { select: "native-ui", ui: "command-palette" }),
  cmd("model", "Switch model for this session", "model", {
    aliases: ["models"],
    select: "native-ui",
    ui: "model-picker",
    invokeId: "builtin.model",
  }),
  cmd("switch", "Open model picker (temporary)", "model", { select: "native-ui", ui: "model-picker" }),
  cmd("fast", "Toggle service priority tier", "mode", {
    allowArgs: true,
    hint: "[on|off|status]",
    subcommands: onOffStatus("fast mode"),
    select: "chip",
    typed: {
      name: "session.fast.set",
      fromArgs: (args) => ({ enabled: args.trim().toLowerCase() !== "off" }),
    },
    invokeId: "builtin.fast",
  }),
  cmd("prewalk", "Use cheaper model for next edit step", "mode", {
    select: "chip",
    typed: { name: "session.prewalk.arm" },
    invokeId: "builtin.prewalk",
  }),
  cmd("prewalk-restart", "Return to default model and re-arm Prewalk", "mode", {
    select: "run-now",
    typed: { name: "session.prewalk.restart" },
  }),
  cmd("plan", "Toggle Plan mode", "mode", {
    allowArgs: true,
    hint: "[prompt]",
    select: "chip",
    typed: { name: "mode.plan.enter", fromArgs: (args) => (args ? { initialPrompt: args } : {}) },
  }),
  cmd("plan-review", "Reopen plan review", "mode", {
    select: "native-ui",
    ui: "plan-review",
    typed: { name: "mode.plan.review.open" },
  }),
  cmd("vibe", "Toggle Vibe mode", "mode", {
    allowArgs: true,
    hint: "[prompt]",
    select: "chip",
    typed: { name: "mode.vibe.enter", fromArgs: (args) => (args ? { initialPrompt: args } : {}) },
  }),
  cmd("goal", "Goal mode", "mode", {
    allowArgs: true,
    hint: "[objective]",
    subcommands: [
      { name: "set", description: "Set objective", usage: "<objective>" },
      { name: "show", description: "Show current objective" },
      { name: "pause", description: "Pause objective" },
      { name: "resume", description: "Resume objective" },
      { name: "drop", description: "Drop objective" },
      { name: "budget", description: "Adjust token budget", usage: "<N|off>" },
    ],
    select: "chip",
    typed: { name: "goal.create", fromArgs: (args) => ({ objective: args || "Continue current work" }) },
  }),
  cmd("guided-goal", "Interview before entering goal mode", "mode", {
    select: "run-now",
    typed: { name: "goal.guided.start" },
  }),
  cmd("loop", "Loop and re-prompt next message", "mode", {
    allowArgs: true,
    hint: "[count|duration] [prompt]",
    select: "chip",
    typed: { name: "loop.enable", fromArgs: (args) => (args ? { prompt: args } : {}) },
  }),
  cmd("queue", "Queue to send after current turn", "session", {
    allowArgs: true,
    hint: "<message>",
    select: "complete-args",
    typed: { name: "queue.enqueue", fromArgs: (args) => ({ text: args }) },
  }),
  cmd("settings", "Open settings", "help", { select: "native-ui", ui: "settings" }),
  cmd("setup", "Open provider configuration", "capability", { aliases: ["providers"], select: "native-ui", ui: "model-config" }),
  cmd("login", "Log in to provider", "capability", { select: "native-ui", ui: "model-config" }),
  cmd("logout", "Log out from provider", "capability", { select: "native-ui", ui: "model-config" }),
  cmd("compact", "Compact current conversation context", "context", {
    allowArgs: true,
    hint: "[soft|remote|snapcompact] [focus]",
    subcommands: [
      { name: "soft", description: "Soft compact", usage: "[focus]" },
      { name: "remote", description: "Remote compact", usage: "[focus]" },
      { name: "snapcompact", description: "Snapshot compact" },
    ],
    select: "complete-args",
    invokeId: "builtin.compact",
  }),
  cmd("shake", "Drop heavy tool results from context", "context", {
    allowArgs: true,
    hint: "[elide|images]",
    subcommands: [
      { name: "elide", description: "Drop tool results and large blocks" },
      { name: "images", description: "Drop image blocks" },
    ],
    select: "complete-args",
    invokeId: "builtin.shake",
  }),
  cmd("fresh", "Reset provider stream, keep local record", "context", { select: "run-now", invokeId: "builtin.fresh" }),
  cmd("clear", "Clear context, keep session", "context", {
    select: "run-now",
    risk: "destructive",
    typed: { name: "session.clearContext" },
  }),
  cmd("delete", "Delete current session and start new", "session", {
    aliases: ["drop"],
    select: "run-now",
    risk: "destructive",
    typed: { name: "session.drop" },
  }),
  cmd("new", "Start a new session", "session", { select: "native-ui", ui: "new-chat" }),
  cmd("rename", "Rename current session", "session", { allowArgs: true, hint: "<title>", select: "complete-args", invokeId: "builtin.rename" }),
  cmd("handoff", "Hand off context to new session", "session", {
    select: "run-now",
    typed: { name: "session.handoff" },
  }),
  cmd("resume", "Switch to another session", "session", { select: "native-ui", ui: "history" }),
  cmd("retry", "Retry last failed turn", "session", { select: "run-now", typed: { name: "turn.retry" } }),
  cmd("fork", "Fork from previous message", "session", { select: "run-now", typed: { name: "session.fork" } }),
  cmd("branch", "Create branch from previous message", "session", { select: "native-ui", ui: "user-message-branch" }),
  cmd("tree", "Open session tree", "session", { select: "native-ui", ui: "session-tree" }),
  cmd("session", "Session info / delete / pin account", "session", {
    allowArgs: true,
    hint: "[info|delete|pin]",
    subcommands: [
      { name: "info", description: "Session info" },
      { name: "delete", description: "Delete current session" },
      { name: "pin", description: "Pin OAuth account", usage: "[account]" },
    ],
    select: "complete-args",
    invokeId: "builtin.session",
    risk: "sensitive",
  }),
  cmd("pause", "Pause Runtime", "session", { select: "run-now", typed: { name: "runtime.pause" } }),
  cmd("btw", "Side-channel Q&A and history", "session", { allowArgs: true, hint: "[question]", select: "run-now", typed: { name: "btw.ask", fromArgs: (args) => ({ question: args }) } }),
  cmd("tan", "Background side-channel agent", "session", { allowArgs: true, hint: "<work>", select: "complete-args", typed: { name: "tan.start", fromArgs: (args) => ({ work: args }) } }),
  cmd("omfg", "Generate TTSR rules", "session", { allowArgs: true, hint: "<complaint>", select: "complete-args", typed: { name: "omfg.generate", fromArgs: (args) => ({ complaint: args }) } }),
  cmd("computer", "Session computer-use", "mode", {
    allowArgs: true,
    hint: "[on|off|status]",
    subcommands: onOffStatus("computer use"),
    select: "complete-args",
    invokeId: "builtin.computer",
  }),
  cmd("vision", "Session inspect_image", "mode", {
    allowArgs: true,
    hint: "[on|off|auto|status]",
    subcommands: [
      { name: "on", description: "Always expose inspect_image" },
      { name: "off", description: "Hide inspect_image" },
      { name: "auto", description: "Follow settings" },
      { name: "status", description: "Show status" },
    ],
    select: "complete-args",
    invokeId: "builtin.vision",
  }),
  cmd("advisor", "Second-model advisor", "mode", {
    allowArgs: true,
    hint: "[on|off|status|dump|configure]",
    subcommands: [
      { name: "on", description: "Enable advisor" },
      { name: "off", description: "Disable advisor" },
      { name: "status", description: "Advisor status" },
      { name: "dump", description: "Copy advisor transcript", usage: "[raw]" },
      { name: "configure", description: "Configure advisor" },
    ],
    select: "complete-args",
    invokeId: "builtin.advisor",
  }),
  cmd("mcp", "Manage MCP servers", "capability", {
    select: "native-ui",
    ui: "capabilities-mcp",
    invokeId: "builtin.mcp",
  }),
  cmd("plugins", "List or toggle plugins", "capability", {
    select: "native-ui",
    ui: "capabilities-plugins",
    invokeId: "builtin.plugins",
  }),
  cmd("marketplace", "Plugin marketplace", "capability", { select: "native-ui", ui: "capabilities-plugins", invokeId: "builtin.marketplace" }),
  cmd("reload-plugins", "Reload skills / commands / MCP", "capability", { select: "run-now", invokeId: "builtin.reload-plugins" }),
  cmd("extensions", "Extensions console", "capability", { aliases: ["status"], select: "native-ui", ui: "capabilities-slash" }),
  cmd("agents", "Open Agent Hub", "capability", { select: "native-ui", ui: "agent-hub" }),
  cmd("tools", "List active tools", "capability", { select: "run-now", invokeId: "builtin.tools" }),
  cmd("jobs", "Background jobs", "capability", { select: "run-now", invokeId: "builtin.jobs" }),
  cmd("usage", "Provider usage", "help", { select: "run-now", invokeId: "builtin.usage" }),
  cmd("stats", "Open usage dashboard", "help", { select: "run-now", invokeId: "builtin.stats" }),
  cmd("local", "Edit native session files", "context", { ui: "local-files", allowArgs: true }),
  cmd("context", "Inspect context body and token estimate", "context", { ui: "context-viewer" }),
  cmd("changelog", "Changelog", "help", { select: "run-now", invokeId: "builtin.changelog" }),
  cmd("hotkeys", "Open command palette", "help", { select: "native-ui", ui: "command-palette" }),
  cmd("todo", "Todo list", "session", { allowArgs: true, hint: "<subcommand>", select: "complete-args", invokeId: "builtin.todo" }),
  cmd("memory", "Memory backend", "context", {
    allowArgs: true,
    hint: "<subcommand>",
    subcommands: [
      { name: "view", description: "View injected entries" },
      { name: "stats", description: "Backend stats" },
      { name: "diagnose", description: "Diagnose" },
      { name: "clear", description: "Clear memory" },
      { name: "reset", description: "Alias for clear" },
      { name: "enqueue", description: "Queue consolidation" },
      { name: "rebuild", description: "Alias for enqueue" },
    ],
    select: "complete-args",
    invokeId: "builtin.memory",
    risk: "sensitive",
  }),
  cmd("export", "Export session HTML", "session", { select: "run-now", invokeId: "builtin.export" }),
  cmd("dump", "Export full session transcript", "session", { select: "run-now", invokeId: "builtin.dump" }),
  cmd("copy", "Copy from conversation", "session", { allowArgs: true, hint: "[code|cmd]", availability: "disabled", disabledReason: "Copy (not implemented yet)", select: "run-now" }),
  cmd("debug", "Debugging tools", "help", { availability: "disabled", disabledReason: "Debug (not implemented yet)", select: "run-now" }),
  cmd("security", "Security scan", "capability", { allowArgs: true, hint: "<subcommand>", select: "complete-args", invokeId: "builtin.security" }),
  cmd("ssh", "SSH hosts", "workspace", { allowArgs: true, hint: "<subcommand>", select: "complete-args", invokeId: "builtin.ssh" }),
  cmd("move", "Move session working directory", "workspace", { allowArgs: true, hint: "[<path>]", select: "complete-args", invokeId: "builtin.move" }),
  cmd("add-dir", "Add workspace root directory", "workspace", { allowArgs: true, hint: "<path>", select: "complete-args", invokeId: "builtin.add-dir" }),
  cmd("remove-dir", "Remove workspace root directory", "workspace", { allowArgs: true, hint: "<path>", select: "complete-args", invokeId: "builtin.remove-dir" }),
  cmd("dirs", "List workspace directories", "workspace", { select: "run-now", invokeId: "builtin.dirs" }),
  cmd("force", "Force specific tool in next turn", "mode", { aliases: ["force:"], allowArgs: true, hint: "<tool-name> [prompt]", select: "complete-args", invokeId: "builtin.force" }),
  cmd("share", "Generate share link", "collab", { select: "run-now", invokeId: "builtin.share" }),
  cmd("collab", "Realtime collaboration", "collab", { allowArgs: true, hint: "[start|view|stop|status]", availability: "disabled", disabledReason: "Collaboration (not implemented yet)", select: "complete-args" }),
  cmd("join", "Join collaboration", "collab", { allowArgs: true, hint: "<link>", availability: "disabled", disabledReason: "Collaboration (not implemented yet)", select: "complete-args" }),
  cmd("leave", "Leave collaboration", "collab", { availability: "disabled", disabledReason: "Collaboration (not implemented yet)", select: "run-now" }),
  cmd("browser", "Browser visibility", "capability", { allowArgs: true, hint: "[headless|visible]", select: "complete-args", invokeId: "builtin.browser" }),
  cmd("live", "Realtime voice", "collab", { availability: "hidden", select: "run-now" }),
  cmd("quit", "Quit application", "help", { aliases: ["q"], availability: "hidden", select: "run-now" }),
  cmd("exit", "Exit application", "help", { availability: "hidden", select: "run-now" }),
];

type SlashZhOverride = {
  readonly description?: string;
  readonly disabledReason?: string;
  readonly subcommands?: Record<string, string>;
};

const SLASH_ZH_OVERRIDES: Record<string, SlashZhOverride> = {
  help: { description: "列出可用指令" },
  model: { description: "切换本会话模型" },
  switch: { description: "打开模型选择（临时）" },
  fast: { description: "切换优先服务档位" },
  prewalk: { description: "下一步编辑改用便宜模型" },
  "prewalk-restart": { description: "返回默认模型并重新准备 Prewalk" },
  plan: { description: "切换 Plan 模式" },
  "plan-review": { description: "重新打开计划评审" },
  vibe: { description: "切换 Vibe 模式" },
  goal: {
    description: "目标模式",
    subcommands: {
      set: "设置目标",
      show: "查看当前目标",
      pause: "暂停目标",
      resume: "恢复目标",
      drop: "丢弃目标",
      budget: "调整 token 预算",
    },
  },
  "guided-goal": { description: "访谈后进入目标模式" },
  loop: { description: "循环重提下一条消息" },
  queue: { description: "排队到本轮结束后发送" },
  settings: { description: "打开设置" },
  setup: { description: "打开供应商配置" },
  login: { description: "登录供应商" },
  logout: { description: "登出供应商" },
  compact: {
    description: "压缩当前会话上下文",
    subcommands: {
      soft: "软压缩",
      remote: "远程压缩",
      snapcompact: "快照压缩",
    },
  },
  shake: {
    description: "丢掉沉重的工具结果",
    subcommands: {
      elide: "去掉工具结果和大块",
      images: "去掉图片块",
    },
  },
  fresh: { description: "重置供应商流，保留本地记录" },
  clear: { description: "清空上下文，保留会话" },
  delete: { description: "删除当前会话并开新会话" },
  new: { description: "开始新会话" },
  rename: { description: "重命名当前会话" },
  handoff: { description: "交接上下文到新会话" },
  resume: { description: "切换到另一会话" },
  retry: { description: "重试上一轮失败" },
  fork: { description: "从先前消息分叉" },
  branch: { description: "从先前消息建分支" },
  tree: { description: "打开会话树" },
  session: {
    description: "会话信息 / 删除 / 固定账号",
    subcommands: {
      info: "会话信息",
      delete: "删除当前会话",
      pin: "固定 OAuth 账号",
    },
  },
  pause: { description: "暂停 Runtime" },
  btw: { description: "旁路问答与历史" },
  tan: { description: "后台旁路代理" },
  omfg: { description: "生成 TTSR 规则" },
  computer: { description: "本会话 computer-use" },
  vision: {
    description: "本会话 inspect_image",
    subcommands: {
      on: "始终暴露 inspect_image",
      off: "隐藏 inspect_image",
      auto: "跟随设置",
      status: "查看状态",
    },
  },
  advisor: {
    description: "第二模型顾问",
    subcommands: {
      on: "启用顾问",
      off: "关闭顾问",
      status: "顾问状态",
      dump: "复制顾问记录",
      configure: "配置顾问",
    },
  },
  mcp: { description: "管理 MCP 服务器" },
  plugins: { description: "列出或开关插件" },
  marketplace: { description: "插件市场" },
  "reload-plugins": { description: "重载技能 / 指令 / MCP" },
  extensions: { description: "扩展控制台" },
  agents: { description: "打开 Agent Hub" },
  tools: { description: "列出活动工具" },
  jobs: { description: "后台任务" },
  usage: { description: "供应商用量" },
  stats: { description: "打开用量看板" },
  local: { description: "编辑原生会话文件" },
  context: { description: "检查上下文正文与 token 估算" },
  changelog: { description: "更新说明" },
  hotkeys: { description: "打开命令面板" },
  todo: { description: "待办列表" },
  memory: {
    description: "记忆后端",
    subcommands: {
      view: "查看注入内容",
      stats: "后端统计",
      diagnose: "诊断",
      clear: "清空记忆",
      reset: "clear 的别名",
      enqueue: "排队整理",
      rebuild: "enqueue 的别名",
    },
  },
  export: { description: "导出会话 HTML" },
  dump: { description: "导出完整记录" },
  copy: { description: "从对话复制", disabledReason: "复制（暂未实现）" },
  debug: { description: "调试工具", disabledReason: "调试（暂未实现）" },
  security: { description: "安全扫描" },
  ssh: { description: "SSH 主机" },
  move: { description: "移动会话工作目录" },
  "add-dir": { description: "加入工作区根目录" },
  "remove-dir": { description: "移除工作区根目录" },
  dirs: { description: "列出工作区目录" },
  force: { description: "下一轮强制使用指定工具" },
  share: { description: "生成分享链接" },
  collab: { description: "实时协作", disabledReason: "协作（暂未实现）" },
  join: { description: "加入协作", disabledReason: "协作（暂未实现）" },
  leave: { description: "离开协作", disabledReason: "协作（暂未实现）" },
  browser: { description: "浏览器可见性" },
  live: { description: "实时语音" },
  quit: { description: "退出应用" },
  exit: { description: "退出应用" },
};

function localizeSlashCommand(command: StudioSlashCommand, zh: boolean): StudioSlashCommand {
  if (!zh) return command;
  const override = SLASH_ZH_OVERRIDES[command.name];
  if (!override) return command;
  return {
    ...command,
    ...(override.description === undefined ? {} : { description: override.description }),
    ...(override.disabledReason === undefined || command.disabledReason === undefined
      ? {}
      : { disabledReason: override.disabledReason }),
    ...(command.subcommands && override.subcommands
      ? {
          subcommands: command.subcommands.map((sub) => {
            const subDesc = override.subcommands?.[sub.name];
            return subDesc === undefined ? sub : { ...sub, description: subDesc };
          }),
        }
      : {}),
  };
}

const CATALOG_BY_NAME = new Map<string, StudioSlashCommand>();
for (const command of BUILTIN_SLASH_CATALOG) {
  CATALOG_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) CATALOG_BY_NAME.set(alias, command);
}

/**
 * Slash menu follows typed `/…` at the start of the draft.
 * Skill capsules serialize as `/skill:name` and must not open the command menu.
 * Mode capsules serialize empty, so they are skipped.
 */
export function typedSlashSource(doc: ComposerDoc): string {
  let text = "";
  for (const node of doc.nodes) {
    if (node.type === "chip") {
      if (node.chip.kind === "mode") continue;
      break;
    }
    text += node.value;
  }
  return text;
}

export function parseSlashDraft(text: string): SlashDraft | null {
  if (!text.startsWith("/")) return null;
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
  const body = firstLine.slice(1);
  if (body.length === 0) return { name: "", args: "", text: firstLine };
  const firstWhitespace = body.search(/\s/u);
  const firstColon = body.indexOf(":");
  const firstSeparator =
    firstWhitespace === -1 ? firstColon : firstColon === -1 ? firstWhitespace : Math.min(firstWhitespace, firstColon);
  if (firstSeparator === -1) return { name: body, args: "", text: firstLine };
  return {
    name: body.slice(0, firstSeparator),
    args: body.slice(firstSeparator + 1).trim(),
    text: firstLine,
  };
}

export function lookupSlashCommand(name: string, catalog?: readonly StudioSlashCommand[]): StudioSlashCommand | undefined {
  const key = normalizedSlashName(name);
  const zh = isZh();
  if (catalog === undefined) {
    const found = CATALOG_BY_NAME.get(key);
    return found ? localizeSlashCommand(found, zh) : undefined;
  }
  const found = catalog.find((command) => [command.name, ...command.aliases].some((candidate) => normalizedSlashName(candidate) === key));
  return found ? localizeSlashCommand(found, zh) : undefined;
}

export function visibleSlashCatalog(zh = isZh()): StudioSlashCommand[] {
  return BUILTIN_SLASH_CATALOG.filter((command) => command.availability !== "hidden").map((command) => localizeSlashCommand(command, zh));
}

function scoreCommand(command: StudioSlashCommand, needle: string): number {
  if (command.name === needle) return 0;
  if (command.aliases.some((alias) => alias === needle)) return 1;
  if (command.name.startsWith(needle)) return 2;
  if (command.aliases.some((alias) => alias.startsWith(needle))) return 3;
  if (command.name.includes(needle)) return 4;
  if (command.description.toLowerCase().includes(needle)) return 5;
  return 9;
}

export function filterSlashCommands(query: string, catalog: readonly StudioSlashCommand[] = visibleSlashCatalog()): StudioSlashCommand[] {
  const needle = query.trim().toLowerCase();
  const pool = catalog.filter((command) => command.availability !== "hidden");
  if (!needle) {
    return [...pool].sort((left, right) => {
      const group = GROUP_ORDER.indexOf(left.group) - GROUP_ORDER.indexOf(right.group);
      if (group !== 0) return group;
      return pool.indexOf(left) - pool.indexOf(right);
    });
  }
  return pool
    .map((command) => ({ command, score: scoreCommand(command, needle) }))
    .filter((entry) => entry.score < 9)
    .sort((left, right) => left.score - right.score || left.command.name.localeCompare(right.command.name))
    .map((entry) => entry.command);
}

function resolveModeControl(command: StudioSlashCommand, args: string): SlashExecute {
  const trimmed = args.trim();
  const verb = trimmed.split(/\s+/u)[0]?.toLowerCase() ?? "";
  const tail = trimmed.slice(verb.length).trim();
  if (command.name === "fast") {
    if (verb === "on") return { kind: "typed", name: "session.fast.set", input: { enabled: true } };
    if (verb === "off") return { kind: "typed", name: "session.fast.set", input: { enabled: false } };
    if (verb === "status" && command.invokeId) {
      return { kind: "invoke", commandId: command.invokeId, arguments: "status" };
    }
  }
  if (command.name === "goal") {
    if (verb === "show") return { kind: "typed", name: "goal.show", input: {} };
    if (verb === "pause") return { kind: "typed", name: "goal.pause", input: {} };
    if (verb === "resume") return { kind: "typed", name: "goal.resume", input: {} };
    if (verb === "drop") return { kind: "typed", name: "goal.drop", input: {} };
    if (verb === "set") {
      return { kind: "typed", name: "goal.create", input: { objective: tail || "Continue current work" } };
    }
    if (verb === "budget") {
      if (tail.length === 0 || tail.toLowerCase() === "off") {
        return { kind: "typed", name: "goal.setBudget", input: {} };
      }
      const tokens = Number(tail);
      if (Number.isFinite(tokens) && tokens >= 0) {
        return { kind: "typed", name: "goal.setBudget", input: { tokenBudget: tokens } };
      }
    }
  }
  if (command.invokeId) return { kind: "invoke", commandId: command.invokeId, arguments: trimmed };
  return { kind: "none" };
}

export function resolveSlashExecute(command: StudioSlashCommand, args: string): SlashExecute {
  const trimmed = args.trim();
  if (command.availability === "hidden" || command.availability === "disabled") return { kind: "none" };
  if (command.select === "chip" && isModeControlArgs(command, trimmed)) {
    return resolveModeControl(command, trimmed);
  }
  if (command.select === "chip" && command.typed) {
    return { kind: "typed", name: command.typed.name, input: command.typed.fromArgs?.(trimmed) ?? {} };
  }
  if (trimmed && command.typed?.fromArgs) {
    return { kind: "typed", name: command.typed.name, input: command.typed.fromArgs(trimmed) };
  }
  if (trimmed && command.invokeId) {
    return { kind: "invoke", commandId: command.invokeId, arguments: trimmed };
  }
  if (!trimmed && command.select === "native-ui" && command.ui) {
    return { kind: "native-ui", ui: command.ui };
  }
  if (!trimmed && command.ui && command.select !== "run-now" && command.select !== "chip") {
    return { kind: "native-ui", ui: command.ui };
  }
  // Bare `run-now` commands with an args mapper still execute: /btw with no
  // question opens history, which `fromArgs("")` encodes.
  if (command.typed && (trimmed || command.typed.fromArgs === undefined || command.select === "run-now")) {
    return { kind: "typed", name: command.typed.name, input: command.typed.fromArgs?.(trimmed) ?? {} };
  }
  if (command.invokeId) {
    return { kind: "invoke", commandId: command.invokeId, arguments: trimmed };
  }
  if (command.ui) return { kind: "native-ui", ui: command.ui };
  return { kind: "none" };
}

/**
 * Host `session.drop` is catalog-scoped and needs the current threadId.
 * Runtime `session.drop` is invoked by that Host command, not by the slash
 * catalog sending an empty P4 payload.
 */
export function bindSlashTypedCommand(
  execute: Extract<SlashExecute, { kind: "typed" }>,
  context: { readonly threadId?: ThreadId },
): { readonly ok: true; readonly name: CommandName; readonly input: Record<string, unknown> } | { readonly ok: false; readonly error: string } {
  if (execute.name === "session.drop") {
    const threadId = context.threadId;
    if (threadId === undefined || threadId.length === 0) {
      return {
        ok: false,
        error: pickLocale("没有当前会话，无法执行 /delete", "No active session; cannot run /delete"),
      };
    }
    return { ok: true, name: "session.drop", input: { threadId } };
  }
  return { ok: true, name: execute.name, input: execute.input };
}

export function slashNeedsArgs(command: StudioSlashCommand, args: string): boolean {
  if (!command.allowArgs) return false;
  if (command.select !== "complete-args") return false;
  return args.trim().length === 0;
}

export function isDestructiveMemoryClear(command: StudioSlashCommand, args: string): boolean {
  if (command.name !== "memory") return false;
  const verb = args.trim().split(/\s+/u)[0]?.toLowerCase();
  return verb === "clear" || verb === "reset";
}

export function modeChipConflictsWith(name: string, existing: string): boolean {
  if (name === existing) return true;
  const mutex: readonly string[] = MODE_MUTEX;
  return mutex.includes(name) && mutex.includes(existing);
}

export function isModeControlArgs(command: StudioSlashCommand, args: string): boolean {
  const verb = args.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (verb.length === 0) return false;
  if (command.name === "fast") return verb === "on" || verb === "off" || verb === "status";
  if (command.name === "goal") {
    return verb === "set" || verb === "show" || verb === "pause" || verb === "resume" || verb === "drop" || verb === "budget";
  }
  return false;
}

export type SlashApply = {
  readonly command: StudioSlashCommand;
  readonly args: string;
};

export type SlashSendPlan =
  | { readonly kind: "prompt"; readonly snapshot: ComposerSnapshot }
  | { readonly kind: "follow-up"; readonly snapshot: ComposerSnapshot }
  | { readonly kind: "execute"; readonly command: StudioSlashCommand; readonly args: string }
  | {
      readonly kind: "apply-then-prompt";
      readonly apply: readonly SlashApply[];
      readonly snapshot: ComposerSnapshot;
    };

export function splitModeChips(snapshot: ComposerSnapshot): {
  readonly names: readonly string[];
  readonly snapshot: ComposerSnapshot;
} {
  const names: string[] = [];
  const nodes = snapshot.doc.nodes.filter((node) => {
    if (node.type !== "chip" || node.chip.kind !== "mode") return true;
    names.push(node.chip.name ?? node.chip.label.replace(/^\//u, ""));
    return false;
  });
  return { names, snapshot: snapshotFromDoc({ nodes }) };
}

function resolveModeApplies(names: readonly string[]): string[] {
  let mutex: string | undefined;
  const solos: string[] = [];
  for (const name of names) {
    if ((MODE_MUTEX as readonly string[]).includes(name)) mutex = name;
    else if (!solos.includes(name)) solos.push(name);
  }
  return mutex === undefined ? solos : [...solos, mutex];
}

function lookupAvailable(name: string, catalog?: readonly StudioSlashCommand[]): StudioSlashCommand | undefined {
  const command = lookupSlashCommand(name, catalog);
  if (command === undefined || command.availability !== "available") return undefined;
  return command;
}

/**
 * Drop the leading `/{token}` (and one separator) from the first text node.
 * Capsules stay in place so `@path` / `[图N]` are not serialized twice.
 */
export function stripLeadingSlashCommand(snapshot: ComposerSnapshot, commandToken: string): ComposerSnapshot {
  const prefix = `/${commandToken}`;
  const nodes: ComposerSnapshot["doc"]["nodes"][number][] = [];
  let stripped = false;
  for (const node of snapshot.doc.nodes) {
    if (!stripped && node.type === "text") {
      const index = node.value.indexOf(prefix);
      if (index !== -1) {
        const rest = node.value.slice(index + prefix.length).replace(/^[ \t:]+/u, "");
        stripped = true;
        if (rest.length > 0) nodes.push({ type: "text", value: rest });
        continue;
      }
    }
    nodes.push(node);
  }
  return snapshotFromDoc({ nodes });
}

function appliesOf(names: readonly string[], catalog?: readonly StudioSlashCommand[]): SlashApply[] {
  const apply: SlashApply[] = [];
  for (const name of resolveModeApplies(names)) {
    const command = lookupAvailable(name, catalog);
    if (command) apply.push({ command, args: "" });
  }
  return apply;
}

/** Decide whether sending a composer snapshot runs a builtin, applies a mode then prompts, or goes to the LLM. */
export function planComposerSend(snapshot: ComposerSnapshot, catalog?: readonly StudioSlashCommand[]): SlashSendPlan {
  const peeled = splitModeChips(snapshot);
  const trimmed = peeled.snapshot.text.trim();
  const draft = parseSlashDraft(trimmed);
  const command = draft && draft.name.length > 0 ? lookupAvailable(draft.name, catalog) : undefined;
  const chipApplies = appliesOf(peeled.names, catalog);

  if (command !== undefined && draft !== null) {
    if (command.name === "btw") return { kind: "execute", command, args: draft.args };
    if (command.select === "chip") {
      if (isModeControlArgs(command, draft.args)) {
        return { kind: "execute", command, args: draft.args };
      }
      const next = stripLeadingSlashCommand(peeled.snapshot, draft.name);
      const apply = [...chipApplies.filter((item) => item.command.name !== command.name), { command, args: "" }];
      if (snapshotIsEmpty(next)) return { kind: "execute", command, args: "" };
      return { kind: "apply-then-prompt", apply, snapshot: next };
    }

    if (command.select === "native-ui" || command.select === "run-now") {
      if (draft.args.length > 0) return { kind: "prompt", snapshot: peeled.snapshot };
      return { kind: "execute", command, args: "" };
    }

    if (command.select === "complete-args") {
      // `/queue` is text-only on the Runtime command; clipboard images would
      // lose their bytes. Follow-up carries the same AgentSession queue and images.
      if (command.name === "queue" && peeled.snapshot.images.length > 0) {
        return { kind: "follow-up", snapshot: stripLeadingSlashCommand(peeled.snapshot, draft.name) };
      }
      return { kind: "execute", command, args: draft.args };
    }
  }

  if (chipApplies.length > 0) {
    if (snapshotIsEmpty(peeled.snapshot)) {
      const last = chipApplies[chipApplies.length - 1];
      if (last && chipApplies.length === 1) return { kind: "execute", command: last.command, args: "" };
    }
    return { kind: "apply-then-prompt", apply: chipApplies, snapshot: peeled.snapshot };
  }

  return { kind: "prompt", snapshot: peeled.snapshot };
}

/**
 * `/btw`, `/settings`, `/compact` and other slash-only sends. These must not
 * wait on `promptChannelReady`: preview mode has no live prompt channel, and
 * BTW is a side channel that has to run while the main turn is streaming.
 */
export function composerSlashExecute(
  snapshot: ComposerSnapshot,
  catalog?: readonly StudioSlashCommand[],
): Extract<SlashSendPlan, { kind: "execute" }> | undefined {
  const plan = planComposerSend(snapshot, catalog);
  return plan.kind === "execute" ? plan : undefined;
}
