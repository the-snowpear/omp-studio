/**
 * File-backed model-config adapter.
 *
 * Providers come from models.yml; roles come from config.yml `modelRoles`.
 * This surface does not spawn `omp` for list/save. OAuth login is the only
 * optional CLI path. Never opens agent.db and never returns secrets.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

import type {
  AvailableModelRecord,
  ConfigWriteResult,
  ModelApiKind,
  ModelAuthType,
  ModelCatalogEntry,
  ModelConfigReadModel,
  ModelLoginProviderRecord,
  ModelPresetGroup,
  ModelProviderRecord,
  ModelProviderRemoteCompaction,
  ModelProviderStatus,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleRecord,
} from "@omp-studio/client-contract";

import { parseModelsYml, redactModelsYmlText, serializeModelsYml, type YamlValue } from "./models-yml.js";
import type { HostModelsService } from "./services.js";
import { toClientError } from "./services.js";

const execFileAsync = promisify(execFile);

const BUILTIN_ROLES: ReadonlyArray<{ id: string; alias: string; name: string; desc: string }> = [
  { id: "default", alias: "@default", name: "Default", desc: "默认主模型" },
  { id: "smol", alias: "@smol", name: "Fast", desc: "快速、低成本任务" },
  { id: "slow", alias: "@slow", name: "Thinking", desc: "复杂推理任务" },
  { id: "vision", alias: "@vision", name: "Vision", desc: "视觉与图片任务" },
  { id: "plan", alias: "@plan", name: "Architect", desc: "规划和架构任务" },
  { id: "designer", alias: "@designer", name: "Designer", desc: "设计相关任务" },
  { id: "commit", alias: "@commit", name: "Commit", desc: "Commit 相关任务" },
  { id: "tiny", alias: "@tiny", name: "Tiny", desc: "标题、记忆等极轻量后台任务" },
  { id: "task", alias: "@task", name: "Subtask", desc: "通用子任务" },
  { id: "advisor", alias: "@advisor", name: "Advisor", desc: "第二模型审查" },
];

const PRESET_GROUPS: ReadonlyArray<ModelPresetGroup> = [
  {
    group: "官方 / 主流",
    items: [
      { id: "anthropic", name: "Anthropic", desc: "Claude 系列模型官方 API", api: "anthropic-messages", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.anthropic.com/v1" },
      { id: "openai", name: "OpenAI", desc: "GPT 系列模型官方 API", api: "openai-responses", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.openai.com/v1" },
      { id: "openai-codex", name: "OpenAI Codex", desc: "Codex 订阅额度（ChatGPT 账号）", api: "openai-codex-responses", auth: ["oauth"], oauth: true, endpoint: "https://api.openai.com/v1" },
      { id: "google-gemini", name: "Google Gemini", desc: "Gemini 系列模型官方 API", api: "google-generative-ai", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://generativelanguage.googleapis.com/v1beta" },
      { id: "gemini-cli", name: "Google Gemini CLI", desc: "Gemini Code Assist 订阅", api: "google-gemini-cli", auth: ["oauth"], oauth: true },
      { id: "xai", name: "xAI", desc: "Grok 系列模型", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.x.ai/v1" },
      { id: "groq", name: "Groq", desc: "高速推理（Llama / Mixtral）", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.groq.com/openai/v1" },
      { id: "deepseek", name: "DeepSeek", desc: "DeepSeek V / R 系列", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.deepseek.com/v1" },
      { id: "moonshot", name: "Moonshot / Kimi", desc: "Kimi K 系列模型", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.moonshot.cn/v1" },
    ],
  },
  {
    group: "Gateway / 聚合",
    items: [
      { id: "openrouter", name: "OpenRouter", desc: "一个 Key 访问多家模型", api: "openai-completions", auth: ["api-key"], popular: true, endpoint: "https://openrouter.ai/api/v1" },
      { id: "github-copilot", name: "GitHub Copilot", desc: "Copilot 订阅额度", api: "openai-responses", auth: ["oauth"], oauth: true },
      { id: "litellm", name: "LiteLLM", desc: "自托管统一模型代理", api: "openai-completions", auth: ["api-key", "env"], endpoint: "http://localhost:4000/v1", discovery: "litellm" },
    ],
  },
  {
    group: "本地",
    items: [
      { id: "ollama", name: "Ollama", desc: "本地模型服务，自动发现已拉取模型", api: "openai-completions", auth: ["none"], local: true, popular: true, endpoint: "http://localhost:11434/v1", discovery: "ollama" },
      { id: "lm-studio", name: "LM Studio", desc: "本地 OpenAI 兼容服务", api: "openai-completions", auth: ["none"], local: true, endpoint: "http://localhost:1234/v1", discovery: "lm-studio" },
      { id: "llama.cpp", name: "llama.cpp", desc: "llama-server OpenAI 兼容接口", api: "openai-completions", auth: ["none"], local: true, endpoint: "http://localhost:8080/v1", discovery: "llama.cpp" },
    ],
  },
  {
    group: "更多 Provider",
    items: [
      { id: "qwen", name: "Qwen", desc: "通义千问官方 API", api: "openai-completions", auth: ["api-key"], endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { id: "zhipu", name: "Zhipu / 智谱", desc: "GLM 系列模型", api: "openai-completions", auth: ["api-key"], endpoint: "https://open.bigmodel.cn/api/paas/v4" },
      { id: "fireworks", name: "Fireworks", desc: "Fireworks AI 托管推理", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.fireworks.ai/inference/v1" },
      { id: "siliconflow", name: "SiliconFlow", desc: "硅基流动模型云", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.siliconflow.cn/v1" },
    ],
  },
];

const RUNTIME_EFFECT_HINT = "已读写 ~/.omp/agent 下的 YAML。当前会话不会热切换模型；新对话或重启 Runtime 后生效。";

const WRITE_OK: ConfigWriteResult = {
  applied: true,
  runtimeEffect: "new-session",
  message: RUNTIME_EFFECT_HINT,
};

export interface OmpModelsAdapterOptions {
  readonly locateOmp?: () => Promise<string | undefined>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly exec?: (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}

interface ProviderYaml {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  auth?: string;
  headers?: unknown;
  discovery?: { type?: string; timeoutMs?: number };
  models?: Array<Record<string, YamlValue>>;
  modelOverrides?: unknown;
  disableStrictTools?: boolean;
  remoteCompaction?: unknown;
  transport?: string;
}

function emptyModel(reason: string, ompAvailable: boolean): ModelConfigReadModel {
  return {
    providers: [],
    presets: PRESET_GROUPS,
    roles: BUILTIN_ROLES.map((role) => ({
      ...role,
      builtin: true,
      primary: "",
      scope: "global",
    })),
    cycleOrder: ["smol", "default", "slow"],
    availableModels: [],
    loginProviders: [],
    generatedModelsYml: "providers: {}\n",
    generatedConfigYml: "modelRoles: {}\n",
    runtimeEffectHint: RUNTIME_EFFECT_HINT,
    loginAvailable: false,
    ompAvailable,
    unavailableReason: reason,
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}

function stringOf(value: YamlValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: YamlValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMapOf(value: YamlValue | undefined): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && item.length > 0) out[key] = item;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function remoteCompactionOf(value: YamlValue | undefined): ModelProviderRemoteCompaction | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const endpoint = stringOf(record.endpoint);
  const model = stringOf(record.model);
  const enabled = typeof record.enabled === "boolean" ? record.enabled : undefined;
  if (endpoint === undefined && model === undefined && enabled === undefined) return undefined;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(model === undefined ? {} : { model }),
  };
}

function mapApi(api: string | undefined): ModelApiKind | string {
  if (!api) return "openai-completions";
  const aliases: Record<string, ModelApiKind> = {
    "openai-codex": "openai-codex-responses",
    "azure-responses": "azure-openai-responses",
    "bedrock-converse": "bedrock-converse-stream",
    "google-generative": "google-generative-ai",
    "gemini-cli": "google-gemini-cli",
  };
  return aliases[api] ?? api;
}

function authFromYaml(provider: ProviderYaml): { type: ModelAuthType; hasSecret: boolean } {
  if (provider.auth === "none") return { type: "none", hasSecret: false };
  if (provider.auth === "oauth") return { type: "oauth", hasSecret: Boolean(provider.apiKey) };
  const key = provider.apiKey;
  if (typeof key === "string" && key.startsWith("!")) return { type: "command", hasSecret: true };
  if (typeof key === "string" && key.length > 0) return { type: "api-key", hasSecret: true };
  return { type: "api-key", hasSecret: false };
}

function parseThinking(selector: string): { primary: string; thinking?: string } {
  const match = selector.match(/^(.*):([a-z]+)$/);
  if (!match) return { primary: selector };
  const level = match[2];
  if (!level || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
    return { primary: selector };
  }
  if (level === "off") return { primary: match[1] ?? selector };
  return { primary: match[1] ?? selector, thinking: level };
}

function yamlModels(id: string, models: Array<Record<string, YamlValue>> | undefined): ModelCatalogEntry[] {
  if (!models) return [];
  return models.flatMap((model) => {
    const modelId = stringOf(model.id);
    if (!modelId) return [];
    const input = model.input;
    const image = Array.isArray(input) ? input.includes("image") : false;
    const contextWindow = numberOf(model.contextWindow);
    const maxTokens = numberOf(model.maxTokens);
    return [{
      id: modelId,
      name: stringOf(model.name) ?? modelId,
      selector: `${id}/${modelId}`,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      image,
      reasoning: model.reasoning === true,
      tools: model.supportsTools !== false,
      status: "available" as const,
      source: "custom" as const,
    }];
  });
}

function providerFromYaml(id: string, raw: Record<string, YamlValue>, available: Set<string>, disabled: Set<string>): ModelProviderRecord {
  const yaml: ProviderYaml = {};
  const baseUrl = stringOf(raw.baseUrl);
  const apiKey = stringOf(raw.apiKey);
  const api = stringOf(raw.api);
  const authName = stringOf(raw.auth);
  if (baseUrl !== undefined) yaml.baseUrl = baseUrl;
  if (apiKey !== undefined) yaml.apiKey = apiKey;
  if (api !== undefined) yaml.api = api;
  if (authName !== undefined) yaml.auth = authName;
  const discoveryType = stringOf(asRecord(raw.discovery)?.type);
  const discoveryTimeout = numberOf(asRecord(raw.discovery)?.timeoutMs);
  if (discoveryType !== undefined) {
    yaml.discovery = { type: discoveryType, ...(discoveryTimeout === undefined ? {} : { timeoutMs: discoveryTimeout }) };
  }
  if (Array.isArray(raw.models)) {
    yaml.models = raw.models.filter((item): item is Record<string, YamlValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  }
  const auth = authFromYaml(yaml);
  const models = yamlModels(id, yaml.models);
  const hasAvailable = [...available].some((selector) => selector.startsWith(`${id}/`));
  let status: ModelProviderStatus = "available";
  let statusDetail = "已从 models.yml 读取";
  if (disabled.has(id)) {
    status = "disabled";
    statusDetail = "已在 disabledProviders 中禁用";
  } else if (auth.type !== "none" && !auth.hasSecret && !hasAvailable) {
    status = "not-authenticated";
    statusDetail = "尚未配置凭据";
  } else if (hasAvailable) {
    statusDetail = "OMP 已解析到可用模型";
  }
  const preset = PRESET_GROUPS.flatMap((group) => group.items).find((item) => item.id === id);
  const endpointUrl = yaml.baseUrl ?? preset?.endpoint;
  const headers = stringMapOf(raw.headers);
  const disableStrictTools = raw.disableStrictTools === true;
  const transport = raw.transport === "pi-native" ? ("pi-native" as const) : undefined;
  const remoteCompaction = remoteCompactionOf(raw.remoteCompaction);
  return {
    id,
    name: preset?.name ?? id,
    source: preset ? "builtin" : "custom",
    status,
    statusDetail,
    api: mapApi(yaml.api ?? preset?.api),
    ...(endpointUrl === undefined ? {} : { endpointUrl }),
    local: Boolean(preset?.local),
    enabled: !disabled.has(id),
    auth: { type: auth.type, hasSecret: auth.hasSecret },
    ...(yaml.discovery?.type
      ? { discovery: { type: yaml.discovery.type, ...(yaml.discovery.timeoutMs === undefined ? {} : { timeoutMs: yaml.discovery.timeoutMs }) } }
      : {}),
    ...(headers ? { headers } : {}),
    ...(disableStrictTools ? { disableStrictTools: true } : {}),
    ...(transport ? { transport } : {}),
    ...(remoteCompaction ? { remoteCompaction } : {}),
    models: models.length > 0 ? models : [...available].filter((sel) => sel.startsWith(`${id}/`)).map((selector) => {
      const modelId = selector.slice(id.length + 1);
      return {
        id: modelId,
        name: modelId,
        selector,
        image: false,
        reasoning: false,
        tools: true,
        status: "available" as const,
        source: "catalog" as const,
      };
    }),
  };
}

function providersFromAvailable(available: AvailableModelRecord[], existing: Set<string>, disabled: Set<string>): ModelProviderRecord[] {
  const byProvider = new Map<string, AvailableModelRecord[]>();
  for (const model of available) {
    if (existing.has(model.provider)) continue;
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => {
    const preset = PRESET_GROUPS.flatMap((group) => group.items).find((item) => item.id === id);
    return {
      id,
      name: preset?.name ?? id,
      source: (preset ? "builtin" : "runtime") as ModelProviderRecord["source"],
      status: disabled.has(id) ? "disabled" : "available",
      statusDetail: disabled.has(id) ? "已禁用" : "OMP 已解析到可用模型",
      api: mapApi(preset?.api),
      ...(preset?.endpoint === undefined ? {} : { endpointUrl: preset.endpoint }),
      local: Boolean(preset?.local),
      enabled: !disabled.has(id),
      auth: { type: preset?.auth[0] ?? "api-key", hasSecret: true },
      models: models.map((model) => ({
        id: model.id,
        name: model.name,
        selector: model.selector,
        image: false,
        reasoning: model.reasoning,
        tools: true,
        status: "available" as const,
        source: "catalog" as const,
      })),
    };
  });
}

export function toYamlProvider(input: ModelProviderUpsertInput, previous: Record<string, YamlValue> | undefined): Record<string, YamlValue> {
  const next: Record<string, YamlValue> = { ...(previous ?? {}) };
  if (input.endpointUrl) next.baseUrl = input.endpointUrl;
  next.api = mapApi(input.api);
  if (input.discovery) {
    next.discovery = {
      type: input.discovery.type,
      ...(input.discovery.timeoutMs === undefined ? {} : { timeoutMs: input.discovery.timeoutMs }),
    };
  } else if (input.discovery === null) {
    delete next.discovery;
  }
  // A `!command` credential is only valid while the provider's auth type is
  // `command`. When the type switches away without carrying a new credential,
  // drop the stale command so authFromYaml doesn't re-read it as a `command`
  // credential under another auth mode.
  const prevApiKey = typeof next.apiKey === "string" ? next.apiKey : undefined;
  const prevWasCommand = prevApiKey !== undefined && prevApiKey.startsWith("!");
  if (input.auth.type === "none") {
    next.auth = "none";
    delete next.apiKey;
  } else if (input.auth.type === "oauth") {
    next.auth = "oauth";
    if (prevWasCommand) delete next.apiKey;
  } else if (input.auth.type === "command" && input.auth.command) {
    next.apiKey = input.auth.command.startsWith("!") ? input.auth.command : `!${input.auth.command}`;
    delete next.auth;
  } else if (input.auth.type === "api-key") {
    if (input.auth.clearSecret) delete next.apiKey;
    else if (input.auth.apiKey) next.apiKey = input.auth.apiKey;
    else if (prevWasCommand) delete next.apiKey;
    delete next.auth;
  } else if (input.auth.type === "env") {
    delete next.apiKey;
    delete next.auth;
  }
  if (input.headers !== undefined) {
    if (Object.keys(input.headers).length > 0) next.headers = { ...input.headers };
    else delete next.headers;
  }
  if (input.disableStrictTools !== undefined) {
    if (input.disableStrictTools) next.disableStrictTools = true;
    else delete next.disableStrictTools;
  }
  if (input.transport !== undefined) {
    if (input.transport === "pi-native") next.transport = "pi-native";
    else delete next.transport;
  }
  if (input.remoteCompaction !== undefined) {
    if (input.remoteCompaction === null) {
      delete next.remoteCompaction;
    } else {
      const rc: Record<string, YamlValue> = {};
      if (input.remoteCompaction.enabled !== undefined) rc.enabled = input.remoteCompaction.enabled;
      if (input.remoteCompaction.endpoint) rc.endpoint = input.remoteCompaction.endpoint;
      if (input.remoteCompaction.model) rc.model = input.remoteCompaction.model;
      if (Object.keys(rc).length > 0) next.remoteCompaction = rc;
      else delete next.remoteCompaction;
    }
  }
  if (input.models) {
    next.models = input.models.map((model) => ({
      id: model.id,
      ...(model.name ? { name: model.name } : {}),
      ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
      ...(model.image ? { input: ["text", "image"] } : {}),
    }));
  }
  return next;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function defaultAgentDir(): string {
  const fromEnv = process.env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".omp", "agent");
}

async function defaultLocateOmp(): Promise<string | undefined> {
  const exeName = process.platform === "win32" ? "omp.exe" : "omp";
  const extraDirs = [
    join(homedir(), ".omp", "bin"),
    join(homedir(), ".local", "bin"),
  ];
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...extraDirs];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, exeName);
    if (await fileExists(candidate)) return candidate;
  }
  const whereBin = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe") : "which";
  try {
    const { stdout } = await execFileAsync(whereBin, [exeName], { timeout: 8_000, windowsHide: true });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
    if (first && (await fileExists(first))) return first;
  } catch {
    // PATH walk already failed
  }
  return undefined;
}

function quoteInline(value: string): string {
  if (value.length === 0 || /[:{},#]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

/**
 * Upsert `recordKey.entryKey = entryValue` into a YAML mapping without
 * rewriting the whole file (config.yml carries unrelated keys and comments).
 * Handles both the block form (`recordKey:` on its own line) and the inline
 * map form (`recordKey: { ... }`). Missing records are appended as block form.
 */
export function upsertYamlRecordEntry(source: string, recordKey: string, entryKey: string, entryValue: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  // Block form: `recordKey:` on its own line followed by indented entries.
  const headerAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*$`).test(line));
  if (headerAt >= 0) {
    let cursor = headerAt + 1;
    let found: number | undefined;
    // First blank line (or first non-indented line) is the insertion boundary;
    // a blank line never terminates a block mapping, so keep searching past
    // blanks for an existing entry but remember the earliest splice point.
    let insertAt: number | undefined;
    while (cursor < lines.length) {
      const line = lines[cursor] ?? "";
      if (line.trim().length === 0) {
        if (insertAt === undefined) insertAt = cursor;
        cursor += 1;
        continue;
      }
      if (!/^[ \t]/.test(line)) {
        if (insertAt === undefined) insertAt = cursor;
        break;
      }
      if (new RegExp(`^[ \\t]+${entryKey}:\\s*`).test(line)) {
        found = cursor;
        break;
      }
      cursor += 1;
    }
    const nextLine = `  ${entryKey}: ${entryValue}`;
    if (found !== undefined) lines[found] = nextLine;
    else lines.splice(insertAt ?? cursor, 0, nextLine);
    return lines.join(newline);
  }

  // Inline map form: `recordKey: { key: value, ... }` on a single line.
  const inlineAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*\\{.*\\}\\s*$`).test(line));
  if (inlineAt >= 0) {
    const line = lines[inlineAt] ?? "";
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const body = line.slice(open + 1, close).trim();
    const entryRe = new RegExp(`(^|,\\s*)${entryKey}\\s*:\\s*[^,]*`);
    let nextBody: string;
    if (entryRe.test(body)) {
      nextBody = body.replace(entryRe, `$1${entryKey}: ${quoteInline(entryValue)}`);
    } else {
      nextBody = body.length > 0 ? `${body}, ${entryKey}: ${quoteInline(entryValue)}` : `${entryKey}: ${quoteInline(entryValue)}`;
    }
    lines[inlineAt] = `${recordKey}: { ${nextBody.trim()} }`;
    return lines.join(newline);
  }

  // Missing: append block form.
  const suffix = source.endsWith("\n") ? "" : newline;
  return `${source}${suffix}${recordKey}:${newline}  ${entryKey}: ${entryValue}${newline}`;
}

/**
 * Replace a top-level YAML string-list (`recordKey:`) with the given items
 * using a targeted splice, so unrelated keys and comments in config.yml are
 * left untouched. Handles the block form (`  - item`), the inline form
 * (`recordKey: [ ... ]`) and a missing key (appends block form).
 */
export function upsertYamlStringList(source: string, recordKey: string, items: ReadonlyArray<string>): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);

  const headerAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*$`).test(line));
  if (headerAt >= 0) {
    let end = headerAt + 1;
    // A blank line (or a non-indented line) ends the block; trailing blanks
    // and following keys are preserved as-is.
    while (end < lines.length) {
      const line = lines[end] ?? "";
      if (line.trim().length === 0) break;
      if (!/^[ \t]/.test(line)) break;
      end += 1;
    }
    if (items.length === 0) {
      lines.splice(headerAt, end - headerAt, `${recordKey}: []`);
    } else {
      lines.splice(headerAt + 1, end - (headerAt + 1), ...items.map((item) => `  - ${item}`));
    }
    return lines.join(newline);
  }

  const inlineAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*\\[.*\\]\\s*$`).test(line));
  if (inlineAt >= 0) {
    lines.splice(inlineAt, 1, `${recordKey}:`, ...items.map((item) => `  - ${item}`));
    return lines.join(newline);
  }

  const suffix = source.endsWith("\n") ? "" : newline;
  if (items.length === 0) return `${source}${suffix}${recordKey}: []${newline}`;
  return `${source}${suffix}${recordKey}:${newline}${items.map((item) => `  - ${item}`).join(newline)}${newline}`;
}

export function createOmpModelsService(options: OmpModelsAdapterOptions = {}): HostModelsService {
  const locateOmp = options.locateOmp ?? defaultLocateOmp;
  const openUrl = options.openUrl;

  async function resolvePaths(): Promise<{ agentDir: string; modelsPath: string; configPath: string } | undefined> {
    const agentDir = defaultAgentDir();
    if (!(await fileExists(agentDir))) return undefined;
    const modelsYml = join(agentDir, "models.yml");
    const modelsYaml = join(agentDir, "models.yaml");
    const configYml = join(agentDir, "config.yml");
    const configYaml = join(agentDir, "config.yaml");
    return {
      agentDir,
      modelsPath: (await fileExists(modelsYml)) ? modelsYml : (await fileExists(modelsYaml)) ? modelsYaml : modelsYml,
      configPath: (await fileExists(configYml)) ? configYml : (await fileExists(configYaml)) ? configYaml : configYml,
    };
  }

  async function getAvailable(modelsDbPath: string): Promise<AvailableModelRecord[]> {
    // 直接读 OMP 本机 models.db（model_cache 权威行）拿原生供应商/模型，
    // 不 spawn omp CLI —— Electron 主进程下子进程不可靠，且多了 PATH/锁依赖。
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return [];
    }
    if (DatabaseSync === undefined) return [];
    let db: InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined;
    try {
      db = new DatabaseSync(`file:${modelsDbPath}?mode=ro`, { readOnly: true });
      const rows = db
        .prepare("SELECT provider_id, models FROM model_cache WHERE authoritative = 1")
        .all() as unknown as Array<{ provider_id: string; models: string }>;
      const out: AvailableModelRecord[] = [];
      for (const row of rows) {
        let models: unknown;
        try {
          models = JSON.parse(row.models);
        } catch {
          continue;
        }
        if (!Array.isArray(models)) continue;
        const provider = row.provider_id.split(":")[0] ?? "";
        if (!provider) continue;
        for (const model of models as Array<Record<string, unknown>>) {
          const id = typeof model.id === "string" ? model.id : "";
          if (!id) continue;
          const providerOf = typeof model.provider === "string" && model.provider.length > 0 ? model.provider : provider;
          const thinking = Array.isArray(model.thinking)
            ? model.thinking.filter((item): item is string => typeof item === "string")
            : [];
          out.push({
            provider: providerOf,
            id,
            selector: typeof model.selector === "string" && model.selector.length > 0 ? model.selector : `${providerOf}/${id}`,
            name: typeof model.name === "string" ? model.name : id,
            reasoning: model.reasoning === true,
            ...(thinking.length > 0 ? { thinking } : {}),
          });
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function readYamlFile(path: string): Promise<{ text: string; hash: string; root: Record<string, YamlValue> }> {
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const root = text.trim().length === 0 ? {} : parseModelsYml(text);
    return { text, hash: hashText(text), root };
  }

  async function readRolesFromConfigFile(configPath: string): Promise<Record<string, string>> {
    try {
      const file = await readYamlFile(configPath);
      const roles = asRecord(file.root.modelRoles);
      if (!roles) return {};
      const mapped: Record<string, string> = {};
      for (const [key, value] of Object.entries(roles)) {
        if (typeof value === "string" && value.length > 0) mapped[key] = value;
      }
      return mapped;
    } catch {
      return {};
    }
  }

  async function readStringList(configPath: string, key: string): Promise<string[]> {
    try {
      const file = await readYamlFile(configPath);
      const value = file.root[key];
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is string => typeof item === "string");
    } catch {
      return [];
    }
  }

  async function readCycleOrder(configPath: string): Promise<string[]> {
    return readStringList(configPath, "cycleOrder");
  }

  async function readModelsFile(modelsPath: string): Promise<{ text: string; hash: string; root: Record<string, YamlValue> }> {
    let text = "";
    try {
      text = await readFile(modelsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const root = text.trim().length === 0 ? { providers: {} } : parseModelsYml(text);
    if (!("providers" in root) || root.providers === undefined) root.providers = {};
    return { text, hash: hashText(text), root };
  }

  async function writeModelsFile(modelsPath: string, root: Record<string, YamlValue>, expectedHash?: string): Promise<string> {
    let previous = "";
    try {
      previous = await readFile(modelsPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (expectedHash && hashText(previous) !== expectedHash) {
      const error = { code: "STATE_VERSION_CONFLICT", message: "models.yml changed since it was last read" };
      throw error;
    }
    const next = serializeModelsYml(root);
    await mkdir(join(modelsPath, ".."), { recursive: true });
    await writeFile(modelsPath, next, "utf8");
    return hashText(next);
  }

  return {
    async get(): Promise<ModelConfigReadModel> {
      const paths = await resolvePaths();
      if (!paths) {
        return emptyModel(`未找到配置目录 ${defaultAgentDir()}。`, false);
      }
      let file;
      try {
        file = await readModelsFile(paths.modelsPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "models.yml 无法解析";
        const fallback = emptyModel(`models.yml 校验失败：${reason}`, false);
        return { ...fallback, generatedModelsYml: "# models.yml could not be parsed\n" };
      }
      const modelRoles = await readRolesFromConfigFile(paths.configPath);
      const cycleOrder = await readCycleOrder(paths.configPath);
      const disabled = new Set(await readStringList(paths.configPath, "disabledProviders"));
      const available = await getAvailable(join(paths.agentDir, "models.db"));
      const providersMap = asRecord(file.root.providers) ?? {};
      const liveSet = new Set(available.map((model) => model.selector));
      const fromFile = Object.keys(providersMap).map((id) => providerFromYaml(id, asRecord(providersMap[id]) ?? {}, liveSet, disabled));
      const existing = new Set(fromFile.map((provider) => provider.id));
      const providers = [...fromFile, ...providersFromAvailable(available, existing, disabled)];
      const yamlAvailable: AvailableModelRecord[] = fromFile.flatMap((provider) =>
        provider.models.map((model) => ({
          provider: provider.id,
          id: model.id,
          selector: model.selector,
          name: model.name,
          reasoning: model.reasoning,
        })),
      );
      const availableBySelector = new Map<string, AvailableModelRecord>();
      for (const model of [...yamlAvailable, ...available]) availableBySelector.set(model.selector, model);
      const mergedAvailable = [...availableBySelector.values()];
      const availableSet = new Set(mergedAvailable.map((model) => model.selector));
      const roles: ModelRoleRecord[] = BUILTIN_ROLES.map((role) => {
        const raw = modelRoles[role.id] ?? "";
        const parsed = raw ? parseThinking(raw) : { primary: "" };
        const issue = parsed.primary && !availableSet.has(parsed.primary) && parsed.primary.length > 0
          ? { kind: "model-missing" as const, detail: `${parsed.primary} 当前不在可用模型列表中` }
          : undefined;
        return {
          ...role,
          builtin: true,
          primary: parsed.primary,
          ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
          scope: "global",
          ...(issue ? { issue } : {}),
        };
      });
      const generatedConfigYml = `modelRoles:\n${roles
        .filter((role) => role.primary)
        .map((role) => `  ${role.id}: ${role.primary}${role.thinking ? `:${role.thinking}` : ""}`)
        .join("\n")}${roles.some((role) => role.primary) ? "\n" : ""}`;
      return {
        providers,
        presets: PRESET_GROUPS,
        roles,
        cycleOrder: cycleOrder.length > 0 ? cycleOrder : ["smol", "default", "slow"],
        availableModels: mergedAvailable,
        loginProviders: PRESET_GROUPS.flatMap((group) => group.items)
          .filter((item) => item.oauth)
          .map((item) => ({
            id: item.id,
            name: item.name,
            available: Boolean(openUrl),
            authenticated: false,
          })),
        generatedModelsYml: redactModelsYmlText(file.text || serializeModelsYml(file.root)),
        generatedConfigYml,
        contentHash: file.hash,
        loginAvailable: Boolean(openUrl),
        ompAvailable: true,
        runtimeEffectHint: "已读写 ~/.omp/agent 下的 YAML。当前会话不会热切换模型；新对话或重启 Runtime 后生效。",
      };
    },

    async upsertProvider(input: ModelProviderUpsertInput): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const file = await readModelsFile(paths.modelsPath);
      const providers = asRecord(file.root.providers) ?? {};
      providers[input.id] = toYamlProvider(input, asRecord(providers[input.id]));
      file.root.providers = providers;
      const contentHash = await writeModelsFile(paths.modelsPath, file.root, input.expectedHash);
      return { ...WRITE_OK, contentHash };
    },

    async deleteProvider(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const file = await readModelsFile(paths.modelsPath);
      const providers = asRecord(file.root.providers) ?? {};
      if (!(input.id in providers)) throw { code: "INVALID_ARGUMENT", message: `provider ${input.id} is not in models.yml` };
      delete providers[input.id];
      file.root.providers = providers;
      const contentHash = await writeModelsFile(paths.modelsPath, file.root, input.expectedHash);
      return { ...WRITE_OK, contentHash };
    },

    async setRole(input): Promise<ConfigWriteResult> {
      if (!BUILTIN_ROLES.some((role) => role.id === input.roleId)) {
        throw { code: "INVALID_ARGUMENT", message: `unknown built-in role ${input.roleId}` };
      }
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      let text = "";
      try {
        text = await readFile(paths.configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = upsertYamlRecordEntry(text, "modelRoles", input.roleId, input.selector);
      await mkdir(join(paths.configPath, ".."), { recursive: true });
      await writeFile(paths.configPath, next, "utf8");
      return WRITE_OK;
    },

    async startLogin(input): Promise<ConfigWriteResult> {
      if (!openUrl) {
        throw {
          code: "CAPABILITY_UNAVAILABLE",
          message: `应用内登录不可用。请在终端运行 omp login ${input.providerId}`,
        };
      }
      const exe = await locateOmp();
      if (!exe) throw { code: "UNAVAILABLE", message: "omp executable was not found" };
      const { spawn } = await import("node:child_process");
      return await new Promise<ConfigWriteResult>((resolve, reject) => {
        const child = spawn(exe, ["--mode", "rpc"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let buffer = "";
        let settled = false;
        const finish = (error?: unknown, result?: ConfigWriteResult) => {
          if (settled) return;
          settled = true;
          child.kill();
          if (error) reject(toClientError(error, "CAPABILITY_UNAVAILABLE"));
          else resolve(result ?? WRITE_OK);
        };
        const timer = setTimeout(() => finish({ code: "UNAVAILABLE", message: "login timed out; use omp login in a terminal" }), 120_000);
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            let frame: Record<string, unknown>;
            try {
              frame = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              continue;
            }
            if (frame.type === "ready") {
              child.stdin?.write(`${JSON.stringify({ id: "login-1", type: "login", providerId: input.providerId })}\n`);
              continue;
            }
            if (frame.type === "extension_ui_request" && frame.method === "open_url") {
              const url = typeof frame.url === "string" ? frame.url : typeof frame.launchUrl === "string" ? frame.launchUrl : "";
              if (url) void openUrl(url);
              continue;
            }
            if (frame.type === "extension_ui_request" && frame.method === "input") {
              finish({
                code: "CAPABILITY_UNAVAILABLE",
                message: `该供应商需要交互式输入。请在终端运行 omp login ${input.providerId}`,
              });
              continue;
            }
            if (frame.type === "response" && frame.command === "login") {
              clearTimeout(timer);
              if (frame.success === true) finish(undefined, { ...WRITE_OK, message: `已登录 ${input.providerId}。新会话后生效。` });
              else finish({ code: "INTERNAL_ERROR", message: typeof frame.error === "string" ? frame.error : "login failed" });
            }
          }
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          finish(error);
        });
        child.on("exit", () => {
          clearTimeout(timer);
          if (!settled) finish({ code: "UNAVAILABLE", message: "login process exited; use omp login in a terminal" });
        });
      });
    },

    async testProvider(input): Promise<ModelProviderTestResult> {
      const started = Date.now();
      let endpointUrl = input.endpointUrl;
      let apiKey = input.apiKey;
      let api = input.api;

      // Resolve saved config as defaults when a provider id is supplied.
      if (input.providerId) {
        const paths = await resolvePaths();
        if (paths) {
          try {
            const file = await readModelsFile(paths.modelsPath);
            const providers = asRecord(file.root.providers) ?? {};
            const raw = asRecord(providers[input.providerId]) ?? {};
            if (endpointUrl === undefined) endpointUrl = stringOf(raw.baseUrl);
            if (api === undefined) api = stringOf(raw.api);
            if (apiKey === undefined) {
              const key = stringOf(raw.apiKey);
              if (key !== undefined && key.startsWith("!")) {
                return { ok: false, latencyMs: Date.now() - started, detail: "该供应商使用外部命令取凭据，无法在此自动测试，请在终端验证。" };
              }
              apiKey = key;
            }
          } catch {
            // Fall through to whatever was provided in the request.
          }
        }
      }

      if (!endpointUrl) {
        return { ok: false, latencyMs: Date.now() - started, detail: "未配置 Base URL。" };
      }

      const base = endpointUrl.replace(/\/+$/, "");
      const probeUrl = `${base}/models`;
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) {
        if (api === "anthropic-messages") headers["x-api-key"] = apiKey;
        else headers.Authorization = `Bearer ${apiKey}`;
      }

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10_000);
        const response = await fetch(probeUrl, { method: "GET", headers, signal: controller.signal });
        clearTimeout(timer);
        const ok = response.status >= 200 && response.status < 300;
        const detail = ok
          ? `连接成功 · HTTP ${response.status}`
          : response.status === 401 || response.status === 403
            ? `HTTP ${response.status} · 凭据无效`
            : `HTTP ${response.status} · ${response.statusText || "请求失败"}`;
        return { ok, latencyMs: Date.now() - started, detail };
      } catch (error) {
        const timedOut = error instanceof Error && error.name === "AbortError";
        return {
          ok: false,
          latencyMs: Date.now() - started,
          detail: timedOut ? "连接失败：请求超时" : "连接失败：网络不可达",
        };
      }
    },

    async setCycleOrder(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      let text = "";
      try {
        text = await readFile(paths.configPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const next = upsertYamlStringList(text, "cycleOrder", input.order);
      await mkdir(join(paths.configPath, ".."), { recursive: true });
      await writeFile(paths.configPath, next, "utf8");
      return WRITE_OK;
    },
  };
}
