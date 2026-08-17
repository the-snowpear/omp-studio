/**
 * File-backed model-config adapter.
 *
 * Providers come from models.yml; roles come from config.yml `modelRoles`.
 * List/save do not spawn `omp`. OAuth login and `omp models refresh` are the
 * optional CLI paths. Auth presence is read from `agent.db` without returning secrets.
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
  ModelCostMeta,
  ModelDiscoveryModel,
  ModelDiscoveryResult,
  ModelFallbackRevertPolicy,
  ModelOverridePatch,
  ModelPresetGroup,
  ModelProviderProbeInput,
  ModelProviderRecord,
  ModelProviderRemoteCompaction,
  ModelProviderStatus,
  ModelProviderTestResult,
  ModelProviderUpsertInput,
  ModelRoleCreateInput,
  ModelRoleRecord,
  ModelRoleStorage,
  ModelRolesWriteInput,
} from "@omp-studio/client-contract";
import { parseCacheThinkingEfforts, parseModelThinkingEfforts } from "@omp-studio/client-contract";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseModelsYml, redactModelsYmlText, restoreRedactedApiKeys, serializeModelsYml, type YamlValue } from "./models-yml.js";
import { getProjectConfigDir } from "./omp-discovery/paths.js";
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

const WRITE_OK: ConfigWriteResult = {
  applied: true,
  runtimeEffect: "new-session",
  message: "已保存",
};

export interface OmpModelsAdapterOptions {
  readonly locateOmp?: () => Promise<string | undefined>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly exec?: (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Fetch implementation for connection probes; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Agent config directory; defaults to `~/.omp/agent` (test injection). */
  readonly agentDir?: string;
  /** Active workspace cwd for project-scoped role writes. */
  readonly getCwd?: () => string | undefined;
  /** Auth sqlite path; defaults to `{agentDir}/agent.db`. */
  readonly authDbPath?: string;
}

/** Single-probe timeout for connection tests (cc-switch uses 8s). */
const TEST_TIMEOUT_MS = 8_000;
/** Retries for timeout-class failures only (cc-switch: 1). */
const TEST_MAX_RETRIES = 1;

/** Network errors that are definitive and should not be retried. */
const TEST_DEFINITIVE_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EADDRNOTAVAIL", "EADDRINUSE"]);

/**
 * Model-list probe URL for a given base URL and wire API. Reachability
 * probing itself always targets `base` (any HTTP response counts), so this
 * only shapes the authenticated credential check. Anthropic requires
 * `/v1/models`; Gemini/OpenAI-compatible endpoints expose `/models`.
 * Returns undefined for APIs without a model-list endpoint (bedrock,
 * gemini-cli) — those fall back to plain reachability.
 */
export function authProbeUrl(base: string, api: string): string | undefined {
  const trimmed = base.replace(/\/+$/, "");
  if (api === "anthropic-messages") {
    return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
  }
  if (api === "bedrock-converse-stream" || api === "google-gemini-cli") return undefined;
  return `${trimmed}/models`;
}

/** Classify a probe network error into a user-facing Chinese detail. */
export function networkErrorDetail(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "连接失败：请求超时";
  const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
  const code = cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "连接失败：域名无法解析";
  if (code === "ECONNREFUSED") return "连接失败：连接被拒绝";
  if (code === "ECONNRESET" || code === "EPIPE") return "连接失败：连接被重置";
  if (typeof code === "string" && code.includes("CERT")) return "连接失败：TLS 证书错误";
  return "连接失败：网络不可达";
}

/** Only timeout / transient network jitter deserves a retry. */
export function isRetryableTestFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
  const code = cause?.code;
  if (code === undefined) return true;
  return !TEST_DEFINITIVE_ERROR_CODES.has(code);
}

export function envNameForProvider(id: string): string {
  return `${id.replace(/-/g, "_").toUpperCase()}_API_KEY`;
}

export function envHasSecret(id: string): boolean {
  const value = process.env[envNameForProvider(id)];
  return typeof value === "string" && value.length > 0;
}

export function ollamaTagsUrl(base: string): string {
  return `${base.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/tags`;
}

export function litellmInfoUrls(base: string): string[] {
  const root = base.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return [`${root}/model_group/info`, `${root}/v2/model/info`, `${root}/model/info`, `${root}/v1/model/info`, `${root}/v1/models`, `${root}/models`];
}

export function parseDiscoveryModels(payload: unknown): ModelDiscoveryModel[] {
  const out: ModelDiscoveryModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, name?: string) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ id: trimmed, name: name && name.trim().length > 0 ? name.trim() : trimmed });
  };
  if (!payload || typeof payload !== "object") return out;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const id = typeof row.name === "string" ? row.name : typeof row.model === "string" ? row.model : typeof row.id === "string" ? row.id : "";
        const name = typeof row.name === "string" ? row.name : typeof row.id === "string" ? row.id : undefined;
        push(id, name);
      }
    }
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : typeof row.model_name === "string" ? row.model_name : "";
        push(id, typeof row.name === "string" ? row.name : undefined);
      }
    }
  }
  if (Array.isArray(record.data) === false && Array.isArray(payload)) {
    for (const item of payload as unknown[]) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
        push(id);
      }
    }
  }
  return out;
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
    runtimeEffectHint: "",
    loginAvailable: false,
    ompAvailable,
    unavailableReason: reason,
    modelRoleStorage: "global",
    projectScopeAvailable: false,
    modelProviderOrder: [],
    fallbackChains: {},
    fallbackRevertPolicy: "cooldown-expiry",
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

function authFromYaml(provider: ProviderYaml, providerId: string): { type: ModelAuthType; hasSecret: boolean; apiKey?: string } {
  if (provider.auth === "none") return { type: "none", hasSecret: false };
  if (provider.auth === "oauth") {
    return {
      type: "oauth",
      hasSecret: Boolean(provider.apiKey),
      ...(typeof provider.apiKey === "string" && provider.apiKey.length > 0 ? { apiKey: provider.apiKey } : {}),
    };
  }
  const key = provider.apiKey;
  if (typeof key === "string" && key.startsWith("!")) return { type: "command", hasSecret: true, apiKey: key };
  if (typeof key === "string" && key.length > 0) return { type: "api-key", hasSecret: true, apiKey: key };
  if (envHasSecret(providerId)) return { type: "env", hasSecret: true };
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

function cacheNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function cacheCost(value: unknown): ModelCostMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = cacheNumber(record.input);
  const output = cacheNumber(record.output);
  const cacheRead = cacheNumber(record.cacheRead);
  const cacheWrite = cacheNumber(record.cacheWrite);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Map one OMP `models.db` cache model into the Studio available-model record. */
export function availableFromCacheModel(
  model: Record<string, unknown>,
  providerFallback: string,
): AvailableModelRecord | undefined {
  const id = typeof model.id === "string" ? model.id : "";
  if (!id) return undefined;
  const providerOf = typeof model.provider === "string" && model.provider.length > 0 ? model.provider : providerFallback;
  if (!providerOf) return undefined;
  const input = model.input;
  const image = Array.isArray(input) ? input.includes("image") : false;
  const thinking = parseCacheThinkingEfforts(model.thinking);
  const contextWindow = cacheNumber(model.contextWindow);
  const maxTokens = cacheNumber(model.maxTokens);
  const cost = cacheCost(model.cost);
  return {
    provider: providerOf,
    id,
    selector: typeof model.selector === "string" && model.selector.length > 0 ? model.selector : `${providerOf}/${id}`,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : id,
    reasoning: model.reasoning === true,
    image,
    tools: model.supportsTools !== false,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(cost ? { cost } : {}),
  };
}

export function catalogEntryFromAvailable(model: AvailableModelRecord): ModelCatalogEntry {
  return {
    id: model.id,
    name: model.name,
    selector: model.selector,
    image: model.image === true,
    reasoning: model.reasoning,
    tools: model.tools !== false,
    status: "available",
    source: "catalog",
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.cost ? { cost: model.cost } : {}),
    ...(model.thinking && model.thinking.length > 0 ? { thinking: model.thinking } : {}),
  };
}

export function availableFromCatalogEntry(providerId: string, model: ModelCatalogEntry): AvailableModelRecord {
  return {
    provider: providerId,
    id: model.id,
    selector: model.selector,
    name: model.name,
    reasoning: model.reasoning,
    image: model.image,
    tools: model.tools,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.cost ? { cost: model.cost } : {}),
    ...(model.thinking && model.thinking.length > 0 ? { thinking: model.thinking } : {}),
  };
}

function costOf(value: YamlValue | undefined): ModelCostMeta | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const input = numberOf(record.input);
  const output = numberOf(record.output);
  const cacheRead = numberOf(record.cacheRead);
  const cacheWrite = numberOf(record.cacheWrite);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

function costToYaml(cost: ModelCostMeta | undefined, complete: boolean): Record<string, YamlValue> | undefined {
  if (!cost) return undefined;
  if (cost.input === undefined && cost.output === undefined && cost.cacheRead === undefined && cost.cacheWrite === undefined) {
    return undefined;
  }
  if (complete) {
    return {
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    };
  }
  return {
    ...(cost.input === undefined ? {} : { input: cost.input }),
    ...(cost.output === undefined ? {} : { output: cost.output }),
    ...(cost.cacheRead === undefined ? {} : { cacheRead: cost.cacheRead }),
    ...(cost.cacheWrite === undefined ? {} : { cacheWrite: cost.cacheWrite }),
  };
}

function extrasFromYaml(entry: Record<string, YamlValue>): {
  omitMaxOutputTokens?: boolean;
  premiumMultiplier?: number;
  headers?: Record<string, string>;
  contextPromotionTarget?: string;
  compactionModel?: string;
  remoteCompaction?: ModelProviderRemoteCompaction;
  api?: string;
  baseUrl?: string;
} {
  const premiumMultiplier = numberOf(entry.premiumMultiplier);
  const headers = stringMapOf(entry.headers);
  const contextPromotionTarget = stringOf(entry.contextPromotionTarget);
  const compactionModel = stringOf(entry.compactionModel);
  const remoteCompaction = remoteCompactionOf(entry.remoteCompaction);
  const api = stringOf(entry.api);
  const baseUrl = stringOf(entry.baseUrl);
  return {
    ...(typeof entry.omitMaxOutputTokens === "boolean" ? { omitMaxOutputTokens: entry.omitMaxOutputTokens } : {}),
    ...(premiumMultiplier === undefined ? {} : { premiumMultiplier }),
    ...(headers ? { headers } : {}),
    ...(contextPromotionTarget === undefined ? {} : { contextPromotionTarget }),
    ...(compactionModel === undefined ? {} : { compactionModel }),
    ...(remoteCompaction ? { remoteCompaction } : {}),
    ...(api === undefined ? {} : { api }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

function writeRemoteCompaction(rc: ModelProviderRemoteCompaction | undefined): Record<string, YamlValue> | undefined {
  if (!rc) return undefined;
  const row: Record<string, YamlValue> = {};
  if (rc.enabled !== undefined) row.enabled = rc.enabled;
  if (rc.endpoint) row.endpoint = rc.endpoint;
  if (rc.model) row.model = rc.model;
  return Object.keys(row).length > 0 ? row : undefined;
}

function writeThinking(efforts: ReadonlyArray<string> | undefined): Record<string, YamlValue> | undefined {
  const parsed = parseModelThinkingEfforts(efforts);
  if (parsed.length === 0) return undefined;
  return { efforts: [...parsed] };
}

function writeOverrideRow(override: ModelOverridePatch): Record<string, YamlValue> | undefined {
  const row: Record<string, YamlValue> = {};
  if (override.name !== undefined) row.name = override.name;
  if (override.contextWindow !== undefined) row.contextWindow = override.contextWindow;
  if (override.maxTokens !== undefined) row.maxTokens = override.maxTokens;
  if (override.reasoning !== undefined) row.reasoning = override.reasoning;
  if (override.tools !== undefined) row.supportsTools = override.tools;
  if (override.image === true) row.input = ["text", "image"];
  else if (override.image === false) row.input = ["text"];
  const cost = costToYaml(override.cost, false);
  if (cost) row.cost = cost;
  if (override.omitMaxOutputTokens !== undefined) row.omitMaxOutputTokens = override.omitMaxOutputTokens;
  if (override.premiumMultiplier !== undefined) row.premiumMultiplier = override.premiumMultiplier;
  if (override.headers && Object.keys(override.headers).length > 0) row.headers = { ...override.headers };
  if (override.contextPromotionTarget) row.contextPromotionTarget = override.contextPromotionTarget;
  if (override.compactionModel) row.compactionModel = override.compactionModel;
  const rc = writeRemoteCompaction(override.remoteCompaction);
  if (rc) row.remoteCompaction = rc;
  const thinking = writeThinking(override.thinking);
  if (thinking) row.thinking = thinking;
  return Object.keys(row).length > 0 ? row : undefined;
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
    const cost = costOf(model.cost);
    const extras = extrasFromYaml(model);
    const thinking = parseModelThinkingEfforts(model.thinking);
    return [{
      id: modelId,
      name: stringOf(model.name) ?? modelId,
      selector: `${id}/${modelId}`,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      image,
      reasoning: model.reasoning === true,
      tools: model.supportsTools !== false,
      ...(cost ? { cost } : {}),
      status: "available" as const,
      source: "custom" as const,
      ...(extras.api === undefined ? {} : { api: extras.api }),
      ...(extras.baseUrl === undefined ? {} : { baseUrl: extras.baseUrl }),
      ...(extras.omitMaxOutputTokens === undefined ? {} : { omitMaxOutputTokens: extras.omitMaxOutputTokens }),
      ...(extras.premiumMultiplier === undefined ? {} : { premiumMultiplier: extras.premiumMultiplier }),
      ...(extras.headers ? { headers: extras.headers } : {}),
      ...(extras.contextPromotionTarget === undefined ? {} : { contextPromotionTarget: extras.contextPromotionTarget }),
      ...(extras.compactionModel === undefined ? {} : { compactionModel: extras.compactionModel }),
      ...(extras.remoteCompaction ? { remoteCompaction: extras.remoteCompaction } : {}),
      ...(thinking.length > 0 ? { thinking } : {}),
    }];
  });
}

function yamlModelOverrides(raw: YamlValue | undefined): ModelProviderRecord["modelOverrides"] {
  const record = asRecord(raw);
  if (!record) return undefined;
  type OverrideEntry = NonNullable<NonNullable<ModelProviderRecord["modelOverrides"]>[string]>;
  const out: Record<string, OverrideEntry> = {};
  for (const [modelId, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const name = stringOf(entry.name);
    const contextWindow = numberOf(entry.contextWindow);
    const maxTokens = numberOf(entry.maxTokens);
    const cost = costOf(entry.cost);
    const input = entry.input;
    const image = Array.isArray(input) ? input.includes("image") : undefined;
    const extras = extrasFromYaml(entry);
    const thinking = parseModelThinkingEfforts(entry.thinking);
    const patch: OverrideEntry = {
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
      ...(typeof entry.supportsTools === "boolean" ? { tools: entry.supportsTools } : {}),
      ...(image === undefined ? {} : { image }),
      ...(cost ? { cost } : {}),
      ...(extras.omitMaxOutputTokens === undefined ? {} : { omitMaxOutputTokens: extras.omitMaxOutputTokens }),
      ...(extras.premiumMultiplier === undefined ? {} : { premiumMultiplier: extras.premiumMultiplier }),
      ...(extras.headers ? { headers: extras.headers } : {}),
      ...(extras.contextPromotionTarget === undefined ? {} : { contextPromotionTarget: extras.contextPromotionTarget }),
      ...(extras.compactionModel === undefined ? {} : { compactionModel: extras.compactionModel }),
      ...(extras.remoteCompaction ? { remoteCompaction: extras.remoteCompaction } : {}),
      ...(thinking.length > 0 ? { thinking } : {}),
    };
    if (Object.keys(patch).length > 0) out[modelId] = patch;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function applyOverrideToCatalog(
  model: ModelCatalogEntry,
  override: NonNullable<ModelProviderRecord["modelOverrides"]>[string] | undefined,
): ModelCatalogEntry {
  if (!override) return model;
  return {
    ...model,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
    ...(override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
    ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
    ...(override.tools === undefined ? {} : { tools: override.tools }),
    ...(override.image === undefined ? {} : { image: override.image }),
    ...(override.cost === undefined ? {} : { cost: override.cost }),
    ...(override.omitMaxOutputTokens === undefined ? {} : { omitMaxOutputTokens: override.omitMaxOutputTokens }),
    ...(override.premiumMultiplier === undefined ? {} : { premiumMultiplier: override.premiumMultiplier }),
    ...(override.headers ? { headers: override.headers } : {}),
    ...(override.contextPromotionTarget === undefined ? {} : { contextPromotionTarget: override.contextPromotionTarget }),
    ...(override.compactionModel === undefined ? {} : { compactionModel: override.compactionModel }),
    ...(override.remoteCompaction ? { remoteCompaction: override.remoteCompaction } : {}),
    ...(override.thinking === undefined ? {} : { thinking: override.thinking }),
  };
}

function catalogModelsFromAvailable(
  id: string,
  available: ReadonlyArray<AvailableModelRecord>,
  skipIds: Set<string>,
  overrides: ModelProviderRecord["modelOverrides"],
): ModelCatalogEntry[] {
  return available
    .filter((model) => model.selector.startsWith(`${id}/`))
    .flatMap((model) => {
      if (!model.id || skipIds.has(model.id)) return [];
      return [applyOverrideToCatalog(catalogEntryFromAvailable(model), overrides?.[model.id])];
    });
}

function providerFromYaml(
  id: string,
  raw: Record<string, YamlValue>,
  available: ReadonlyArray<AvailableModelRecord>,
  disabled: Set<string>,
  authenticated: Set<string>,
): ModelProviderRecord {
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
  const auth = authFromYaml(yaml, id);
  const hasOAuth = auth.type === "oauth" && (auth.hasSecret || authenticated.has(id));
  const customModels = yamlModels(id, yaml.models);
  const modelOverrides = yamlModelOverrides(raw.modelOverrides);
  const customIds = new Set(customModels.map((model) => model.id));
  const catalogModels = catalogModelsFromAvailable(id, available, customIds, modelOverrides);
  const models = [...catalogModels, ...customModels];
  const hasAvailable = available.some((model) => model.selector.startsWith(`${id}/`));
  let status: ModelProviderStatus = "available";
  let statusDetail = "已从 models.yml 读取";
  if (disabled.has(id)) {
    status = "disabled";
    statusDetail = "已在 disabledProviders 中禁用";
  } else if (auth.type === "oauth" && !hasOAuth && !hasAvailable) {
    status = "not-authenticated";
    statusDetail = "尚未登录";
  } else if (auth.type !== "none" && auth.type !== "oauth" && !auth.hasSecret && !hasAvailable) {
    status = "not-authenticated";
    statusDetail = "尚未配置凭据";
  } else if (hasAvailable) {
    statusDetail = "OMP 已解析到可用模型";
  }
  const preset = PRESET_GROUPS.flatMap((group) => group.items).find((item) => item.id === id);
  const yamlName = stringOf(raw.name);
  const yamlWebsite = stringOf(raw.website);
  const yamlNote = typeof raw.note === "string" ? raw.note : undefined;
  const endpointUrl = yaml.baseUrl ?? preset?.endpoint;
  const headers = stringMapOf(raw.headers);
  const disableStrictTools = raw.disableStrictTools === true;
  const transport = raw.transport === "pi-native" ? ("pi-native" as const) : undefined;
  const remoteCompaction = remoteCompactionOf(raw.remoteCompaction);
  return {
    id,
    name: yamlName ?? preset?.name ?? id,
    source: preset ? "builtin" : "custom",
    status,
    statusDetail,
    api: mapApi(yaml.api ?? preset?.api),
    ...(endpointUrl === undefined ? {} : { endpointUrl }),
    local: Boolean(preset?.local ?? raw.local === true),
    enabled: !disabled.has(id),
    ...(yamlWebsite === undefined ? {} : { website: yamlWebsite }),
    ...(yamlNote === undefined || yamlNote.length === 0 ? {} : { note: yamlNote }),
    auth: {
      type: auth.type === "oauth" && hasOAuth ? "oauth" : auth.type,
      hasSecret: auth.type === "oauth" ? hasOAuth : auth.hasSecret,
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
    },
    ...(yaml.discovery?.type
      ? { discovery: { type: yaml.discovery.type, ...(yaml.discovery.timeoutMs === undefined ? {} : { timeoutMs: yaml.discovery.timeoutMs }) } }
      : preset?.discovery
        ? { discovery: { type: preset.discovery } }
        : {}),
    ...(headers ? { headers } : {}),
    ...(disableStrictTools ? { disableStrictTools: true } : {}),
    ...(transport ? { transport } : {}),
    ...(remoteCompaction ? { remoteCompaction } : {}),
    ...(modelOverrides ? { modelOverrides } : {}),
    models,
  };
}

function providerIsOperatorConfigured(id: string, authenticated: Set<string>): boolean {
  return authenticated.has(id) || envHasSecret(id);
}

function providersFromAvailable(
  available: AvailableModelRecord[],
  existing: Set<string>,
  disabled: Set<string>,
  authenticated: Set<string>,
): ModelProviderRecord[] {
  const byProvider = new Map<string, AvailableModelRecord[]>();
  for (const model of available) {
    if (existing.has(model.provider)) continue;
    // Bundled static catalogs (zenmux) land in models.db without models.yml.
    // Builtin OAuth providers (opencode-go) also live in cache, but only after
    // the operator logs in — those must still appear.
    if (!providerIsOperatorConfigured(model.provider, authenticated)) continue;
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => {
    const preset = PRESET_GROUPS.flatMap((group) => group.items).find((item) => item.id === id);
    const authType = preset?.auth[0] ?? (authenticated.has(id) ? "oauth" : "api-key");
    const oauthOk = authType === "oauth" && authenticated.has(id);
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
      auth: {
        type: authType,
        hasSecret: authType === "none" || authType === "env" ? envHasSecret(id) || authType === "none" : oauthOk || authType !== "oauth",
      },
      ...(preset?.discovery ? { discovery: { type: preset.discovery } } : {}),
      models: models.map((model) => catalogEntryFromAvailable(model)),
    };
  });
}

export function toYamlProvider(input: ModelProviderUpsertInput, previous: Record<string, YamlValue> | undefined): Record<string, YamlValue> {
  const next: Record<string, YamlValue> = { ...(previous ?? {}) };
  if (input.name) next.name = input.name;
  if (input.website !== undefined) {
    if (input.website) next.website = input.website;
    else delete next.website;
  }
  if (input.note !== undefined) {
    if (input.note) next.note = input.note;
    else delete next.note;
  }
  if (input.endpointUrl !== undefined) {
    if (input.endpointUrl) next.baseUrl = input.endpointUrl;
    else delete next.baseUrl;
  }
  next.api = mapApi(input.api);
  delete next.enabled;
  if (typeof input.local === "boolean") {
    if (input.local) next.local = true;
    else delete next.local;
  }
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
    next.models = input.models.map((model) => {
      const row: Record<string, YamlValue> = { id: model.id };
      if (model.name) row.name = model.name;
      if (model.api) row.api = mapApi(model.api);
      if (model.baseUrl) row.baseUrl = model.baseUrl;
      if (model.contextWindow) row.contextWindow = model.contextWindow;
      if (model.maxTokens) row.maxTokens = model.maxTokens;
      if (model.reasoning !== undefined) row.reasoning = model.reasoning;
      if (model.image) row.input = ["text", "image"];
      if (model.tools === false) row.supportsTools = false;
      const cost = costToYaml(model.cost, true);
      if (cost) row.cost = cost;
      if (model.omitMaxOutputTokens) row.omitMaxOutputTokens = true;
      if (model.premiumMultiplier !== undefined) row.premiumMultiplier = model.premiumMultiplier;
      if (model.headers && Object.keys(model.headers).length > 0) row.headers = { ...model.headers };
      if (model.contextPromotionTarget) row.contextPromotionTarget = model.contextPromotionTarget;
      if (model.compactionModel) row.compactionModel = model.compactionModel;
      const rc = writeRemoteCompaction(model.remoteCompaction);
      if (rc) row.remoteCompaction = rc;
      const thinking = writeThinking(model.thinking);
      if (thinking) row.thinking = thinking;
      return row;
    });
  }
  if (input.modelOverrides !== undefined) {
    if (input.modelOverrides === null || Object.keys(input.modelOverrides).length === 0) {
      delete next.modelOverrides;
    } else {
      const mapped: Record<string, YamlValue> = {};
      for (const [modelId, override] of Object.entries(input.modelOverrides)) {
        const row = writeOverrideRow(override);
        if (row) mapped[modelId] = row;
      }
      if (Object.keys(mapped).length > 0) next.modelOverrides = mapped;
      else delete next.modelOverrides;
    }
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

export function deleteYamlRecordEntry(source: string, recordKey: string, entryKey: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*$`).test(line));
  if (headerAt >= 0) {
    const found = lines.findIndex((line, index) => index > headerAt && new RegExp(`^[ \\t]+${entryKey}:\\s*`).test(line));
    if (found > headerAt) {
      lines.splice(found, 1);
      return lines.join(newline);
    }
  }
  const inlineAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*\\{.*\\}\\s*$`).test(line));
  if (inlineAt >= 0) {
    const line = lines[inlineAt] ?? "";
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const parts = line.slice(open + 1, close).split(",").map((part) => part.trim()).filter((part) => part.length > 0 && !new RegExp(`^${entryKey}\\s*:`).test(part));
    lines[inlineAt] = `${recordKey}: { ${parts.join(", ")} }`;
    return lines.join(newline);
  }
  return source;
}

export function replaceYamlRecordStrings(source: string, recordKey: string, entries: Readonly<Record<string, string>>): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const keys = Object.keys(entries);
  const block = keys.length === 0
    ? `${recordKey}: {}`
    : [`${recordKey}:`, ...keys.map((key) => `  ${key}: ${quoteInline(entries[key] ?? "")}`)].join(newline);
  const lines = source.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => new RegExp(`^${recordKey}:\\s*$`).test(line) || new RegExp(`^${recordKey}:\\s*\\{.*\\}\\s*$`).test(line) || new RegExp(`^${recordKey}:\\s*\\{\\}\\s*$`).test(line));
  if (headerAt >= 0) {
    let end = headerAt + 1;
    if (!/\{/.test(lines[headerAt] ?? "")) {
      while (end < lines.length) {
        const line = lines[end] ?? "";
        if (line.trim().length === 0) break;
        if (!/^[ \t]/.test(line)) break;
        end += 1;
      }
    }
    lines.splice(headerAt, end - headerAt, ...block.split(newline));
    return lines.join(newline);
  }
  const suffix = source.endsWith("\n") ? "" : newline;
  return `${source}${suffix}${block}${newline}`;
}

export function upsertYamlScalar(source: string, key: string, value: string): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const at = lines.findIndex((line) => new RegExp(`^${key}:\\s*`).test(line));
  const nextLine = `${key}: ${value}`;
  if (at >= 0) {
    lines[at] = nextLine;
    return lines.join(newline);
  }
  const suffix = source.endsWith("\n") ? "" : newline;
  return `${source}${suffix}${nextLine}${newline}`;
}

function patchYamlRoot(source: string, mutator: (root: Record<string, unknown>) => void): string {
  const parsed = source.trim().length === 0 ? {} : parseYaml(source);
  const root = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  mutator(root);
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  let out = stringifyYaml(root);
  if (newline === "\r\n") out = out.replace(/\n/g, "\r\n");
  return out;
}

export function createOmpModelsService(options: OmpModelsAdapterOptions = {}): HostModelsService {
  const locateOmp = options.locateOmp ?? defaultLocateOmp;
  const openUrl = options.openUrl;
  const doFetch = options.fetch ?? globalThis.fetch;

  async function resolvePaths(): Promise<{ agentDir: string; modelsPath: string; configPath: string } | undefined> {
    const agentDir = options.agentDir ?? defaultAgentDir();
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
          const record = availableFromCacheModel(model, provider);
          if (record) out.push(record);
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
      const text = await readFile(configPath, "utf8");
      const parsed = parseYaml(text) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const value = (parsed as Record<string, unknown>)[key];
      if (!Array.isArray(value)) return [];
      return value.filter((item): item is string => typeof item === "string");
    } catch {
      return [];
    }
  }

  async function writeConfigStringList(configPath: string, key: string, items: ReadonlyArray<string>): Promise<void> {
    let text = "";
    try {
      text = await readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = upsertYamlStringList(text, key, items);
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, next, "utf8");
  }

  /** Provider on/off is `config.yml` `disabledProviders`, not a models.yml field. */
  async function applyProviderEnabled(configPath: string, id: string, enabled: boolean): Promise<void> {
    const current = await readStringList(configPath, "disabledProviders");
    const next = enabled ? current.filter((item) => item !== id) : current.includes(id) ? current : [...current, id];
    if (next.length === current.length && next.every((item, index) => item === current[index])) return;
    await writeConfigStringList(configPath, "disabledProviders", next);
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

  function cwdOf(): string | undefined {
    return options.getCwd?.();
  }

  function authDbOf(agentDir: string): string {
    return options.authDbPath ?? join(agentDir, "agent.db");
  }

  async function readConfigText(configPath: string): Promise<string> {
    try {
      return await readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return "";
    }
  }

  async function writeConfigText(configPath: string, text: string): Promise<void> {
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(configPath, text, "utf8");
  }

  async function readScalar(configPath: string, key: string): Promise<string | undefined> {
    try {
      const parsed = parseYaml(await readConfigText(configPath)) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const value = (parsed as Record<string, unknown>)[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async function readFallback(configPath: string): Promise<{ chains: Record<string, string[]>; revertPolicy: ModelFallbackRevertPolicy }> {
    try {
      const parsed = parseYaml(await readConfigText(configPath)) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { chains: {}, revertPolicy: "cooldown-expiry" };
      }
      const retry = (parsed as Record<string, unknown>).retry;
      const record = retry !== null && typeof retry === "object" && !Array.isArray(retry) ? (retry as Record<string, unknown>) : {};
      const rawChains = record.fallbackChains;
      const chains: Record<string, string[]> = {};
      if (rawChains && typeof rawChains === "object" && !Array.isArray(rawChains)) {
        for (const [key, value] of Object.entries(rawChains as Record<string, unknown>)) {
          if (Array.isArray(value)) chains[key] = value.filter((item): item is string => typeof item === "string" && item.length > 0);
        }
      }
      const revert = record.fallbackRevertPolicy === "never" ? "never" : "cooldown-expiry";
      return { chains, revertPolicy: revert };
    } catch {
      return { chains: {}, revertPolicy: "cooldown-expiry" };
    }
  }

  async function readModelTags(configPath: string): Promise<Record<string, { name: string; desc?: string; color?: string }>> {
    try {
      const parsed = parseYaml(await readConfigText(configPath)) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const tags = (parsed as Record<string, unknown>).modelTags;
      if (!tags || typeof tags !== "object" || Array.isArray(tags)) return {};
      const out: Record<string, { name: string; desc?: string; color?: string }> = {};
      for (const [id, value] of Object.entries(tags as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const row = value as Record<string, unknown>;
        const name = typeof row.name === "string" && row.name.length > 0 ? row.name : id;
        out[id] = {
          name,
          ...(typeof row.desc === "string" ? { desc: row.desc } : {}),
          ...(typeof row.color === "string" ? { color: row.color } : {}),
        };
      }
      return out;
    } catch {
      return {};
    }
  }

  async function openAuthDb(agentDir: string, readOnly: boolean): Promise<InstanceType<typeof import("node:sqlite").DatabaseSync> | undefined> {
    let DatabaseSync: typeof import("node:sqlite").DatabaseSync | undefined;
    try {
      ({ DatabaseSync } = await import("node:sqlite"));
    } catch {
      return undefined;
    }
    if (DatabaseSync === undefined) return undefined;
    const dbPath = authDbOf(agentDir);
    try {
      return readOnly
        ? new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true })
        : new DatabaseSync(dbPath);
    } catch {
      return undefined;
    }
  }

  async function readAuthenticatedProviders(agentDir: string): Promise<Set<string>> {
    const db = await openAuthDb(agentDir, true);
    if (!db) return new Set();
    try {
      const rows = db
        .prepare("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL")
        .all() as unknown as Array<{ provider: string }>;
      return new Set(rows.map((row) => row.provider).filter((id) => typeof id === "string" && id.length > 0));
    } catch {
      return new Set();
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function logoutAuth(agentDir: string, providerId: string): Promise<number> {
    const db = await openAuthDb(agentDir, false);
    if (!db) throw { code: "UNAVAILABLE", message: "未找到本机 auth 存储（agent.db）。请在终端运行 /logout。" };
    try {
      const result = db
        .prepare("UPDATE auth_credentials SET disabled_cause = ?, updated_at = strftime('%s','now') WHERE provider = ? AND disabled_cause IS NULL")
        .run("logged out by user", providerId) as { changes?: number };
      return typeof result.changes === "number" ? result.changes : 0;
    } catch {
      throw { code: "UNAVAILABLE", message: "无法更新 auth 存储。请在终端运行 /logout。" };
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function roleTargetPath(paths: { agentDir: string; configPath: string }): Promise<{ path: string; storage: ModelRoleStorage }> {
    const storage = ((await readScalar(paths.configPath, "modelRoleStorage")) === "project" ? "project" : "global") as ModelRoleStorage;
    if (storage !== "project") return { path: paths.configPath, storage };
    const cwd = cwdOf();
    if (!cwd) throw { code: "UNAVAILABLE", message: "未打开工作区，无法写入项目级角色。" };
    return { path: join(getProjectConfigDir(cwd), "config.yml"), storage };
  }

  async function knownRoleIds(configPath: string): Promise<Set<string>> {
    const tags = await readModelTags(configPath);
    return new Set([...BUILTIN_ROLES.map((role) => role.id), ...Object.keys(tags)]);
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
      const modelRolesGlobal = await readRolesFromConfigFile(paths.configPath);
      const storage = ((await readScalar(paths.configPath, "modelRoleStorage")) === "project" ? "project" : "global") as ModelRoleStorage;
      const cwd = cwdOf();
      let modelRoles = { ...modelRolesGlobal };
      const projectKeys = new Set<string>();
      if (storage === "project" && cwd) {
        const projectRoles = await readRolesFromConfigFile(join(getProjectConfigDir(cwd), "config.yml"));
        for (const [key, value] of Object.entries(projectRoles)) {
          modelRoles[key] = value;
          projectKeys.add(key);
        }
      }
      const cycleOrder = await readCycleOrder(paths.configPath);
      const modelProviderOrder = await readStringList(paths.configPath, "modelProviderOrder");
      const fallback = await readFallback(paths.configPath);
      const tags = await readModelTags(paths.configPath);
      const disabled = new Set(await readStringList(paths.configPath, "disabledProviders"));
      const authenticated = await readAuthenticatedProviders(paths.agentDir);
      const available = await getAvailable(join(paths.agentDir, "models.db"));
      const providersMap = asRecord(file.root.providers) ?? {};
      const fromFile = Object.keys(providersMap).map((id) => providerFromYaml(id, asRecord(providersMap[id]) ?? {}, available, disabled, authenticated));
      const existing = new Set(fromFile.map((provider) => provider.id));
      // models.db also holds bundled static catalogs the operator never opted into
      // (zenmux). Keep yaml providers, plus cache providers with auth/env.
      const providers = [...fromFile, ...providersFromAvailable(available, existing, disabled, authenticated)];
      const cacheBySelector = new Map<string, AvailableModelRecord>();
      for (const model of available) {
        if (model.thinking && model.thinking.length > 0 && !cacheBySelector.has(model.selector)) cacheBySelector.set(model.selector, model);
      }
      const yamlAvailable: AvailableModelRecord[] = fromFile.flatMap((provider) =>
        provider.models.map((model) => {
          const record = availableFromCatalogEntry(provider.id, model);
          if (record.thinking && record.thinking.length > 0) return record;
          const cached = cacheBySelector.get(record.selector);
          return cached?.thinking?.length ? { ...record, thinking: cached.thinking } : record;
        }),
      );
      const allowedProviders = new Set(providers.map((provider) => provider.id));
      const availableBySelector = new Map<string, AvailableModelRecord>();
      for (const model of [...yamlAvailable, ...available.filter((model) => allowedProviders.has(model.provider))]) {
        availableBySelector.set(model.selector, model);
      }
      const mergedAvailable = [...availableBySelector.values()];
      const availableSet = new Set(mergedAvailable.map((model) => model.selector));
      const roleDefs = [
        ...BUILTIN_ROLES.map((role) => ({ ...role, builtin: true })),
        ...Object.entries(tags)
          .filter(([id]) => !BUILTIN_ROLES.some((role) => role.id === id))
          .map(([id, tag]) => ({
            id,
            alias: `@${id}`,
            name: tag.name,
            desc: tag.desc ?? "自定义角色",
            builtin: false,
          })),
      ];
      const roles: ModelRoleRecord[] = roleDefs.map((role) => {
        const raw = modelRoles[role.id] ?? "";
        const parsed = raw ? parseThinking(raw) : { primary: "" };
        const issue = parsed.primary && !availableSet.has(parsed.primary) && parsed.primary.length > 0
          ? { kind: "model-missing" as const, detail: `${parsed.primary} 当前不在可用模型列表中` }
          : undefined;
        return {
          ...role,
          primary: parsed.primary,
          ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
          scope: projectKeys.has(role.id) ? "project" : "global",
          ...(issue ? { issue } : {}),
        };
      });
      const generatedConfigYml = [
        `modelRoleStorage: ${storage}`,
        `modelRoles:`,
        ...roles.filter((role) => role.primary).map((role) => `  ${role.id}: ${role.primary}${role.thinking ? `:${role.thinking}` : ""}`),
        modelProviderOrder.length > 0 ? `modelProviderOrder:\n${modelProviderOrder.map((id) => `  - ${id}`).join("\n")}` : "",
      ].filter((line) => line.length > 0).join("\n") + "\n";
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
            authenticated: authenticated.has(item.id),
          })),
        generatedModelsYml: redactModelsYmlText(file.text || serializeModelsYml(file.root)),
        generatedConfigYml,
        contentHash: file.hash,
        loginAvailable: Boolean(openUrl),
        ompAvailable: true,
        runtimeEffectHint: "",
        modelRoleStorage: storage,
        projectScopeAvailable: Boolean(cwd),
        modelProviderOrder,
        fallbackChains: fallback.chains,
        fallbackRevertPolicy: fallback.revertPolicy,
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
      if (typeof input.enabled === "boolean") {
        await applyProviderEnabled(paths.configPath, input.id, input.enabled);
      }
      return { ...WRITE_OK, contentHash };
    },

    async setProviderEnabled(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      await applyProviderEnabled(paths.configPath, input.id, input.enabled);
      return { ...WRITE_OK, message: input.enabled ? `已启用 ${input.id}` : `已禁用 ${input.id}` };
    },

    async writeModelsYml(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const file = await readModelsFile(paths.modelsPath);
      let root: Record<string, YamlValue>;
      try {
        root = parseModelsYml(input.text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "YAML 无法解析";
        throw { code: "INVALID_ARGUMENT", message: reason };
      }
      if (!("providers" in root) || root.providers === undefined) root.providers = {};
      if (!asRecord(root.providers)) {
        throw { code: "INVALID_ARGUMENT", message: "models.yml 的 providers 必须是映射" };
      }
      restoreRedactedApiKeys(root, file.root);
      if (input.overlay) {
        const providers = asRecord(root.providers) ?? {};
        providers[input.overlay.id] = toYamlProvider(input.overlay, asRecord(providers[input.overlay.id]));
        root.providers = providers;
      }
      const contentHash = await writeModelsFile(paths.modelsPath, root, input.expectedHash);
      return { ...WRITE_OK, contentHash, message: "已写入 models.yml" };
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
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const known = await knownRoleIds(paths.configPath);
      if (!known.has(input.roleId)) {
        throw { code: "INVALID_ARGUMENT", message: `unknown role ${input.roleId}` };
      }
      const target = await roleTargetPath(paths);
      let text = await readConfigText(target.path);
      const next = input.selector.length === 0
        ? deleteYamlRecordEntry(text, "modelRoles", input.roleId)
        : upsertYamlRecordEntry(text, "modelRoles", input.roleId, input.selector);
      await writeConfigText(target.path, next);
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
        if (!endpointUrl) {
          endpointUrl = PRESET_GROUPS.flatMap((group) => group.items).find((item) => item.id === input.providerId)?.endpoint;
        }
      }

      if (!endpointUrl) {
        return { ok: false, latencyMs: Date.now() - started, detail: "未配置 Base URL。" };
      }

      const base = endpointUrl.replace(/\/+$/, "");

      // One GET probe; any HTTP response counts as reachable, only network-level
      // errors fail (cc-switch reachability semantics). TTFB is the latency.
      const probe = async (url: string, headers: Record<string, string>): Promise<{ status: number; error: unknown | null }> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
        try {
          const response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
          return { status: response.status, error: null };
        } catch (error) {
          return { status: 0, error };
        } finally {
          clearTimeout(timer);
        }
      };

      const probeWithRetry = async (url: string, headers: Record<string, string>): Promise<{ status: number; error: unknown | null; retries: number }> => {
        let lastError: unknown | null = null;
        for (let attempt = 0; attempt <= TEST_MAX_RETRIES; attempt += 1) {
          const result = await probe(url, headers);
          if (result.error === null) return { status: result.status, error: null, retries: attempt };
          lastError = result.error;
          if (!isRetryableTestFailure(result.error) || attempt === TEST_MAX_RETRIES) break;
        }
        return { status: 0, error: lastError, retries: TEST_MAX_RETRIES };
      };

      // Without credentials only reachability of the base URL itself is tested:
      // any HTTP response (200/4xx/5xx) proves the endpoint is alive, avoiding
      // false negatives from auth filters or missing model-list endpoints.
      if (!apiKey) {
        const result = await probeWithRetry(base, { Accept: "*/*" });
        if (result.error !== null) {
          return { ok: false, latencyMs: Date.now() - started, detail: networkErrorDetail(result.error), retryCount: result.retries };
        }
        return {
          ok: true,
          latencyMs: Date.now() - started,
          detail: `连接成功 · HTTP ${result.status}`,
          httpStatus: result.status,
          retryCount: result.retries,
        };
      }

      // With credentials, verify them against the API's model-list endpoint
      // (per-wire URL), falling back to plain reachability when that endpoint
      // is missing (404/405) or the API has no model-list surface at all.
      const authHeaders: Record<string, string> =
        api === "anthropic-messages"
          ? { "x-api-key": apiKey, Accept: "application/json" }
          : api === "google-generative-ai" || api === "google-vertex"
            ? { "x-goog-api-key": apiKey, Accept: "application/json" }
            : { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };

      const authProbe = authProbeUrl(base, api ?? "openai-completions");
      if (authProbe !== undefined) {
        const authResult = await probeWithRetry(authProbe, authHeaders);
        if (authResult.error !== null) {
          return { ok: false, latencyMs: Date.now() - started, detail: networkErrorDetail(authResult.error), retryCount: authResult.retries };
        }
        if (authResult.status >= 200 && authResult.status < 300) {
          return {
            ok: true,
            latencyMs: Date.now() - started,
            detail: `连接成功 · HTTP ${authResult.status} · 凭据有效`,
            httpStatus: authResult.status,
            retryCount: authResult.retries,
          };
        }
        if (authResult.status === 401 || authResult.status === 403) {
          return {
            ok: false,
            latencyMs: Date.now() - started,
            detail: `连接失败：端点可达 · HTTP ${authResult.status} · 凭据无效`,
            httpStatus: authResult.status,
            retryCount: authResult.retries,
          };
        }
        // Model-list endpoint missing or failing: the endpoint itself may still
        // be fine, so degrade to a reachability probe of the base URL.
        const fallback = await probeWithRetry(base, { Accept: "*/*" });
        if (fallback.error !== null) {
          return { ok: false, latencyMs: Date.now() - started, detail: networkErrorDetail(fallback.error), retryCount: authResult.retries + fallback.retries };
        }
        return {
          ok: true,
          latencyMs: Date.now() - started,
          detail: `连接成功 · 端点可达（HTTP ${fallback.status}）· 模型列表接口不可用（HTTP ${authResult.status}）· 凭据未验证`,
          httpStatus: fallback.status,
          retryCount: authResult.retries + fallback.retries,
        };
      }

      // No model-list surface for this wire API (bedrock / gemini-cli).
      const reach = await probeWithRetry(base, { Accept: "*/*" });
      if (reach.error !== null) {
        return { ok: false, latencyMs: Date.now() - started, detail: networkErrorDetail(reach.error), retryCount: reach.retries };
      }
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail: `连接成功 · HTTP ${reach.status} · 凭据未验证（该 API 类型无模型列表接口）`,
        httpStatus: reach.status,
        retryCount: reach.retries,
      };
    },

    async probeProvider(input: ModelProviderProbeInput): Promise<ModelDiscoveryResult> {
      const started = Date.now();
      let endpointUrl = input.endpointUrl;
      let apiKey = input.apiKey;
      let discoveryType = input.discoveryType;
      let timeoutMs = input.timeoutMs ?? TEST_TIMEOUT_MS;
      const paths = await resolvePaths();
      if (paths) {
        try {
          const file = await readModelsFile(paths.modelsPath);
          const raw = asRecord((asRecord(file.root.providers) ?? {})[input.providerId]) ?? {};
          if (!endpointUrl) endpointUrl = stringOf(raw.baseUrl);
          if (!apiKey) {
            const key = stringOf(raw.apiKey);
            if (key && !key.startsWith("!")) apiKey = key;
          }
          const discovery = asRecord(raw.discovery);
          if (!discoveryType) discoveryType = stringOf(discovery?.type);
          if (input.timeoutMs === undefined) {
            const yamlTimeout = numberOf(discovery?.timeoutMs);
            if (yamlTimeout !== undefined) timeoutMs = yamlTimeout;
          }
        } catch {
          /* use request fields */
        }
      }
      const preset = PRESET_GROUPS.flatMap((group) => group.items).find((item) => item.id === input.providerId);
      if (!endpointUrl) endpointUrl = preset?.endpoint;
      if (!discoveryType) discoveryType = preset?.discovery;
      if (!endpointUrl) {
        return { ok: false, found: 0, usable: 0, models: [], latencyMs: Date.now() - started, detail: "未配置 Base URL。" };
      }
      if (!discoveryType) {
        return { ok: false, found: 0, usable: 0, models: [], latencyMs: Date.now() - started, detail: "该供应商未配置 Discovery Type。" };
      }
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const urls = discoveryType === "ollama"
        ? [ollamaTagsUrl(endpointUrl)]
        : discoveryType === "litellm"
          ? litellmInfoUrls(endpointUrl)
          : [`${endpointUrl.replace(/\/+$/, "")}/models`, `${endpointUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/v1/models`];
      let lastStatus = 0;
      let lastError: unknown = null;
      for (const url of urls) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await doFetch(url, { method: "GET", headers, signal: controller.signal });
          lastStatus = response.status;
          if (response.status < 200 || response.status >= 300) continue;
          const payload = await response.json().catch(() => null);
          const models = parseDiscoveryModels(payload);
          return {
            ok: true,
            found: models.length,
            usable: models.length,
            models,
            latencyMs: Date.now() - started,
            detail: `探测成功 · 发现 ${models.length} 个模型 · HTTP ${response.status}`,
            httpStatus: response.status,
          };
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }
      return {
        ok: false,
        found: 0,
        usable: 0,
        models: [],
        latencyMs: Date.now() - started,
        detail: lastError ? networkErrorDetail(lastError) : `探测失败${lastStatus ? ` · HTTP ${lastStatus}` : ""}`,
        ...(lastStatus ? { httpStatus: lastStatus } : {}),
      };
    },

    async refreshDiscovery(): Promise<ConfigWriteResult> {
      const exe = await locateOmp();
      if (!exe) throw { code: "UNAVAILABLE", message: "omp executable was not found" };
      const run = options.exec ?? (async (command, args) => {
        const { stdout, stderr } = await execFileAsync(command, args, { timeout: 120_000, windowsHide: true, encoding: "utf8" });
        return { stdout: String(stdout), stderr: String(stderr), code: 0 };
      });
      try {
        const result = await run(exe, ["models", "refresh", "--json"]);
        if (result.code !== 0) {
          throw { code: "INTERNAL_ERROR", message: result.stderr.trim() || "omp models refresh failed" };
        }
        return { ...WRITE_OK, message: "已重新扫描 Discovery 缓存（新会话后生效）" };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw toClientError(error, "UNAVAILABLE");
      }
    },

    async logout(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const changes = await logoutAuth(paths.agentDir, input.providerId);
      return { ...WRITE_OK, message: changes > 0 ? `已登出 ${input.providerId}` : `${input.providerId} 没有已保存凭据` };
    },

    async writeRoles(input: ModelRolesWriteInput): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const target = await roleTargetPath(paths);
      const text = await readConfigText(target.path);
      await writeConfigText(target.path, replaceYamlRecordStrings(text, "modelRoles", input.roles));
      return { ...WRITE_OK, message: "已写入 modelRoles" };
    },

    async createRole(input: ModelRoleCreateInput): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (BUILTIN_ROLES.some((role) => role.id === input.id)) {
        throw { code: "INVALID_ARGUMENT", message: `${input.id} 是内置角色，不能重复创建` };
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(input.id)) {
        throw { code: "INVALID_ARGUMENT", message: "角色 id 只能使用小写字母、数字、连字符和下划线" };
      }
      const text = await readConfigText(paths.configPath);
      const next = patchYamlRoot(text, (root) => {
        const tags = root.modelTags && typeof root.modelTags === "object" && !Array.isArray(root.modelTags)
          ? { ...(root.modelTags as Record<string, unknown>) }
          : {};
        tags[input.id] = {
          name: input.name,
          ...(input.desc ? { desc: input.desc } : {}),
          ...(input.color ? { color: input.color } : {}),
        };
        root.modelTags = tags;
      });
      await writeConfigText(paths.configPath, next);
      if (input.selector) {
        const target = await roleTargetPath(paths);
        const roleText = await readConfigText(target.path);
        await writeConfigText(target.path, upsertYamlRecordEntry(roleText, "modelRoles", input.id, input.selector));
      }
      return { ...WRITE_OK, message: `已创建角色 ${input.id}` };
    },

    async deleteRole(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (BUILTIN_ROLES.some((role) => role.id === input.roleId)) {
        throw { code: "INVALID_ARGUMENT", message: "不能删除内置角色" };
      }
      const text = await readConfigText(paths.configPath);
      const next = patchYamlRoot(text, (root) => {
        if (root.modelTags && typeof root.modelTags === "object" && !Array.isArray(root.modelTags)) {
          const tags = { ...(root.modelTags as Record<string, unknown>) };
          delete tags[input.roleId];
          root.modelTags = tags;
        }
        if (root.modelRoles && typeof root.modelRoles === "object" && !Array.isArray(root.modelRoles)) {
          const roles = { ...(root.modelRoles as Record<string, unknown>) };
          delete roles[input.roleId];
          root.modelRoles = roles;
        }
      });
      await writeConfigText(paths.configPath, next);
      const cwd = cwdOf();
      if (cwd) {
        const projectPath = join(getProjectConfigDir(cwd), "config.yml");
        const projectText = await readConfigText(projectPath);
        if (projectText.trim().length > 0) {
          await writeConfigText(projectPath, deleteYamlRecordEntry(projectText, "modelRoles", input.roleId));
        }
      }
      return { ...WRITE_OK, message: `已删除角色 ${input.roleId}` };
    },

    async setRoleStorage(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (input.storage === "project" && !cwdOf()) {
        throw { code: "UNAVAILABLE", message: "未打开工作区，无法切换到 Project 作用域。" };
      }
      const text = await readConfigText(paths.configPath);
      await writeConfigText(paths.configPath, upsertYamlScalar(text, "modelRoleStorage", input.storage));
      return { ...WRITE_OK, message: input.storage === "project" ? "角色写入项目 .omp/config.yml" : "已恢复全局角色配置" };
    },

    async setFallback(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const text = await readConfigText(paths.configPath);
      const next = patchYamlRoot(text, (root) => {
        const retry = root.retry && typeof root.retry === "object" && !Array.isArray(root.retry)
          ? { ...(root.retry as Record<string, unknown>) }
          : {};
        retry.fallbackChains = { ...input.chains };
        if (input.revertPolicy) retry.fallbackRevertPolicy = input.revertPolicy;
        root.retry = retry;
      });
      await writeConfigText(paths.configPath, next);
      return { ...WRITE_OK, message: "已保存 Fallback 链" };
    },

    async setProviderOrder(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      await writeConfigStringList(paths.configPath, "modelProviderOrder", input.order);
      return { ...WRITE_OK, message: "已保存 modelProviderOrder" };
    },

    async setCycleOrder(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      await writeConfigStringList(paths.configPath, "cycleOrder", input.order);
      return WRITE_OK;
    },
  };
}
