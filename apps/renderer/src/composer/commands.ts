/**
 * Composer `/` is a session-command menu, not a skill picker.
 * Catalog covers OMP builtins; execution prefers typed Studio commands,
 * then operator.invoke, then existing UI. Skills stay out of this list.
 */

import type { CommandName, ThreadId } from "@omp-studio/client-contract";
import type { CommandSource, OperatorCommandManifest, OperatorCommandManifestEntry } from "@omp-studio/studio-protocol";

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
  session: "会话",
  mode: "模式",
  model: "模型",
  context: "上下文",
  capability: "能力",
  workspace: "工作区",
  collab: "协作",
  help: "帮助",
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

function manifestDisabledReason(entry: OperatorCommandManifestEntry, metadata: StudioSlashCommand | undefined): string | undefined {
  if (entry.presentation === "terminal" && !hasLocalSlashMapping(metadata)) return "此指令需要终端交互，暂不能在 Studio 中执行";
  if (entry.availability === "available") return undefined;
  return entry.availability === "blocked" ? "Runtime 已阻止此指令" : "Runtime 已禁用此指令";
}

/**
 * Project the Runtime operator manifest into the slash-command presentation.
 *
 * An omitted manifest is the compatibility path used by preview/legacy callers
 * and returns the existing static catalog. Once a manifest is supplied, it is
 * the complete Runtime set: static entries may only enrich a matching row
 * (native UI, typed mapping, group, and argument hints), never add a command.
 */
export function mergeSlashCatalogWithManifest(manifest?: OperatorCommandManifest): StudioSlashCommand[] {
  if (manifest === undefined) return visibleSlashCatalog();

  return manifest.commands.map((entry) => {
    const metadata = BUILTIN_SLASH_CATALOG.find((command) => manifestMatchesStatic(entry, command));
    const schemaAllowsArgs = manifestAllowsArgs(entry);
    const allowArgs = metadata?.allowArgs === true || schemaAllowsArgs;
    const localSelect = metadata?.select === "native-ui" || metadata?.typed !== undefined
      ? metadata.select
      : undefined;
    const select = localSelect ?? (allowArgs ? "complete-args" : "run-now");
    const aliases = [...new Set(entry.aliases.map(bareSlashName).filter((alias) => alias.length > 0))];
    const name = bareSlashName(entry.name);
    const disabledReason = manifestDisabledReason(entry, metadata);
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
  cmd("help", "列出可用指令", "help", { select: "native-ui", ui: "command-palette" }),
  cmd("model", "切换本会话模型", "model", {
    aliases: ["models"],
    select: "native-ui",
    ui: "model-picker",
    invokeId: "builtin.model",
  }),
  cmd("switch", "打开模型选择（临时）", "model", { select: "native-ui", ui: "model-picker" }),
  cmd("fast", "切换优先服务档位", "mode", {
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
  cmd("prewalk", "下一步编辑改用便宜模型", "mode", {
    select: "chip",
    typed: { name: "session.prewalk.arm" },
    invokeId: "builtin.prewalk",
  }),
  cmd("plan", "切换 Plan 模式", "mode", {
    allowArgs: true,
    hint: "[prompt]",
    select: "chip",
    typed: { name: "mode.plan.enter", fromArgs: (args) => (args ? { initialPrompt: args } : {}) },
  }),
  cmd("plan-review", "重新打开计划评审", "mode", {
    select: "native-ui",
    ui: "plan-review",
    typed: { name: "mode.plan.review.open" },
  }),
  cmd("vibe", "切换 Vibe 模式", "mode", {
    allowArgs: true,
    hint: "[prompt]",
    select: "chip",
    typed: { name: "mode.vibe.enter", fromArgs: (args) => (args ? { initialPrompt: args } : {}) },
  }),
  cmd("goal", "目标模式", "mode", {
    allowArgs: true,
    hint: "[objective]",
    subcommands: [
      { name: "set", description: "设置目标", usage: "<objective>" },
      { name: "show", description: "查看当前目标" },
      { name: "pause", description: "暂停目标" },
      { name: "resume", description: "恢复目标" },
      { name: "drop", description: "丢弃目标" },
      { name: "budget", description: "调整 token 预算", usage: "<N|off>" },
    ],
    select: "chip",
    typed: { name: "goal.create", fromArgs: (args) => ({ objective: args || "Continue current work" }) },
  }),
  cmd("guided-goal", "访谈后进入目标模式", "mode", {
    select: "run-now",
    typed: { name: "goal.guided.start" },
  }),
  cmd("loop", "循环重提下一条消息", "mode", {
    allowArgs: true,
    hint: "[count|duration] [prompt]",
    select: "chip",
    typed: { name: "loop.enable", fromArgs: (args) => (args ? { prompt: args } : {}) },
  }),
  cmd("queue", "排队到本轮结束后发送", "session", {
    allowArgs: true,
    hint: "<message>",
    select: "complete-args",
    typed: { name: "queue.enqueue", fromArgs: (args) => ({ text: args }) },
  }),
  cmd("settings", "打开设置", "help", { select: "native-ui", ui: "settings" }),
  cmd("setup", "打开供应商配置", "capability", { aliases: ["providers"], select: "native-ui", ui: "model-config" }),
  cmd("login", "登录供应商", "capability", { select: "native-ui", ui: "model-config" }),
  cmd("logout", "登出供应商", "capability", { select: "native-ui", ui: "model-config" }),
  cmd("compact", "压缩当前会话上下文", "context", {
    allowArgs: true,
    hint: "[soft|remote|snapcompact] [focus]",
    subcommands: [
      { name: "soft", description: "软压缩", usage: "[focus]" },
      { name: "remote", description: "远程压缩", usage: "[focus]" },
      { name: "snapcompact", description: "快照压缩" },
    ],
    select: "complete-args",
    invokeId: "builtin.compact",
  }),
  cmd("shake", "丢掉沉重的工具结果", "context", {
    allowArgs: true,
    hint: "[elide|images]",
    subcommands: [
      { name: "elide", description: "去掉工具结果和大块" },
      { name: "images", description: "去掉图片块" },
    ],
    select: "complete-args",
    invokeId: "builtin.shake",
  }),
  cmd("fresh", "重置供应商流，保留本地记录", "context", { select: "run-now", invokeId: "builtin.fresh" }),
  cmd("clear", "清空上下文，保留会话", "context", {
    select: "run-now",
    risk: "destructive",
    typed: { name: "session.clearContext" },
  }),
  cmd("drop", "删除当前会话并开新会话", "session", {
    select: "run-now",
    risk: "destructive",
    typed: { name: "session.drop" },
  }),
  cmd("new", "开始新会话", "session", { select: "native-ui", ui: "new-chat" }),
  cmd("rename", "重命名当前会话", "session", { allowArgs: true, hint: "<title>", select: "complete-args", invokeId: "builtin.rename" }),
  cmd("handoff", "交接上下文到新会话", "session", {
    select: "run-now",
    typed: { name: "session.handoff" },
  }),
  cmd("resume", "切换到另一会话", "session", { select: "native-ui", ui: "history" }),
  cmd("retry", "重试上一轮失败", "session", { select: "run-now", typed: { name: "turn.retry" } }),
  cmd("fork", "从先前消息分叉", "session", { select: "run-now", typed: { name: "session.fork" } }),
  cmd("branch", "从先前消息建分支", "session", { select: "native-ui", ui: "user-message-branch" }),
  cmd("tree", "打开会话树", "session", { select: "native-ui", ui: "session-tree" }),
  cmd("session", "会话信息 / 删除 / 固定账号", "session", {
    allowArgs: true,
    hint: "[info|delete|pin]",
    subcommands: [
      { name: "info", description: "会话信息" },
      { name: "delete", description: "删除当前会话" },
      { name: "pin", description: "固定 OAuth 账号", usage: "[account]" },
    ],
    select: "complete-args",
    invokeId: "builtin.session",
    risk: "sensitive",
  }),
  cmd("pause", "暂停 Runtime", "session", { select: "run-now", typed: { name: "runtime.pause" } }),
  cmd("btw", "旁路问一句", "session", { allowArgs: true, hint: "<question>", select: "complete-args", typed: { name: "btw.ask", fromArgs: (args) => ({ question: args }) } }),
  cmd("tan", "后台旁路代理", "session", { allowArgs: true, hint: "<work>", select: "complete-args", typed: { name: "tan.start", fromArgs: (args) => ({ work: args }) } }),
  cmd("omfg", "生成 TTSR 规则", "session", { allowArgs: true, hint: "<complaint>", select: "complete-args", typed: { name: "omfg.generate", fromArgs: (args) => ({ complaint: args }) } }),
  cmd("computer", "本会话 computer-use", "mode", {
    allowArgs: true,
    hint: "[on|off|status]",
    subcommands: onOffStatus("computer use"),
    select: "complete-args",
    invokeId: "builtin.computer",
  }),
  cmd("vision", "本会话 inspect_image", "mode", {
    allowArgs: true,
    hint: "[on|off|auto|status]",
    subcommands: [
      { name: "on", description: "始终暴露 inspect_image" },
      { name: "off", description: "隐藏 inspect_image" },
      { name: "auto", description: "跟随设置" },
      { name: "status", description: "查看状态" },
    ],
    select: "complete-args",
    invokeId: "builtin.vision",
  }),
  cmd("advisor", "第二模型顾问", "mode", {
    allowArgs: true,
    hint: "[on|off|status|dump|configure]",
    subcommands: [
      { name: "on", description: "启用顾问" },
      { name: "off", description: "关闭顾问" },
      { name: "status", description: "顾问状态" },
      { name: "dump", description: "复制顾问记录", usage: "[raw]" },
      { name: "configure", description: "配置顾问" },
    ],
    select: "complete-args",
    invokeId: "builtin.advisor",
  }),
  cmd("mcp", "管理 MCP 服务器", "capability", {
    select: "native-ui",
    ui: "capabilities-mcp",
    invokeId: "builtin.mcp",
  }),
  cmd("plugins", "列出或开关插件", "capability", {
    select: "native-ui",
    ui: "capabilities-plugins",
    invokeId: "builtin.plugins",
  }),
  cmd("marketplace", "插件市场", "capability", { select: "native-ui", ui: "capabilities-plugins", invokeId: "builtin.marketplace" }),
  cmd("reload-plugins", "重载技能 / 指令 / MCP", "capability", { select: "run-now", invokeId: "builtin.reload-plugins" }),
  cmd("extensions", "扩展控制台", "capability", { aliases: ["status"], select: "native-ui", ui: "capabilities-slash" }),
  cmd("agents", "打开 Agent Hub", "capability", { select: "native-ui", ui: "agent-hub" }),
  cmd("tools", "列出活动工具", "capability", { select: "run-now", invokeId: "builtin.tools" }),
  cmd("jobs", "后台任务", "capability", { select: "run-now", invokeId: "builtin.jobs" }),
  cmd("usage", "供应商用量", "help", { select: "run-now", invokeId: "builtin.usage" }),
  cmd("stats", "打开用量看板", "help", { select: "run-now", invokeId: "builtin.stats" }),
  cmd("context", "上下文占用", "context", { select: "run-now", invokeId: "builtin.context" }),
  cmd("changelog", "更新说明", "help", { select: "run-now", invokeId: "builtin.changelog" }),
  cmd("hotkeys", "打开命令面板", "help", { select: "native-ui", ui: "command-palette" }),
  cmd("todo", "待办列表", "session", { allowArgs: true, hint: "<subcommand>", select: "complete-args", invokeId: "builtin.todo" }),
  cmd("memory", "记忆后端", "context", {
    allowArgs: true,
    hint: "<subcommand>",
    subcommands: [
      { name: "view", description: "查看注入内容" },
      { name: "stats", description: "后端统计" },
      { name: "diagnose", description: "诊断" },
      { name: "clear", description: "清空记忆" },
      { name: "reset", description: "clear 的别名" },
      { name: "enqueue", description: "排队整理" },
      { name: "rebuild", description: "enqueue 的别名" },
    ],
    select: "complete-args",
    invokeId: "builtin.memory",
    risk: "sensitive",
  }),
  cmd("export", "导出会话 HTML", "session", { select: "run-now", invokeId: "builtin.export" }),
  cmd("dump", "导出完整记录", "session", { select: "run-now", invokeId: "builtin.dump" }),
  cmd("copy", "从对话复制", "session", { allowArgs: true, hint: "[code|cmd]", availability: "disabled", disabledReason: "复制（暂未实现）", select: "run-now" }),
  cmd("debug", "调试工具", "help", { availability: "disabled", disabledReason: "调试（暂未实现）", select: "run-now" }),
  cmd("security", "安全扫描", "capability", { allowArgs: true, hint: "<subcommand>", select: "complete-args", invokeId: "builtin.security" }),
  cmd("ssh", "SSH 主机", "workspace", { allowArgs: true, hint: "<subcommand>", select: "complete-args", invokeId: "builtin.ssh" }),
  cmd("move", "移动会话工作目录", "workspace", { allowArgs: true, hint: "[<path>]", select: "complete-args", invokeId: "builtin.move" }),
  cmd("add-dir", "加入工作区根目录", "workspace", { allowArgs: true, hint: "<path>", select: "complete-args", invokeId: "builtin.add-dir" }),
  cmd("remove-dir", "移除工作区根目录", "workspace", { allowArgs: true, hint: "<path>", select: "complete-args", invokeId: "builtin.remove-dir" }),
  cmd("dirs", "列出工作区目录", "workspace", { select: "run-now", invokeId: "builtin.dirs" }),
  cmd("force", "下一轮强制使用指定工具", "mode", { aliases: ["force:"], allowArgs: true, hint: "<tool-name> [prompt]", select: "complete-args", invokeId: "builtin.force" }),
  cmd("share", "生成分享链接", "collab", { select: "run-now", invokeId: "builtin.share" }),
  cmd("collab", "实时协作", "collab", { allowArgs: true, hint: "[start|view|stop|status]", availability: "disabled", disabledReason: "协作（暂未实现）", select: "complete-args" }),
  cmd("join", "加入协作", "collab", { allowArgs: true, hint: "<link>", availability: "disabled", disabledReason: "协作（暂未实现）", select: "complete-args" }),
  cmd("leave", "离开协作", "collab", { availability: "disabled", disabledReason: "协作（暂未实现）", select: "run-now" }),
  cmd("browser", "浏览器可见性", "capability", { allowArgs: true, hint: "[headless|visible]", select: "complete-args", invokeId: "builtin.browser" }),
  cmd("live", "实时语音", "collab", { availability: "hidden", select: "run-now" }),
  cmd("quit", "退出应用", "help", { aliases: ["q"], availability: "hidden", select: "run-now" }),
  cmd("exit", "退出应用", "help", { availability: "hidden", select: "run-now" }),
];

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
  if (catalog === undefined) return CATALOG_BY_NAME.get(key);
  return catalog.find((command) => [command.name, ...command.aliases].some((candidate) => normalizedSlashName(candidate) === key));
}

export function visibleSlashCatalog(): StudioSlashCommand[] {
  return BUILTIN_SLASH_CATALOG.filter((command) => command.availability !== "hidden");
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
  if (command.typed && (trimmed || command.typed.fromArgs === undefined)) {
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
      return { ok: false, error: "没有当前会话，无法执行 /drop" };
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
