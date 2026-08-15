/**
 * File-backed OMP task-agent definition inventory.
 *
 * Discovery order matches coding-agent `discoverAgents`: project
 * `.omp/agents/*.md`, user `~/.omp/agent/agents/*.md`, extension/plugin
 * `agents/*.md`, then the bundled roster. First name wins. Paths never
 * appear in the public read model.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { parse as parseYaml, parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from "yaml";

import type {
  AgentDefinitionConfigureInput,
  AgentDefinitionDeleteInput,
  AgentDefinitionRecord,
  AgentDefinitionsReadModel,
  AgentDefinitionSource,
  AgentDefinitionUpsertInput,
  AgentThinkingLevel,
  ConfigWriteResult,
} from "@omp-studio/client-contract";

import { parseFrontmatter } from "./omp-discovery/frontmatter.js";
import { listClaudePluginRoots } from "./omp-discovery/helpers.js";
import { getAgentDir, getProjectConfigDir } from "./omp-discovery/paths.js";
import { listOmpPluginRoots, listSettingsExtensionRoots } from "./omp-discovery/plugin-roots.js";
import { redactText, sanitizeDisplayText } from "./read-models.js";
import type { HostAgentDefinitionsService } from "./services.js";

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const NAME_MAX = 64;
const DESC_MAX = 2000;
const PROMPT_MAX = 100_000;
const WARNING_MAX = 240;

const BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "ast_grep",
  "ast_edit",
  "ask",
  "debug",
  "eval",
  "github",
  "glob",
  "grep",
  "lsp",
  "inspect_image",
  "browser",
  "computer",
  "checkpoint",
  "rewind",
  "security_scan",
  "task",
  "hub",
  "todo",
  "web_search",
  "write",
  "memory_edit",
  "retain",
  "recall",
  "reflect",
  "learn",
  "manage_skill",
] as const;

const TOOL_ALIASES: Readonly<Record<string, string>> = {
  search: "grep",
  find: "glob",
};

const ROLE_ALIASES = [
  "@default",
  "@smol",
  "@slow",
  "@vision",
  "@plan",
  "@designer",
  "@commit",
  "@tiny",
  "@task",
  "@advisor",
] as const;

const THINKING_LEVELS = new Set<string>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

const WRITE_OK = (message: string): ConfigWriteResult => ({
  applied: true,
  runtimeEffect: "new-session",
  message,
});

interface BundledAgent {
  readonly name: string;
  readonly description: string;
  readonly tools?: ReadonlyArray<string>;
  readonly spawns?: ReadonlyArray<string> | "*";
  readonly model?: ReadonlyArray<string>;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly readSummarize?: boolean;
}

/** Frontmatter defaults for the seven OMP-embedded task agents. Prompt bodies stay in the runtime. */
const BUNDLED_AGENTS: ReadonlyArray<BundledAgent> = [
  {
    name: "scout",
    description:
      "MUST be used for exploratory codebase research, rapid code analysis, and broad pattern searches. Fast read-only scout returning compressed context for handoff.",
    tools: ["read", "grep", "glob", "web_search"],
    model: ["@smol"],
    thinkingLevel: "medium",
    readSummarize: false,
  },
  {
    name: "designer",
    description: "UI/UX specialist for design implementation, review, visual refinement",
    model: ["@designer"],
  },
  {
    name: "reviewer",
    description: "Code review specialist for quality/security analysis",
    tools: ["read", "grep", "glob", "bash", "lsp", "web_search", "ast_grep"],
    spawns: ["scout"],
    model: ["@slow"],
  },
  {
    name: "security-reviewer",
    description: "Read-only security specialist for evidence-backed repository vulnerability discovery",
    tools: ["read", "grep", "glob", "lsp", "ast_grep"],
  },
  {
    name: "librarian",
    description: "Researches external libraries and APIs by reading source code. Returns definitive, source-verified answers.",
    tools: ["read", "grep", "glob", "bash", "lsp", "web_search", "ast_grep"],
    model: ["@smol"],
    thinkingLevel: "minimal",
    readSummarize: false,
  },
  {
    name: "task",
    description: "General-purpose subagent with full capabilities for delegated multi-step tasks",
    spawns: "*",
    model: ["@task"],
    thinkingLevel: "auto",
  },
  {
    name: "sonic",
    description: "Low-reasoning agent for strictly mechanical updates or data collection only",
    model: ["@smol"],
    thinkingLevel: "medium",
  },
];

const SOURCE_LABEL: Record<AgentDefinitionSource, string> = {
  project: "项目",
  user: "用户",
  bundled: "内置",
  plugin: "插件",
};

interface ParsedAgentFile {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools?: string[];
  readonly spawns?: string[] | "*";
  readonly model?: string[];
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly output?: unknown;
  readonly blocking?: boolean;
  readonly autoloadSkills?: string[];
  readonly readSummarize?: boolean;
  readonly prewalk?: boolean | string;
  readonly error?: string;
  readonly contentHash: string;
}

interface Overlays {
  readonly disabled: ReadonlySet<string>;
  readonly overrideModel: Readonly<Record<string, string>>;
  readonly prewalkOverride: Readonly<Record<string, string>>;
}

export interface OmpAgentDefinitionsAdapterOptions {
  readonly home?: string;
  readonly getCwd?: () => string | undefined;
  readonly cwd?: string;
  readonly now?: () => string;
}

function fail(code: "INVALID_ARGUMENT" | "UNAVAILABLE" | "STATE_VERSION_CONFLICT", message: string): never {
  throw { code, message };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function emptyModel(now: string, reason?: string, projectScopeAvailable = false): AgentDefinitionsReadModel {
  return {
    agents: [],
    warnings: [],
    builtinToolNames: [...BUILTIN_TOOL_NAMES],
    roleAliases: [...ROLE_ALIASES],
    projectScopeAvailable,
    generatedAt: now,
    ...(reason === undefined ? {} : { unavailableReason: reason }),
  };
}

function parseArrayOrCsv(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function normalizeToolNames(names: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const lower = raw.trim().toLowerCase();
    if (!lower) continue;
    const normalized = TOOL_ALIASES[lower] ?? lower;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function parseThinkingLevel(value: unknown): AgentThinkingLevel | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase();
  const mapped = trimmed === "min" ? "minimal" : trimmed;
  return THINKING_LEVELS.has(mapped) ? (mapped as AgentThinkingLevel) : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "true" || trimmed === "yes" || trimmed === "on") return true;
    if (trimmed === "false" || trimmed === "no" || trimmed === "off") return false;
  }
  return undefined;
}

function parseSpawns(value: unknown): string[] | "*" | undefined {
  if (value === "*") return "*";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "*") return "*";
    return parseArrayOrCsv(trimmed);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return undefined;
}

function yamlText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return "";
}

function parseAgentMarkdown(content: string): ParsedAgentFile | undefined {
  const { frontmatter, body } = parseFrontmatter(content);
  const name = yamlText(frontmatter.name);
  const description = yamlText(frontmatter.description);
  if (!name || !description) return undefined;
  let tools = parseArrayOrCsv(frontmatter.tools);
  if (tools) tools = normalizeToolNames(tools);
  if (tools && !tools.includes("yield")) tools = [...tools, "yield"];
  let spawns = parseSpawns(frontmatter.spawns);
  if (spawns === undefined && tools?.includes("task")) spawns = "*";
  const thinkingLevel = parseThinkingLevel(frontmatter.thinkingLevel ?? frontmatter.thinking);
  const model = parseArrayOrCsv(frontmatter.model);
  const blocking = parseBoolean(frontmatter.blocking);
  const readSummarize = parseBoolean(frontmatter.readSummarize);
  let prewalk: boolean | string | undefined = parseBoolean(frontmatter.prewalk);
  if (prewalk === undefined && typeof frontmatter.prewalk === "string") {
    const trimmed = frontmatter.prewalk.trim();
    if (trimmed) prewalk = trimmed;
  }
  const autoloadSkills = parseArrayOrCsv(frontmatter.autoloadSkills);
  return {
    name,
    description,
    systemPrompt: body,
    ...(tools === undefined ? {} : { tools }),
    ...(spawns === undefined ? {} : { spawns }),
    ...(model === undefined ? {} : { model }),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(frontmatter.output === undefined ? {} : { output: frontmatter.output }),
    ...(blocking === undefined ? {} : { blocking }),
    ...(autoloadSkills === undefined ? {} : { autoloadSkills }),
    ...(readSummarize === undefined ? {} : { readSummarize }),
    ...(prewalk === undefined ? {} : { prewalk }),
    contentHash: hashText(content),
  };
}

async function readDirMarkdown(dir: string): Promise<Array<{ file: string; content: string }>> {
  let entries: Array<{ name: string; isFile: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: Array<{ file: string; content: string }> = [];
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    try {
      out.push({ file: file.name, content: await fs.readFile(filePath, "utf8") });
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function sourceLabelOf(source: AgentDefinitionSource): string {
  return SOURCE_LABEL[source];
}

function toRecord(
  parsed: ParsedAgentFile,
  source: AgentDefinitionSource,
  overlays: Overlays,
  packed = false,
): AgentDefinitionRecord {
  const name = sanitizeDisplayText(parsed.name, NAME_MAX) ?? parsed.name.slice(0, NAME_MAX);
  const description = sanitizeDisplayText(parsed.description, DESC_MAX) ?? "";
  const systemPrompt =
    packed || parsed.systemPrompt.length === 0
      ? ""
      : parsed.systemPrompt.length > PROMPT_MAX
        ? `${parsed.systemPrompt.slice(0, PROMPT_MAX).trimEnd()}…`
        : parsed.systemPrompt;
  const editable = source === "user" || source === "project";
  const overrideModel = overlays.overrideModel[name];
  const prewalkOverride = overlays.prewalkOverride[name];
  return {
    name,
    description,
    systemPrompt,
    ...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
    ...(parsed.spawns === undefined ? {} : { spawns: parsed.spawns }),
    ...(parsed.model === undefined ? {} : { model: parsed.model }),
    ...(parsed.thinkingLevel === undefined ? {} : { thinkingLevel: parsed.thinkingLevel }),
    ...(parsed.output === undefined ? {} : { output: parsed.output }),
    ...(parsed.blocking === undefined ? {} : { blocking: parsed.blocking }),
    ...(parsed.autoloadSkills === undefined ? {} : { autoloadSkills: parsed.autoloadSkills }),
    ...(parsed.readSummarize === undefined ? {} : { readSummarize: parsed.readSummarize }),
    ...(parsed.prewalk === undefined ? {} : { prewalk: parsed.prewalk }),
    source,
    sourceLabel: sourceLabelOf(source),
    editable,
    canDelete: editable,
    canFork: !editable,
    disabled: overlays.disabled.has(name),
    ...(overrideModel === undefined ? {} : { overrideModel }),
    ...(prewalkOverride === undefined ? {} : { prewalkOverride }),
    contentHash: parsed.contentHash,
    ...(description.length === 0 ? { error: "缺少 description" } : {}),
    ...(packed ? { promptPacked: true } : {}),
  };
}

function bundledToParsed(agent: BundledAgent): ParsedAgentFile {
  return {
    name: agent.name,
    description: agent.description,
    systemPrompt: "",
    ...(agent.tools === undefined ? {} : { tools: [...agent.tools, "yield"] }),
    ...(agent.spawns === undefined ? {} : { spawns: agent.spawns === "*" ? "*" : [...agent.spawns] }),
    ...(agent.model === undefined ? {} : { model: [...agent.model] }),
    ...(agent.thinkingLevel === undefined ? {} : { thinkingLevel: agent.thinkingLevel }),
    ...(agent.readSummarize === undefined ? {} : { readSummarize: agent.readSummarize }),
    contentHash: hashText(`bundled:${agent.name}`),
  };
}

async function loadConfigOverlays(configPath: string): Promise<Overlays> {
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { disabled: new Set(), overrideModel: {}, prewalkOverride: {} };
  }
  let root: unknown;
  try {
    root = parseYaml(text);
  } catch {
    return { disabled: new Set(), overrideModel: {}, prewalkOverride: {} };
  }
  const record = root && typeof root === "object" && !Array.isArray(root) ? (root as Record<string, unknown>) : {};
  const task = record.task && typeof record.task === "object" && !Array.isArray(record.task)
    ? (record.task as Record<string, unknown>)
    : {};
  const disabled = new Set<string>();
  if (Array.isArray(task.disabledAgents)) {
    for (const item of task.disabledAgents) {
      if (typeof item === "string" && item.trim()) disabled.add(item.trim());
    }
  }
  const overrideModel: Record<string, string> = {};
  if (task.agentModelOverrides && typeof task.agentModelOverrides === "object" && !Array.isArray(task.agentModelOverrides)) {
    for (const [key, value] of Object.entries(task.agentModelOverrides as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) overrideModel[key] = value.trim();
    }
  }
  const prewalkOverride: Record<string, string> = {};
  if (task.agentPrewalk && typeof task.agentPrewalk === "object" && !Array.isArray(task.agentPrewalk)) {
    for (const [key, value] of Object.entries(task.agentPrewalk as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) prewalkOverride[key] = value.trim();
    }
  }
  return { disabled, overrideModel, prewalkOverride };
}

function yamlStringifyScalar(value: string): string {
  if (
    value.length === 0 ||
    /[:{},#&*!|>'"%@`?[\]\\]|^\s|\s$|^(?:true|false|null|yes|no|on|off)$/i.test(value) ||
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

async function mutateTaskConfig(
  configPath: string,
  mutator: (task: YAMLMap) => void,
): Promise<void> {
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const doc = parseDocument(text.length === 0 ? "" : text);
  const existing = doc.get("task", true);
  const task = isMap(existing) ? existing : new YAMLMap();
  if (!isMap(existing)) doc.set("task", task);
  mutator(task);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, String(doc), "utf8");
}

function setYamlStringList(map: YAMLMap, key: string, items: ReadonlyArray<string>): void {
  if (items.length === 0) {
    map.delete(key);
    return;
  }
  const seq = new YAMLSeq();
  for (const item of items) seq.add(item);
  map.set(key, seq);
}

function setYamlStringMap(map: YAMLMap, key: string, record: Readonly<Record<string, string>>): void {
  const keys = Object.keys(record);
  if (keys.length === 0) {
    map.delete(key);
    return;
  }
  const nested = new YAMLMap();
  for (const entry of keys.sort((a, b) => a.localeCompare(b))) {
    nested.set(entry, record[entry]);
  }
  map.set(key, nested);
}

function nodeString(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (node && typeof node === "object" && "value" in node) {
    const value = (node as { value: unknown }).value;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return "";
}

function readYamlStringList(map: YAMLMap, key: string): string[] {
  const value = map.get(key, true);
  if (!isSeq(value)) return [];
  return value.items.map((item) => nodeString(item).trim()).filter(Boolean);
}

function readYamlStringMap(map: YAMLMap, key: string): Record<string, string> {
  const value = map.get(key, true);
  if (!isMap(value)) return {};
  const out: Record<string, string> = {};
  for (const item of value.items) {
    const entryKey = nodeString(item.key);
    const entryValue = nodeString(item.value).trim();
    if (entryKey && entryValue) out[entryKey] = entryValue;
  }
  return out;
}

function serializeAgentMarkdown(input: AgentDefinitionUpsertInput): string {
  const frontmatter: Record<string, unknown> = {
    name: input.name,
    description: input.description,
  };
  if (input.tools && input.tools.length > 0) {
    const tools = normalizeToolNames(input.tools);
    if (!tools.includes("yield")) tools.push("yield");
    frontmatter.tools = tools;
  }
  if (input.spawns === "*") frontmatter.spawns = "*";
  else if (Array.isArray(input.spawns)) frontmatter.spawns = [...input.spawns];
  if (input.model && input.model.length > 0) frontmatter.model = [...input.model];
  if (input.thinkingLevel) frontmatter["thinking-level"] = input.thinkingLevel;
  if (input.blocking === true) frontmatter.blocking = true;
  if (input.readSummarize === false) frontmatter["read-summarize"] = false;
  if (input.readSummarize === true) frontmatter["read-summarize"] = true;
  if (input.prewalk === true) frontmatter.prewalk = true;
  else if (input.prewalk === false) frontmatter.prewalk = false;
  else if (typeof input.prewalk === "string" && input.prewalk.trim()) frontmatter.prewalk = input.prewalk.trim();
  if (input.autoloadSkills && input.autoloadSkills.length > 0) {
    frontmatter.autoloadSkills = [...input.autoloadSkills];
  }
  if (input.output !== undefined && input.output !== null) frontmatter.output = input.output;
  const body = input.systemPrompt.trim();
  return `---\n${stringifyFrontmatter(frontmatter)}---\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
}

function stringifyFrontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = [];
  const dumpValue = (value: unknown, indent: number): string[] => {
    const pad = "  ".repeat(indent);
    if (value === "*") return [`${pad}"*"`];
    if (typeof value === "string") return [`${pad}${yamlStringifyScalar(value)}`];
    if (typeof value === "boolean" || typeof value === "number") return [`${pad}${String(value)}`];
    if (Array.isArray(value)) {
      if (value.length === 0) return [`${pad}[]`];
      return value.flatMap((item) => {
        if (item !== null && typeof item === "object") {
          const nested = dumpValue(item, indent + 1);
          return [`${pad}-`, ...nested.map((line, index) => (index === 0 ? line.replace(/^  /, "    ") : line))];
        }
        return [`${pad}- ${dumpValue(item, 0)[0]?.trim() ?? ""}`];
      });
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.entries(record).flatMap(([key, nested]) => {
        if (nested !== null && typeof nested === "object") {
          return [`${pad}${key}:`, ...dumpValue(nested, indent + 1)];
        }
        return [`${pad}${key}: ${dumpValue(nested, 0)[0]?.trim() ?? ""}`];
      });
    }
    return [`${pad}null`];
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === "object") {
      lines.push(`${key}:`);
      lines.push(...dumpValue(value, 1));
    } else {
      lines.push(`${key}: ${dumpValue(value, 0)[0]?.trim() ?? ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function assertAgentName(name: string): string {
  const trimmed = name.trim();
  if (!AGENT_NAME.test(trimmed)) {
    fail("INVALID_ARGUMENT", "agent name must be 1–64 letters, digits, dot, underscore or hyphen");
  }
  return trimmed;
}

function agentFilePath(dir: string, name: string): string {
  return path.join(dir, `${name}.md`);
}

function resolveCwd(options: OmpAgentDefinitionsAdapterOptions): string | undefined {
  if (options.getCwd) {
    const value = options.getCwd();
    return value && value.trim().length > 0 ? value : undefined;
  }
  return options.cwd;
}

export function createOmpAgentDefinitionsService(
  options: OmpAgentDefinitionsAdapterOptions = {},
): HostAgentDefinitionsService {
  const homeOf = () => options.home ?? homedir();
  const now = options.now ?? (() => new Date().toISOString());

  async function collect(
    home: string,
    cwd: string | undefined,
  ): Promise<{ agents: AgentDefinitionRecord[]; warnings: string[]; overlays: Overlays }> {
    const warnings: string[] = [];
    const seen = new Set<string>();
    const agents: AgentDefinitionRecord[] = [];
    const agentDir = getAgentDir(home);
    const overlays = await loadConfigOverlays(path.join(agentDir, "config.yml"));

    const pushFiles = async (dir: string, source: AgentDefinitionSource) => {
      const files = await readDirMarkdown(dir);
      for (const file of files) {
        const parsed = parseAgentMarkdown(file.content);
        if (!parsed) {
          warnings.push(redactText(sanitizeDisplayText(`无法解析 ${file.file}（缺少 name 或 description）`, WARNING_MAX) ?? "无法解析代理文件"));
          continue;
        }
        if (seen.has(parsed.name)) {
          warnings.push(sanitizeDisplayText(`${parsed.name} 被更高优先级来源覆盖`, WARNING_MAX) ?? parsed.name);
          continue;
        }
        seen.add(parsed.name);
        agents.push(toRecord(parsed, source, overlays));
      }
    };

    if (cwd) await pushFiles(path.join(getProjectConfigDir(cwd), "agents"), "project");
    await pushFiles(path.join(agentDir, "agents"), "user");

    const pluginDirs: string[] = [];
    try {
      if (cwd) {
        for (const ext of await listSettingsExtensionRoots(home, cwd)) {
          pluginDirs.push(path.join(ext.path, "agents"));
        }
      } else {
        for (const ext of await listSettingsExtensionRoots(home, home)) {
          pluginDirs.push(path.join(ext.path, "agents"));
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const { roots } = await listOmpPluginRoots(home, cwd ?? home);
      for (const root of roots) pluginDirs.push(path.join(root.root, "agents"));
    } catch {
      /* ignore */
    }
    try {
      const { roots } = await listClaudePluginRoots(home, cwd);
      for (const root of roots) pluginDirs.push(path.join(root.path, "agents"));
    } catch {
      /* ignore */
    }
    const uniqueDirs = [...new Set(pluginDirs.map((dir) => path.resolve(dir)))];
    for (const dir of uniqueDirs) await pushFiles(dir, "plugin");

    for (const bundled of BUNDLED_AGENTS) {
      if (seen.has(bundled.name)) continue;
      seen.add(bundled.name);
      agents.push(toRecord(bundledToParsed(bundled), "bundled", overlays, true));
    }

    return { agents, warnings, overlays };
  }

  async function resolveScopeDir(scope: "user" | "project"): Promise<string> {
    const home = homeOf();
    if (scope === "user") return path.join(getAgentDir(home), "agents");
    const cwd = resolveCwd(options);
    if (!cwd) fail("UNAVAILABLE", "未打开工作区，无法写入项目级子代理。");
    return path.join(getProjectConfigDir(cwd), "agents");
  }

  return {
    async get(): Promise<AgentDefinitionsReadModel> {
      const generatedAt = now();
      const cwd = resolveCwd(options);
      try {
        const { agents, warnings } = await collect(homeOf(), cwd);
        return {
          agents,
          warnings,
          builtinToolNames: [...BUILTIN_TOOL_NAMES],
          roleAliases: [...ROLE_ALIASES],
          projectScopeAvailable: Boolean(cwd),
          generatedAt,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "agents.definitions.get failed";
        return emptyModel(generatedAt, redactText(message), Boolean(cwd));
      }
    },

    async upsert(input: AgentDefinitionUpsertInput): Promise<ConfigWriteResult> {
      const name = assertAgentName(input.name);
      const description = input.description.trim();
      if (!description) fail("INVALID_ARGUMENT", "description is required");
      if (typeof input.systemPrompt !== "string") fail("INVALID_ARGUMENT", "systemPrompt must be a string");
      const dir = await resolveScopeDir(input.scope);
      const filePath = agentFilePath(dir, name);
      let previous = "";
      try {
        previous = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (input.expectedHash && previous && hashText(previous) !== input.expectedHash) {
        fail("STATE_VERSION_CONFLICT", "agent file changed since it was last read");
      }
      const content = serializeAgentMarkdown({ ...input, name, description });
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      return { ...WRITE_OK("已写入子代理定义。新会话后生效。"), contentHash: hashText(content) };
    },

    async delete(input: AgentDefinitionDeleteInput): Promise<ConfigWriteResult> {
      const name = assertAgentName(input.name);
      const dir = await resolveScopeDir(input.scope);
      const filePath = agentFilePath(dir, name);
      let previous = "";
      try {
        previous = await fs.readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          fail("INVALID_ARGUMENT", `agent ${name} is not a ${input.scope} definition file`);
        }
        throw error;
      }
      if (input.expectedHash && hashText(previous) !== input.expectedHash) {
        fail("STATE_VERSION_CONFLICT", "agent file changed since it was last read");
      }
      await fs.unlink(filePath);
      return WRITE_OK("已删除子代理定义。");
    },

    async configure(input: AgentDefinitionConfigureInput): Promise<ConfigWriteResult> {
      const name = assertAgentName(input.name);
      const home = homeOf();
      const cwd = resolveCwd(options);
      const { agents } = await collect(home, cwd);
      if (!agents.some((agent) => agent.name === name)) {
        fail("INVALID_ARGUMENT", `unknown agent ${name}`);
      }
      const configPath = path.join(getAgentDir(home), "config.yml");
      await mutateTaskConfig(configPath, (task) => {
        if (input.disabled !== undefined) {
          const disabled = new Set(readYamlStringList(task, "disabledAgents"));
          if (input.disabled) disabled.add(name);
          else disabled.delete(name);
          setYamlStringList(task, "disabledAgents", [...disabled].sort((a, b) => a.localeCompare(b)));
        }
        if (input.overrideModel !== undefined) {
          const map = readYamlStringMap(task, "agentModelOverrides");
          if (input.overrideModel === null || input.overrideModel.trim().length === 0) delete map[name];
          else map[name] = input.overrideModel.trim();
          setYamlStringMap(task, "agentModelOverrides", map);
        }
        if (input.prewalkOverride !== undefined) {
          const map = readYamlStringMap(task, "agentPrewalk");
          if (input.prewalkOverride === null || input.prewalkOverride.trim().length === 0) delete map[name];
          else map[name] = input.prewalkOverride.trim();
          setYamlStringMap(task, "agentPrewalk", map);
        }
      });
      return WRITE_OK("已更新子代理会话覆盖。新会话后生效。");
    },
  };
}
