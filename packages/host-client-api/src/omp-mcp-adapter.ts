/**
 * File-backed configured MCP server inventory.
 *
 * Mirrors OMP `loadCapability("mcps")` providers: native, omp-plugins, claude,
 * agent-plugins, claude-plugins, codex, gemini, opencode, cursor, windsurf,
 * vscode, mcp-json. Applies user-level disabledServers / enabledServers.
 * Never returns command/url/secret fields. Not MCPManager connection state.
 */

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import type {
  ConfigWriteResult,
  McpConfigStatus,
  McpReadModel,
  McpServerRecord,
  McpTransport,
} from "@omp-studio/client-contract";

import { classifyAgentPluginRoot } from "./omp-discovery/agent-plugin.js";
import { listClaudePluginRoots, type ClaudePluginRoot } from "./omp-discovery/helpers.js";
import { getAgentDir, getProjectConfigDir } from "./omp-discovery/paths.js";
import { listOmpPluginRoots, listSettingsExtensionRoots } from "./omp-discovery/plugin-roots.js";
import { sanitizeDisplayText } from "./read-models.js";
import type { HostMcpService } from "./services.js";

const NAME_MAX = 80;
const WARNING_MAX = 240;
const MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._:.-]{0,99}$/;
const AGENT_PLUGIN_MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/**
 * Lower rank wins. Encodes OMP provider priority (higher first) plus
 * within-provider order (project-before-user except OpenCode, which pushes user first).
 */
const RANK = {
  nativeProject: 10,
  nativeProjectDot: 11,
  nativeUser: 12,
  nativeUserDot: 13,
  ompPlugins: 20,
  claudeProject: 30,
  claudeUser: 31,
  agentPlugins: 40,
  claudePlugins: 50,
  codexProject: 51,
  codexUser: 52,
  geminiProject: 60,
  geminiUser: 61,
  opencodeUser: 70,
  opencodeProject: 71,
  cursorProject: 80,
  cursorUser: 81,
  windsurfProject: 82,
  windsurfUser: 83,
  vscode: 90,
  mcpJson: 100,
  mcpDotJson: 101,
} as const;

const WRITE_OK = (message: string): ConfigWriteResult => ({
  applied: true,
  runtimeEffect: "new-session",
  message,
});

export interface OmpMcpAdapterOptions {
  readonly home?: string;
  readonly getCwd?: () => string | undefined;
  readonly now?: () => string;
}

interface McpConfigFile {
  $schema?: string;
  mcpServers?: Record<string, McpServerEntry>;
  disabledServers?: string[];
  enabledServers?: string[];
}

interface McpServerEntry {
  enabled?: boolean;
  type?: string;
  transport?: string;
  command?: unknown;
  url?: unknown;
}

interface InternalServer {
  readonly name: string;
  readonly transport: McpTransport;
  readonly entryEnabled: boolean;
  readonly scope: "user" | "project";
  readonly sourceLabel: string;
  readonly sourcePath: string;
  readonly rank: number;
  readonly seq: number;
  readonly writableNative: boolean;
  shadowed: boolean;
}

function emptyModel(now: string, reason?: string): McpReadModel {
  return {
    servers: [],
    warnings: [],
    generatedAt: now,
    ...(reason === undefined ? {} : { unavailableReason: reason }),
  };
}

function safeName(value: string): string | undefined {
  const trimmed = value.trim();
  if (!MCP_NAME.test(trimmed)) return undefined;
  return sanitizeDisplayText(trimmed, NAME_MAX) ?? undefined;
}

function inferTransport(entry: McpServerEntry): McpTransport {
  const raw = entry.type ?? entry.transport;
  if (raw === "http" || raw === "sse" || raw === "stdio") return raw;
  if (raw === "streamable-http" || raw === "remote") return "http";
  if (raw === "local") return "stdio";
  if (typeof entry.url === "string" && entry.url.trim().length > 0) return "http";
  return "stdio";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return null;
    throw error;
  }
}

async function readJsonValue(filePath: string): Promise<unknown | null> {
  const text = await readTextFile(filePath);
  if (text === null) return null;
  return JSON.parse(text) as unknown;
}

async function readJsonFile(filePath: string): Promise<McpConfigFile | null> {
  const parsed = await readJsonValue(filePath);
  const record = asRecord(parsed);
  return record ? (record as McpConfigFile) : null;
}

async function writeJsonFile(filePath: string, config: McpConfigFile): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(config, null, 2);
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8" });
    await fs.rename(tmp, filePath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function listFromMap(
  filePath: string,
  map: Record<string, unknown>,
  scope: "user" | "project",
  sourceLabel: string,
  rank: number,
  writableNative: boolean,
  warnings: string[],
  seq: { n: number },
  options?: { requireEndpoint?: boolean; namePrefix?: string },
): InternalServer[] {
  const servers: InternalServer[] = [];
  for (const [rawName, rawEntry] of Object.entries(map)) {
    const base = safeName(rawName);
    if (base === undefined) {
      warnings.push(sanitizeDisplayText(`跳过无效 MCP 名称`, WARNING_MAX) ?? "跳过无效 MCP 名称");
      continue;
    }
    const name = options?.namePrefix ? safeName(`${options.namePrefix}:${base}`) : base;
    if (name === undefined) {
      warnings.push(sanitizeDisplayText(`跳过无效 MCP 名称`, WARNING_MAX) ?? "跳过无效 MCP 名称");
      continue;
    }
    const entry = asRecord(rawEntry);
    if (!entry) {
      warnings.push(sanitizeDisplayText(`MCP "${name}" 配置无效`, WARNING_MAX) ?? `MCP "${name}" 配置无效`);
      continue;
    }
    if (options?.requireEndpoint && typeof entry.command !== "string" && typeof entry.url !== "string") {
      continue;
    }
    const mapped: McpServerEntry = {};
    if (typeof entry.enabled === "boolean") mapped.enabled = entry.enabled;
    if (typeof entry.type === "string") mapped.type = entry.type;
    if (typeof entry.transport === "string") mapped.transport = entry.transport;
    if (entry.command !== undefined) mapped.command = entry.command;
    if (entry.url !== undefined) mapped.url = entry.url;
    seq.n += 1;
    servers.push({
      name,
      transport: inferTransport(mapped),
      entryEnabled: mapped.enabled !== false,
      scope,
      sourceLabel,
      sourcePath: filePath,
      rank,
      seq: seq.n,
      writableNative,
      shadowed: false,
    });
  }
  return servers;
}

async function loadJsonSource(
  filePath: string,
  scope: "user" | "project",
  sourceLabel: string,
  rank: number,
  writableNative: boolean,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  try {
    const config = await readJsonFile(filePath);
    if (!config?.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) {
      return [];
    }
    return listFromMap(filePath, config.mcpServers, scope, sourceLabel, rank, writableNative, warnings, seq);
  } catch (error) {
    warnings.push(
      sanitizeDisplayText(`读取 ${sourceLabel} MCP 配置失败: ${String(error)}`, WARNING_MAX) ??
        `读取 ${sourceLabel} MCP 配置失败`,
    );
    return [];
  }
}

/** Claude: first file that actually yields servers wins per scope. */
async function loadFirstHit(
  paths: readonly string[],
  scope: "user" | "project",
  sourceLabel: string,
  rank: number,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  for (const filePath of paths) {
    const items = await loadJsonSource(filePath, scope, sourceLabel, rank, false, warnings, seq);
    if (items.length > 0) return items;
  }
  return [];
}

function parseTomlValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    const items: string[] = [];
    let buf = "";
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]!;
      if (quote) {
        if (ch === quote) quote = null;
        buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        buf += ch;
        continue;
      }
      if (ch === ",") {
        items.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim()) items.push(buf.trim());
    return items.map((item) => {
      const parsed = parseTomlValue(item);
      return typeof parsed === "string" ? parsed : String(parsed);
    });
  }
  return value;
}

function listFromCodexToml(
  filePath: string,
  text: string,
  scope: "user" | "project",
  rank: number,
  warnings: string[],
  seq: { n: number },
): InternalServer[] {
  const tables = new Map<string, Record<string, unknown>>();
  let current: string | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      current = header[1] ?? null;
      if (current && !tables.has(current)) tables.set(current, {});
      continue;
    }
    if (!current || !current.startsWith("mcp_servers.")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const table = tables.get(current);
    if (table) table[key] = parseTomlValue(line.slice(eq + 1));
  }

  const map: Record<string, unknown> = {};
  for (const [tableName, fields] of tables) {
    const match = /^mcp_servers\.([^.\]]+)$/.exec(tableName);
    if (!match?.[1]) continue;
    map[match[1]] = fields;
  }
  return listFromMap(filePath, map, scope, "Codex", rank, false, warnings, seq);
}

async function loadCodexSource(
  filePath: string,
  scope: "user" | "project",
  rank: number,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  try {
    const text = await readTextFile(filePath);
    if (text === null) return [];
    return listFromCodexToml(filePath, text, scope, rank, warnings, seq);
  } catch (error) {
    warnings.push(
      sanitizeDisplayText(`读取 Codex MCP 配置失败: ${String(error)}`, WARNING_MAX) ?? "读取 Codex MCP 配置失败",
    );
    return [];
  }
}

async function loadOpenCodeSource(
  filePath: string,
  scope: "user" | "project",
  rank: number,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  try {
    const parsed = asRecord(await readJsonValue(filePath));
    const mcp = parsed ? asRecord(parsed.mcp) : undefined;
    if (!mcp) return [];
    return listFromMap(filePath, mcp, scope, "OpenCode", rank, false, warnings, seq);
  } catch (error) {
    warnings.push(
      sanitizeDisplayText(`读取 OpenCode MCP 配置失败: ${String(error)}`, WARNING_MAX) ?? "读取 OpenCode MCP 配置失败",
    );
    return [];
  }
}

async function loadVsCodeSource(
  filePath: string,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  try {
    const parsed = asRecord(await readJsonValue(filePath));
    const mcp = parsed ? asRecord(parsed.mcp) : undefined;
    const servers = mcp ? asRecord(mcp.servers) : undefined;
    if (!servers) return [];
    return listFromMap(filePath, servers, "project", "VS Code", RANK.vscode, false, warnings, seq);
  } catch (error) {
    warnings.push(
      sanitizeDisplayText(`读取 VS Code MCP 配置失败: ${String(error)}`, WARNING_MAX) ?? "读取 VS Code MCP 配置失败",
    );
    return [];
  }
}

/** OMP: Agent Plugins roots keep MCP exclusive to the agent-plugins provider. */
async function legacyMcpAllowed(rootPath: string): Promise<boolean> {
  const status = await classifyAgentPluginRoot(rootPath);
  return status.kind === "none";
}

async function readPluginManifestName(rootPath: string): Promise<string | undefined> {
  try {
    const parsed = asRecord(await readJsonValue(path.join(rootPath, "plugin.json")));
    return typeof parsed?.name === "string" ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

async function loadOmpPluginMcp(
  rootPath: string,
  scope: "user" | "project",
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  if (!(await legacyMcpAllowed(rootPath))) return [];
  const items: InternalServer[] = [];
  for (const filename of [".mcp.json", "mcp.json"] as const) {
    const filePath = path.join(rootPath, filename);
    try {
      const config = await readJsonFile(filePath);
      if (!config?.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)) continue;
      items.push(
        ...listFromMap(filePath, config.mcpServers, scope, "插件", RANK.ompPlugins, false, warnings, seq, {
          requireEndpoint: true,
        }),
      );
    } catch (error) {
      warnings.push(
        sanitizeDisplayText(`读取插件 MCP 配置失败: ${String(error)}`, WARNING_MAX) ?? "读取插件 MCP 配置失败",
      );
    }
  }
  return items;
}

async function loadAgentPluginMcp(
  rootPath: string,
  scope: "user" | "project",
  fallbackName: string,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  const status = await classifyAgentPluginRoot(rootPath);
  if (status.kind !== "standard") return [];
  const pluginName = (await readPluginManifestName(rootPath)) ?? fallbackName;
  const filePath = path.join(rootPath, "mcp.json");
  try {
    const parsed = asRecord(await readJsonValue(filePath));
    if (!parsed) return [];
    if (parsed.$schema !== AGENT_PLUGIN_MCP_SCHEMA) return [];
    const servers = asRecord(parsed.mcpServers);
    if (!servers) return [];
    const kept: Record<string, unknown> = {};
    for (const [name, raw] of Object.entries(servers)) {
      const entry = asRecord(raw);
      if (!entry) continue;
      if (entry.type !== "stdio" && entry.type !== "streamable-http" && entry.type !== "sse") continue;
      kept[name] = entry;
    }
    return listFromMap(filePath, kept, scope, "Agent Plugin", RANK.agentPlugins, false, warnings, seq, {
      requireEndpoint: true,
      namePrefix: pluginName,
    });
  } catch (error) {
    warnings.push(
      sanitizeDisplayText(`读取 Agent Plugin MCP 配置失败: ${String(error)}`, WARNING_MAX) ??
        "读取 Agent Plugin MCP 配置失败",
    );
    return [];
  }
}

function extractClaudePluginServerMap(obj: Record<string, unknown>): Record<string, unknown> | null {
  if (asRecord(obj.mcpServers)) return asRecord(obj.mcpServers) ?? null;
  if (!("mcpServers" in obj)) return obj;
  return null;
}

async function resolveClaudePluginMcp(root: ClaudePluginRoot): Promise<{
  map: Record<string, unknown> | null;
  sourcePath: string;
}> {
  for (const manifestDir of [".omp-plugin", ".claude-plugin"] as const) {
    const manifestPath = path.join(root.path, manifestDir, "plugin.json");
    const parsed = asRecord(await readJsonValue(manifestPath).catch(() => null));
    if (!parsed) continue;
    const pointer = parsed.mcpServers;
    const inline = asRecord(pointer);
    if (inline) return { map: inline, sourcePath: manifestPath };
    if (typeof pointer === "string" && pointer.trim().length > 0) {
      const resolved = path.resolve(root.path, pointer.trim());
      if (!isWithinRoot(root.path, resolved)) return { map: null, sourcePath: manifestPath };
      const fileObj = asRecord(await readJsonValue(resolved).catch(() => null));
      if (!fileObj) return { map: null, sourcePath: resolved };
      return { map: extractClaudePluginServerMap(fileObj), sourcePath: resolved };
    }
  }
  const fallback = path.join(root.path, ".mcp.json");
  const fileObj = asRecord(await readJsonValue(fallback).catch(() => null));
  if (!fileObj) return { map: null, sourcePath: fallback };
  return { map: extractClaudePluginServerMap(fileObj), sourcePath: fallback };
}

async function loadClaudePluginMcp(
  root: ClaudePluginRoot,
  warnings: string[],
  seq: { n: number },
): Promise<InternalServer[]> {
  if (!(await legacyMcpAllowed(root.path))) return [];
  const resolved = await resolveClaudePluginMcp(root);
  if (!resolved.map) return [];
  return listFromMap(
    resolved.sourcePath,
    resolved.map,
    root.scope,
    "Claude 插件",
    RANK.claudePlugins,
    false,
    warnings,
    seq,
    { requireEndpoint: true, namePrefix: root.plugin },
  );
}

function markShadowed(servers: InternalServer[]): void {
  const best = new Map<string, InternalServer>();
  const ordered = [...servers].sort((a, b) => a.rank - b.rank || a.seq - b.seq);
  for (const server of ordered) {
    const winner = best.get(server.name);
    if (winner === undefined) {
      best.set(server.name, server);
      continue;
    }
    if (server.rank < winner.rank || (server.rank === winner.rank && server.seq < winner.seq)) {
      winner.shadowed = true;
      best.set(server.name, server);
    } else {
      server.shadowed = true;
    }
  }
}

function toRecord(
  server: InternalServer,
  disabled: ReadonlySet<string>,
  forced: ReadonlySet<string>,
): McpServerRecord {
  const sourceSaysDisabled = !server.entryEnabled && !forced.has(server.name);
  const denied = disabled.has(server.name);
  let status: McpConfigStatus;
  if (server.shadowed) status = "shadowed";
  else if (denied || sourceSaysDisabled) status = "disabled";
  else status = "enabled";
  return {
    name: server.name,
    transport: server.transport,
    enabled: status === "enabled",
    status,
    sourceLabel: server.sourceLabel,
    scope: server.scope,
  };
}

export function createOmpMcpService(options: OmpMcpAdapterOptions = {}): HostMcpService {
  const home = options.home ?? homedir();
  const now = options.now ?? (() => new Date().toISOString());
  const getCwd = options.getCwd ?? (() => undefined);

  const userNativePath = () => path.join(getAgentDir(home), "mcp.json");

  const collect = async (): Promise<{
    servers: InternalServer[];
    warnings: string[];
    disabled: Set<string>;
    forced: Set<string>;
    userFile: string;
    projectFile: string | undefined;
  }> => {
    const warnings: string[] = [];
    const servers: InternalServer[] = [];
    const seq = { n: 0 };
    const userFile = userNativePath();
    const cwd = getCwd()?.trim() || undefined;
    const projectFile = cwd ? path.join(getProjectConfigDir(cwd), "mcp.json") : undefined;
    const scanCwd = cwd ?? home;

    const userConfig = await readJsonFile(userFile).catch((error) => {
      warnings.push(
        sanitizeDisplayText(`读取用户 MCP 配置失败: ${String(error)}`, WARNING_MAX) ?? "读取用户 MCP 配置失败",
      );
      return null;
    });
    if (userConfig?.mcpServers && typeof userConfig.mcpServers === "object" && !Array.isArray(userConfig.mcpServers)) {
      servers.push(
        ...listFromMap(userFile, userConfig.mcpServers, "user", "用户", RANK.nativeUser, true, warnings, seq),
      );
    }
    servers.push(
      ...(await loadJsonSource(
        path.join(getAgentDir(home), ".mcp.json"),
        "user",
        "用户",
        RANK.nativeUserDot,
        true,
        warnings,
        seq,
      )),
    );

    if (cwd && projectFile) {
      servers.push(
        ...(await loadJsonSource(projectFile, "project", "项目", RANK.nativeProject, true, warnings, seq)),
      );
      servers.push(
        ...(await loadJsonSource(
          path.join(getProjectConfigDir(cwd), ".mcp.json"),
          "project",
          "项目",
          RANK.nativeProjectDot,
          true,
          warnings,
          seq,
        )),
      );
      const projectMcp = path.join(cwd, "mcp.json");
      const projectDotMcp = path.join(cwd, ".mcp.json");
      if (path.resolve(projectMcp) !== path.resolve(projectFile)) {
        servers.push(...(await loadJsonSource(projectMcp, "project", "项目", RANK.mcpJson, true, warnings, seq)));
      }
      servers.push(...(await loadJsonSource(projectDotMcp, "project", "项目", RANK.mcpDotJson, true, warnings, seq)));

      servers.push(
        ...(await loadFirstHit(
          [path.join(cwd, ".claude", ".mcp.json"), path.join(cwd, ".claude", "mcp.json")],
          "project",
          "Claude",
          RANK.claudeProject,
          warnings,
          seq,
        )),
      );
      servers.push(
        ...(await loadCodexSource(path.join(cwd, ".codex", "config.toml"), "project", RANK.codexProject, warnings, seq)),
      );
      servers.push(
        ...(await loadJsonSource(
          path.join(cwd, ".gemini", "settings.json"),
          "project",
          "Gemini",
          RANK.geminiProject,
          false,
          warnings,
          seq,
        )),
      );
      servers.push(
        ...(await loadOpenCodeSource(path.join(cwd, "opencode.json"), "project", RANK.opencodeProject, warnings, seq)),
      );
      servers.push(
        ...(await loadJsonSource(
          path.join(cwd, ".cursor", "mcp.json"),
          "project",
          "Cursor",
          RANK.cursorProject,
          false,
          warnings,
          seq,
        )),
      );
      servers.push(
        ...(await loadJsonSource(
          path.join(cwd, ".windsurf", "mcp_config.json"),
          "project",
          "Windsurf",
          RANK.windsurfProject,
          false,
          warnings,
          seq,
        )),
      );
      servers.push(...(await loadVsCodeSource(path.join(cwd, ".vscode", "mcp.json"), warnings, seq)));
    }

    servers.push(
      ...(await loadFirstHit(
        [path.join(home, ".claude.json"), path.join(home, ".claude", "mcp.json")],
        "user",
        "Claude",
        RANK.claudeUser,
        warnings,
        seq,
      )),
    );
    servers.push(
      ...(await loadCodexSource(path.join(home, ".codex", "config.toml"), "user", RANK.codexUser, warnings, seq)),
    );
    servers.push(
      ...(await loadJsonSource(
        path.join(home, ".gemini", "settings.json"),
        "user",
        "Gemini",
        RANK.geminiUser,
        false,
        warnings,
        seq,
      )),
    );
    servers.push(
      ...(await loadOpenCodeSource(
        path.join(home, ".config", "opencode", "opencode.json"),
        "user",
        RANK.opencodeUser,
        warnings,
        seq,
      )),
    );
    servers.push(
      ...(await loadJsonSource(
        path.join(home, ".cursor", "mcp.json"),
        "user",
        "Cursor",
        RANK.cursorUser,
        false,
        warnings,
        seq,
      )),
    );
    servers.push(
      ...(await loadJsonSource(
        path.join(home, ".codeium", "windsurf", "mcp_config.json"),
        "user",
        "Windsurf",
        RANK.windsurfUser,
        false,
        warnings,
        seq,
      )),
    );

    const seenPluginPaths = new Set<string>();
    const addPath = (p: string): boolean => {
      const key = path.resolve(p);
      if (seenPluginPaths.has(key)) return false;
      seenPluginPaths.add(key);
      return true;
    };

    for (const ext of await listSettingsExtensionRoots(home, scanCwd)) {
      if (!addPath(ext.path)) continue;
      servers.push(...(await loadOmpPluginMcp(ext.path, ext.level, warnings, seq)));
    }
    const { roots: ompRoots } = await listOmpPluginRoots(home, scanCwd);
    for (const root of ompRoots) {
      if (!root.enabled || root.sourceKind === "marketplace") continue;
      if (!addPath(root.root)) continue;
      servers.push(...(await loadOmpPluginMcp(root.root, root.scope, warnings, seq)));
    }

    const agentSeen = new Set<string>();
    const { roots: claudeRoots } = await listClaudePluginRoots(home, cwd);
    for (const root of claudeRoots) {
      servers.push(...(await loadClaudePluginMcp(root, warnings, seq)));
      if (agentSeen.has(root.path)) continue;
      agentSeen.add(root.path);
      servers.push(...(await loadAgentPluginMcp(root.path, root.scope, root.plugin, warnings, seq)));
    }
    for (const ext of await listSettingsExtensionRoots(home, scanCwd)) {
      if (agentSeen.has(ext.path)) continue;
      agentSeen.add(ext.path);
      servers.push(...(await loadAgentPluginMcp(ext.path, ext.level, path.basename(ext.path), warnings, seq)));
    }
    for (const root of ompRoots) {
      if (!root.enabled) continue;
      if (agentSeen.has(root.root)) continue;
      agentSeen.add(root.root);
      servers.push(...(await loadAgentPluginMcp(root.root, root.scope, root.name, warnings, seq)));
    }

    markShadowed(servers);

    const disabled = new Set<string>(
      Array.isArray(userConfig?.disabledServers)
        ? userConfig.disabledServers.filter((n): n is string => typeof n === "string")
        : [],
    );
    const forced = new Set<string>(
      Array.isArray(userConfig?.enabledServers)
        ? userConfig.enabledServers.filter((n): n is string => typeof n === "string")
        : [],
    );

    return { servers, warnings, disabled, forced, userFile, projectFile };
  };

  return {
    async get() {
      try {
        const { servers, warnings, disabled, forced } = await collect();
        const records = servers
          .map((server) => toRecord(server, disabled, forced))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          servers: records,
          warnings,
          generatedAt: now(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "mcp.get failed";
        return emptyModel(now(), sanitizeDisplayText(message, WARNING_MAX) ?? "mcp.get failed");
      }
    },

    async setEnabled(input) {
      const name = safeName(input.name);
      if (name === undefined) {
        throw { code: "INVALID_ARGUMENT", message: "无效的 MCP 服务器名称" };
      }

      const { servers, disabled, forced, userFile, projectFile } = await collect();
      const matches = servers.filter((server) => server.name === name);
      if (matches.length === 0) {
        throw { code: "INVALID_ARGUMENT", message: `未找到 MCP 服务器 ${name}` };
      }

      const preferred =
        (input.scope === "user" || input.scope === "project"
          ? matches.find((server) => server.scope === input.scope && !server.shadowed)
          : undefined) ??
        matches.find((server) => !server.shadowed) ??
        matches[0];

      if (preferred === undefined) {
        throw { code: "INVALID_ARGUMENT", message: `未找到 MCP 服务器 ${name}` };
      }

      const candidatePaths = [
        ...new Set(
          [preferred.writableNative ? preferred.sourcePath : undefined, projectFile, userFile].filter(
            (value): value is string => typeof value === "string" && value.length > 0,
          ),
        ),
      ];

      let updatedInConfig = false;
      for (const filePath of candidatePaths) {
        try {
          const config = (await readJsonFile(filePath)) ?? { mcpServers: {} };
          const entry = config.mcpServers?.[name];
          if (entry === undefined) continue;
          const nextServers = { ...config.mcpServers, [name]: { ...entry, enabled: input.enabled } };
          await writeJsonFile(filePath, { ...config, mcpServers: nextServers });
          updatedInConfig = true;
          break;
        } catch {
          /* non-JSON candidate — fall through to denylist */
        }
      }

      const userConfig = (await readJsonFile(userFile)) ?? { mcpServers: {} };
      const denied = new Set(Array.isArray(userConfig.disabledServers) ? userConfig.disabledServers : [...disabled]);
      const allow = new Set(Array.isArray(userConfig.enabledServers) ? userConfig.enabledServers : [...forced]);

      if (input.enabled) {
        denied.delete(name);
        if (!updatedInConfig) allow.add(name);
        else allow.delete(name);
      } else {
        allow.delete(name);
        if (!updatedInConfig) denied.add(name);
      }

      const nextUser: McpConfigFile = { ...userConfig };
      if (denied.size > 0) nextUser.disabledServers = [...denied].sort();
      else delete nextUser.disabledServers;
      if (allow.size > 0) nextUser.enabledServers = [...allow].sort();
      else delete nextUser.enabledServers;
      await writeJsonFile(userFile, nextUser);

      return WRITE_OK(input.enabled ? `已启用 ${name}` : `已禁用 ${name}`);
    },
  };
}
