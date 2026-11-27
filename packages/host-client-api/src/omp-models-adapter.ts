import { createModelCatalogService, createModelOriginStore } from "./model-adaptation.js";
import { hostText } from "./locale.js";
import { modelParameterValues, parseModelThinkingConfig, providerModelYamlNode, providerOverrideYamlNode } from "@omp-studio/client-contract";
import type { ModelParameterValues, ModelParameterSources } from "@omp-studio/client-contract";
import { migrateModelRoleConfig } from "./model-role-migration.js";
import { readWebRouting, writeWebRouting } from "./web-routing.js";
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
  ModelExecutionMetadata,
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
  ModelWebSearchSetInput,
  ModelWebSearchCredentialSetInput,
  ModelWebSearchCredentialRemoveInput,
  WebSearchConfigReadModel,
} from "@omp-studio/client-contract";
import { BUILTIN_MODEL_ROLES, parseModelKind, isModelEnvConfigName, parseCacheThinkingEfforts, parseModelThinkingEfforts, parseModelPricing } from "@omp-studio/client-contract";

import { parse as parseYaml, stringify as stringifyYaml, parseDocument } from "yaml";
import { parseModelsYml, redactModelsYmlText, restoreRedactedApiKeys, serializeModelsYml, type YamlValue } from "./models-yml.js";
import { getAgentDir, getProjectConfigDir } from "./omp-discovery/paths.js";
import type { HostModelsService } from "./services.js";
import type { ModelAvailablePage } from "@omp-studio/studio-protocol";
import { toClientError } from "./services.js";

const execFileAsync = promisify(execFile);

const ROLE_DESC_EN: Readonly<Record<string, string>> = {
  default: "Default primary model",
  smol: "Fast, low-cost tasks",
  slow: "Complex reasoning tasks",
  vision: "Vision and image tasks",
  plan: "Planning and architecture tasks",
  designer: "Design-related tasks",
  commit: "Commit-related tasks",
  tiny: "Title, memory, and ultra-light background tasks",
  memory: "Long-term memory extraction and curation",
  task: "General subtasks",
  advisor: "Second model review",
  image: "Image generation and editing",
  web: "Web fetching and search summarization",
  speech: "Text-to-speech synthesis",
  dictation: "Speech-to-text dictation",
  judge: "Auto-thinking and quality judgment",
  widget: "Live background-job widgets (falls back to Fast)",
};

const builtinRoles = () =>
  BUILTIN_MODEL_ROLES.map((role) => ({
    ...role,
    desc: hostText(role.desc, ROLE_DESC_EN[role.id] ?? role.desc),
    alias: `@${role.id}`,
  }));

/**
 * Web-search providers in the runtime's built-in chain order
 * (`SEARCH_PROVIDER_ORDER`), each with the upstream credential-requirement
 * description. `credentialFree` mirrors the runtime: scraper engines and the
 * public aggregate need no credential. Kept in sync with
 * `packages/coding-agent/src/web/search/types.ts` upstream.
 */
const WEB_SEARCH_PROVIDER_CATALOG: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  credentialFree: boolean;
  siteRoute?: string;
}> = [
  { id: "parallel", name: "Parallel", description: "Keyless search with optional PARALLEL_API_KEY authentication", credentialFree: true },
  { id: "perplexity", name: "Perplexity", description: "Uses auth when configured; explicit selection falls back to anonymous search", credentialFree: false },
  { id: "gemini", name: "Gemini", description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)", credentialFree: false },
  { id: "anthropic", name: "Anthropic", description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)", credentialFree: false },
  { id: "codex", name: "OpenAI", description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)", credentialFree: false },
  { id: "xai", name: "xAI", description: "Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)", credentialFree: false },
  { id: "zai", name: "Z.AI", description: "Calls Z.AI webSearchPrime MCP", credentialFree: false },
  { id: "exa", name: "Exa", description: "API via /login exa or EXA_API_KEY; public MCP without a key", credentialFree: true },
  { id: "keenable", name: "Keenable", description: "KEENABLE_API_KEY or stored key; explicit selection can use the public keyless endpoint", credentialFree: false },
  { id: "tinyfish", name: "TinyFish", description: "Requires TINYFISH_API_KEY", credentialFree: false },
  { id: "sofya", name: "Sofya", description: "Native Sofya search using SOFYA_API_KEY or the stored Sofya credential", credentialFree: false },
  { id: "jina", name: "Jina", description: "Requires JINA_API_KEY", credentialFree: false },
  { id: "kagi", name: "Kagi", description: "Requires KAGI_API_KEY and Kagi Search API beta access", credentialFree: false },
  { id: "tavily", name: "Tavily", description: "Requires TAVILY_API_KEY", credentialFree: false },
  { id: "firecrawl", name: "Firecrawl", description: "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode", credentialFree: true },
  { id: "brave", name: "Brave", description: "Requires BRAVE_API_KEY", credentialFree: false },
  { id: "deepseek", name: "DeepSeek", description: "DeepSeek Search API using DEEPSEEK_API_KEY or a stored DeepSeek key", credentialFree: false },
  { id: "kimi", name: "Kimi", description: "Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)", credentialFree: false },
  { id: "synthetic", name: "Synthetic", description: "Requires SYNTHETIC_API_KEY", credentialFree: false },
  { id: "ollama", name: "Ollama Cloud", description: "Hosted web search using OLLAMA_CLOUD_API_KEY or Ollama Cloud credentials", credentialFree: false },
  { id: "searxng", name: "SearXNG", description: "Requires SEARXNG_ENDPOINT or searxng.endpoint", credentialFree: true },
  { id: "startpage", name: "Startpage", description: "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged", credentialFree: true },
  { id: "duckduckgo", name: "DuckDuckGo", description: "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs", credentialFree: true },
  { id: "ecosia", name: "Ecosia", description: "Credential-free browser-backed scrape of Ecosia (Google-backed) results", credentialFree: true },
  { id: "google", name: "Google", description: "Credential-free browser-backed fallback; slower and may be bot-challenged", credentialFree: true },
  { id: "mojeek", name: "Mojeek", description: "Credential-free browser-backed scrape of Mojeek's independent index", credentialFree: true },
  { id: "public", name: "Public Web", description: "Queries every credential-free engine in parallel and consolidates deduplicated results", credentialFree: true },
  { id: "hackernews", name: "Hacker News", description: "Native keyless route for news.ycombinator.com only; not a general-web fallback", credentialFree: true, siteRoute: "news.ycombinator.com" },
];

/** Search-specific env vars per provider id (mirrors upstream credential lookup). */
const WEB_SEARCH_ENV_CREDENTIALS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["ANTHROPIC_SEARCH_API_KEY", "ANTHROPIC_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
  codex: [],
  xai: ["XAI_API_KEY"],
  zai: ["ZAI_API_KEY"],
  exa: ["EXA_API_KEY"],
  tinyfish: ["TINYFISH_API_KEY"],
  sofya: ["SOFYA_API_KEY"],
  keenable: ["KEENABLE_API_KEY"],
  jina: ["JINA_API_KEY"],
  kagi: ["KAGI_API_KEY"],
  tavily: ["TAVILY_API_KEY"],
  firecrawl: ["FIRECRAWL_API_KEY"],
  brave: ["BRAVE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  kimi: ["MOONSHOT_SEARCH_API_KEY", "KIMI_SEARCH_API_KEY"],
  parallel: ["PARALLEL_API_KEY"],
  ollama: ["OLLAMA_CLOUD_API_KEY"],
  synthetic: ["SYNTHETIC_API_KEY"],
  searxng: ["SEARXNG_ENDPOINT"],
  perplexity: ["PERPLEXITY_API_KEY", "PERPLEXITY_COOKIES"],
};

/** agent.db auth ids that satisfy a search provider's credential (OAuth/登录). */
const WEB_SEARCH_AUTH_IDS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["anthropic"],
  gemini: ["google-gemini-cli", "google-antigravity", "google"],
  codex: ["openai-codex"],
  xai: ["xai-oauth", "xai"],
  zai: ["zai"],
  exa: ["exa"],
  tinyfish: ["tinyfish"],
  sofya: ["sofya"],
  keenable: ["keenable"],
  kimi: ["kimi-code"],
  kagi: ["kagi"],
  parallel: ["parallel"],
  ollama: ["ollama-cloud"],
  synthetic: ["synthetic"],
  tavily: ["tavily"],
  firecrawl: ["firecrawl"],
  brave: ["brave"],
  deepseek: ["deepseek"],
  perplexity: ["perplexity"],
};

/**
 * agent.db provider id each engine reads an `api_key` credential from
 * (mirrors the upstream `authStorage.getApiKey(<id>)` calls). Engines absent
 * here (codex = ChatGPT OAuth only; searxng = endpoint settings; scraper
 * engines) have no direct api-key path.
 */
const WEB_SEARCH_APIKEY_IDS: Readonly<Record<string, string>> = {
  perplexity: "perplexity",
  gemini: "google",
  anthropic: "anthropic",
  xai: "xai",
  zai: "zai",
  exa: "exa",
  tinyfish: "tinyfish",
  sofya: "sofya",
  keenable: "keenable",
  jina: "jina",
  kagi: "kagi",
  tavily: "tavily",
  firecrawl: "firecrawl",
  brave: "brave",
  deepseek: "deepseek",
  kimi: "kimi-code",
  parallel: "parallel",
  ollama: "ollama-cloud",
  synthetic: "synthetic",
};

/** Native login availability and API-key-vs-OAuth flow come from AuthStorage's registry, not the old RPC prompt-order whitelist. */
function hasWebSearchCredential(
  providerId: string,
  authenticated: ReadonlySet<string>,
): boolean {
  const envNames = WEB_SEARCH_ENV_CREDENTIALS[providerId] ?? [];
  if (envNames.some((name) => (process.env[name] ?? "").length > 0)) return true;
  const authIds = WEB_SEARCH_AUTH_IDS[providerId] ?? [];
  return authIds.some((id) => authenticated.has(id));
}

const presetGroups = (): ReadonlyArray<ModelPresetGroup> => [
  {
    group: hostText("官方 / 主流", "Official / Popular"),
    items: [
      { id: "mistral", name: "Mistral", desc: hostText("Mistral Vibe 浏览器登录或 API Key", "Mistral Vibe browser login or API key"), api: "openai-completions", auth: ["oauth", "api-key"], oauth: true, endpoint: "https://api.mistral.ai/v1" },
      { id: "devin", name: "Devin", desc: hostText("导入 Devin CLI 凭据或使用 Windsurf 企业账号", "Import Devin CLI credentials or use Windsurf enterprise account"), api: "devin", auth: ["oauth", "api-key"], oauth: true },
      { id: "muse-code", name: "Muse Code", desc: hostText("Muse Spark 订阅、账号模型发现与额度", "Muse Spark subscription, account model discovery, and quota"), api: "openai-responses", auth: ["oauth"], oauth: true },
      { id: "anthropic", name: "Anthropic", desc: hostText("Claude 系列模型官方 API", "Official Claude model API"), api: "anthropic-messages", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.anthropic.com/v1" },
      { id: "openai", name: "OpenAI", desc: hostText("GPT 系列模型官方 API", "Official GPT model API"), api: "openai-responses", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.openai.com/v1" },
      { id: "openai-codex", name: "OpenAI Codex", desc: hostText("Codex 订阅额度（ChatGPT 账号）", "Codex subscription quota (ChatGPT account)"), api: "openai-codex-responses", auth: ["oauth"], oauth: true, endpoint: "https://api.openai.com/v1" },
      { id: "google-gemini", name: "Google Gemini", desc: hostText("Gemini 系列模型官方 API", "Official Gemini model API"), api: "google-generative-ai", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://generativelanguage.googleapis.com/v1beta" },
      { id: "gemini-cli", name: "Google Gemini CLI", desc: hostText("Gemini Code Assist 订阅", "Gemini Code Assist subscription"), api: "google-gemini-cli", auth: ["oauth"], oauth: true },
      { id: "antigravity-cli", name: "Antigravity CLI", desc: hostText("Runtime 托管的 ACP 服务，不是 HTTP API 配置", "Runtime-managed ACP service, not an HTTP API configuration"), api: "antigravity-acp", auth: ["oauth"], oauth: true, configurationMode: "managed" },
      { id: "xai", name: "xAI", desc: hostText("Grok 系列模型", "Grok model family"), api: "openai-responses", auth: ["api-key"], endpoint: "https://api.x.ai/v1" },
      { id: "groq", name: "Groq", desc: hostText("高速推理（Llama / Mixtral）", "High-speed inference (Llama / Mixtral)"), api: "openai-completions", auth: ["api-key"], endpoint: "https://api.groq.com/openai/v1" },
      { id: "deepseek", name: "DeepSeek", desc: hostText("DeepSeek V / R 系列", "DeepSeek V / R series"), api: "openai-completions", auth: ["api-key"], endpoint: "https://api.deepseek.com/v1" },
      { id: "moonshot", name: "Moonshot / Kimi", desc: hostText("Kimi K 系列模型", "Kimi K series models"), api: "openai-completions", auth: ["api-key"], endpoint: "https://api.moonshot.cn/v1" },
    ],
  },
  {
    group: hostText("Gateway / 聚合", "Gateway / Aggregators"),
    items: [
      { id: "modular", name: "Modular Cloud", desc: hostText("Modular Cloud 模型与原生推理参数", "Modular Cloud models and native reasoning parameters"), api: "openai-completions", auth: ["api-key", "env"], endpoint: "https://api.modular.com/v1" },
      { id: "commandcode", name: "Command Code", desc: hostText("原生 OpenAI / Anthropic 路由、模型发现与价格", "Native OpenAI / Anthropic routing, discovery, and pricing"), api: "openai-completions", auth: ["api-key", "env"], endpoint: "https://api.commandcode.ai/provider/v1" },
      { id: "openrouter", name: "OpenRouter", desc: hostText("账号授权目录与多供应商路由", "Account-authorized catalog and multi-provider routing"), api: "openrouter", auth: ["api-key"], popular: true, endpoint: "https://openrouter.ai/api/v1" },
      { id: "github-copilot", name: "GitHub Copilot", desc: hostText("Copilot 订阅额度", "Copilot subscription quota"), api: "openai-responses", auth: ["oauth"], oauth: true },
      { id: "litellm", name: "LiteLLM", desc: hostText("自托管统一模型代理", "Self-hosted unified model proxy"), api: "openai-completions", auth: ["api-key", "env"], endpoint: "http://localhost:4000/v1", discovery: "litellm" },
    ],
  },
  {
    group: hostText("本地", "Local"),
    items: [
      { id: "ollama", name: "Ollama", desc: hostText("本地模型服务，自动发现已拉取模型", "Local model server; auto-discovers pulled models"), api: "openai-completions", auth: ["none"], local: true, popular: true, endpoint: "http://localhost:11434/v1", discovery: "ollama" },
      { id: "lm-studio", name: "LM Studio", desc: hostText("本地 OpenAI 兼容服务", "Local OpenAI-compatible server"), api: "openai-completions", auth: ["none"], local: true, endpoint: "http://localhost:1234/v1", discovery: "lm-studio" },
      { id: "llama.cpp", name: "llama.cpp", desc: hostText("llama-server OpenAI 兼容接口", "llama-server OpenAI-compatible endpoint"), api: "openai-completions", auth: ["none"], local: true, endpoint: "http://localhost:8080/v1", discovery: "llama.cpp" },
    ],
  },
  {
    group: hostText("更多 Provider", "More Providers"),
    items: [
      { id: "google", name: "Google Decisions", desc: hostText("原生 Judge 决策模型", "Native Judge decision models"), api: "google-decisions", auth: ["api-key", "env"], endpoint: "https://generativelanguage.googleapis.com/v1beta" },
      { id: "nace", name: "Nace", desc: hostText("Drex 原生 Judge 模型", "Drex native Judge models"), api: "nace-systemone", auth: ["api-key", "env"], endpoint: "https://console.nace.ai" },
      { id: "qwen", name: "Qwen", desc: hostText("通义千问官方 API", "Official Qwen (Tongyi Qianwen) API"), api: "openai-completions", auth: ["api-key"], endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
      { id: "zhipu", name: hostText("Zhipu / 智谱", "Zhipu"), desc: hostText("GLM 系列模型", "GLM series models"), api: "openai-completions", auth: ["api-key"], endpoint: "https://open.bigmodel.cn/api/paas/v4" },
      { id: "fireworks", name: "Fireworks", desc: hostText("Fireworks AI 托管推理", "Fireworks AI hosted inference"), api: "openai-completions", auth: ["api-key"], endpoint: "https://api.fireworks.ai/inference/v1" },
      { id: "siliconflow", name: "SiliconFlow", desc: hostText("硅基流动模型云", "SiliconFlow model cloud"), api: "openai-completions", auth: ["api-key"], endpoint: "https://api.siliconflow.cn/v1" },
    ],
  },
];

const writeOk = (): ConfigWriteResult => ({
  applied: true,
  runtimeEffect: "new-session",
  message: hostText("已保存", "Saved"),
});

export interface OmpModelsAdapterOptions {
  readonly locateOmp?: () => Promise<string | undefined>;
  readonly openUrl?: (url: string) => Promise<void>;
  readonly exec?: (exe: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  /** Fetch implementation for connection probes; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Agent config directory; defaults to `~/.omp/agent` (test injection). */
  readonly agentDir?: string;
  readonly catalogCachePath?: string;
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
  if (["openrouter", "openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "google-generative-ai", "google-vertex"].includes(api)) return `${trimmed}/models`;
  // Judge/managed transports and unknown APIs do not inherit an OpenAI /models endpoint.
  return undefined;
}

/** Classify a probe network error into a user-facing Chinese detail. */
export function networkErrorDetail(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return hostText("连接失败：请求超时", "Connection failed: request timed out");
  const cause = (error as { cause?: NodeJS.ErrnoException }).cause;
  const code = cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return hostText("连接失败：域名无法解析", "Connection failed: failed to resolve hostname");
  if (code === "ECONNREFUSED") return hostText("连接失败：连接被拒绝", "Connection failed: connection refused");
  if (code === "ECONNRESET" || code === "EPIPE") return hostText("连接失败：连接被重置", "Connection failed: connection reset");
  if (typeof code === "string" && code.includes("CERT")) return hostText("连接失败：TLS 证书错误", "Connection failed: TLS certificate error");
  return hostText("连接失败：网络不可达", "Connection failed: network unreachable");
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

export function envHasValue(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

export function envHasSecret(id: string): boolean {
  return envHasValue(envNameForProvider(id));
}

/** True when a models.yml `apiKey` should be treated as an env var name. */
export function isEnvConfigName(value: string): boolean {
  return isModelEnvConfigName(value) || envHasValue(value);
}

/** Resolve a stored `apiKey` (literal, env name, or `!command`) to a secret. */
export function materializeApiKey(key: string | undefined): string | undefined {
  if (typeof key !== "string" || key.length === 0) return undefined;
  if (key.startsWith("!")) return undefined;
  if (isEnvConfigName(key)) return envHasValue(key) ? process.env[key] : undefined;
  return key;
}

function resolveRequestApiKey(
  key: string | undefined,
  fallbackProviderId?: string,
): { command: true } | { missingEnv: string } | { value?: string } {
  if (typeof key === "string" && key.startsWith("!")) return { command: true };
  if (typeof key === "string" && isEnvConfigName(key)) {
    const value = materializeApiKey(key);
    return value ? { value } : { missingEnv: key };
  }
  if (typeof key === "string" && key.length > 0) return { value: key };
  if (fallbackProviderId) {
    const value = materializeApiKey(envNameForProvider(fallbackProviderId));
    if (value) return { value };
  }
  return {};
}

export function ollamaTagsUrl(base: string): string {
  return `${base.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/tags`;
}

export function litellmInfoUrls(base: string): string[] {
  const root = base.replace(/\/+$/, "").replace(/\/v1$/i, "");
  return [`${root}/model_group/info`, `${root}/v2/model/info`, `${root}/model/info`, `${root}/v1/model/info`, `${root}/v1/models`, `${root}/models`];
}

/** Anthropic rejects `/v1/models` without an explicit API version header. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Model-list request for a wire API: candidate URLs plus the auth header shape
 * that API expects. Shared by the connection test (single authoritative URL)
 * and the model-list fetch (which also retries the `/v1/models` variant when a
 * base URL omits the version segment).
 *
 * `urls` is empty for APIs with no model-list surface (bedrock, gemini-cli);
 * callers must fall back to plain reachability or report the gap.
 */
export function modelListRequest(
  base: string,
  api: string,
  apiKey?: string,
): { urls: string[]; headers: Record<string, string> } {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    if (api === "anthropic-messages") {
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = ANTHROPIC_VERSION;
    } else if (api === "google-generative-ai" || api === "google-vertex" || api === "google-decisions") {
      headers["x-goog-api-key"] = apiKey;
    } else {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  } else if (api === "anthropic-messages") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
  }
  const primary = authProbeUrl(base, api);
  if (primary === undefined) return { urls: [], headers };
  const trimmed = base.replace(/\/+$/, "");
  const versioned = `${trimmed.replace(/\/v1$/i, "")}/v1/models`;
  const urls = primary === versioned ? [primary] : [primary, versioned];
  return { urls, headers };
}

/** Positive integer from a number or numeric string; undefined when unusable. */
function probePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
  }
  return undefined;
}

function probeRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Image input as reported by the endpoint: an `input_modalities` list
 * (OpenRouter / vLLM) or a `modality` string like `text+image->text`.
 * Undefined when the endpoint says nothing.
 */
function probeImageInput(row: Record<string, unknown>): boolean | undefined {
  const architecture = probeRecord(row.architecture);
  for (const candidate of [row.input_modalities, row.input, architecture?.input_modalities, architecture?.modality]) {
    if (Array.isArray(candidate)) {
      return candidate.some((item) => typeof item === "string" && item.toLowerCase().includes("image"));
    }
    if (typeof candidate === "string" && candidate.length > 0) {
      const inputs = candidate.split("->")[0] ?? "";
      return inputs.toLowerCase().includes("image");
    }
  }
  return undefined;
}

/** Reasoning support as reported by the endpoint (OpenRouter / Ollama shapes). */
function probeReasoning(row: Record<string, unknown>): boolean | undefined {
  const metadata = probeRecord(row.metadata);
  const capabilities = probeRecord(row.capabilities);
  if (typeof capabilities?.reasoning === "boolean" && row.reasoning === undefined && metadata?.reasoning === undefined) return capabilities.reasoning;
  if (typeof (metadata?.reasoning ?? row.reasoning) === "boolean") return (metadata?.reasoning ?? row.reasoning) as boolean;
  if (Array.isArray(row.supported_parameters)) {
    return row.supported_parameters.some((item) => typeof item === "string" && item.toLowerCase().includes("reasoning"));
  }
  if (Array.isArray(row.capabilities)) {
    return row.capabilities.some(
      (item) => typeof item === "string" && (item.toLowerCase() === "thinking" || item.toLowerCase() === "reasoning"),
    );
  }
  return undefined;
}

/**
 * Metadata an endpoint volunteered about one model. Keys are omitted when
 * unknown so nothing overrides OMP's bundled catalog on import.
 */
function probeModelMeta(row: Record<string, unknown>): Omit<ModelDiscoveryModel, "id" | "name"> {
  row = { ...row, ...(probeRecord(row.metadata) ?? {}), ...(probeRecord(row.model_info) ?? {}) };
  const topProvider = probeRecord(row.top_provider);
  const contextWindow =
    probePositiveInt(row.contextWindow) ??
    probePositiveInt(row.context_length) ??
    probePositiveInt(row.max_model_len) ??
    probePositiveInt(row.context_window) ??
    probePositiveInt(row.max_context_length) ??
    probePositiveInt(row.inputTokenLimit) ??
    probePositiveInt(topProvider?.context_length);
  const maxTokens =
    probePositiveInt(row.maxTokens) ??
    probePositiveInt(topProvider?.max_completion_tokens) ??
    probePositiveInt(row.max_output_tokens) ??
    probePositiveInt(row.outputTokenLimit) ??
    probePositiveInt(row.max_tokens);
  const reasoning = probeReasoning(row);
  const levels = Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels.map(value => typeof value === "string" ? value.toLowerCase() : typeof probeRecord(value)?.effort === "string" ? String(probeRecord(value)?.effort).toLowerCase() : "").filter(value => ["minimal", "low", "medium", "high", "xhigh", "max"].includes(value)) : [];
  const defaultLevel = typeof row.default_reasoning_level === "string" ? row.default_reasoning_level.toLowerCase() : undefined;
  const thinkingConfig = reasoning === false ? undefined : parseModelThinkingConfig(row.thinking) ?? parseModelThinkingConfig({ mode: "effort", efforts: levels, defaultLevel, effortMap: row.reasoning_effort_map, ...(typeof row.reasoning_required === "boolean" ? { requiresEffort: row.reasoning_required } : {}) });
  const image = probeImageInput(row) ?? (typeof probeRecord(row.capabilities)?.vision === "boolean" ? probeRecord(row.capabilities)!.vision as boolean : undefined);
  const nativeInfo = probeRecord(row.model_info);
  const judge = row.type === "decision" || row.mode === "decisions" || nativeInfo?.mode === "decisions";
  return {
    ...(typeof row.api === "string" ? { api: row.api } : {}),
    ...(thinkingConfig ? { thinkingConfig, reasoning: true } : {}),
    ...(judge ? { kind: "judge" as const, api: "openai-decisions" } : parseModelKind(row.kind) === undefined ? {} : { kind: parseModelKind(row.kind)! }),
    ...(typeof row.webSearch === "string" && row.webSearch.trim() ? { webSearch: row.webSearch } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(image === undefined ? {} : { image }),
  };
}

/**
 * Normalize a model-list payload into `{ id, name, …metadata }` rows.
 *
 * Tolerates the shapes real endpoints return: OpenAI-compatible
 * `{ data: [{ id }] }`, Anthropic's `display_name`, Google Generative AI's
 * `{ models: [{ name: "models/x", displayName, inputTokenLimit }] }`, Ollama
 * `{ models: [{ name: "qwen3:32b" }] }`, LiteLLM `model_name`, and bare arrays.
 */
export function parseDiscoveryModels(payload: unknown, advertisedReasoning = true): ModelDiscoveryModel[] {
  const out: ModelDiscoveryModel[] = [];
  const seen = new Set<string>();
  const push = (id: string, name?: string, meta?: Omit<ModelDiscoveryModel, "id" | "name">) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    const metadata = { ...(meta ?? {}) };
    if (!advertisedReasoning) { delete metadata.thinkingConfig; delete metadata.reasoning; }
    out.push({ id: trimmed, name: name && name.trim().length > 0 ? name.trim() : trimmed, ...metadata });
  };
  if (!payload || typeof payload !== "object") return out;
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.models)) {
    for (const item of record.models) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        if (probeRecord(row.capabilities)?.completion_chat === false) continue;
        const rawName = typeof row.name === "string" ? row.name : undefined;
        // Google Generative AI names models `models/<id>` and carries the
        // human label in `displayName`; Ollama's `name` already is the id.
        const googleId = rawName?.startsWith("models/") === true ? rawName.slice("models/".length) : undefined;
        const id = googleId ?? (typeof row.id === "string" ? row.id : rawName ?? (typeof row.model === "string" ? row.model : ""));
        const label = typeof row.displayName === "string"
          ? row.displayName
          : googleId ?? rawName ?? (typeof row.id === "string" ? row.id : undefined);
        push(id, label, probeModelMeta(row));
      }
    }
  }
  if (Array.isArray(record.data)) {
    for (const item of record.data) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        if (probeRecord(row.capabilities)?.completion_chat === false) continue;
        const id = typeof row.id === "string" ? row.id : typeof row.model_name === "string" ? row.model_name : "";
        const meta = probeRecord(row.metadata);
        const label = typeof row.display_name === "string"
          ? row.display_name
          : typeof meta?.display_name === "string" ? meta.display_name : typeof row.name === "string" ? row.name : undefined;
        push(id, label, probeModelMeta(row));
      }
    }
  }
  if (Array.isArray(record.data) === false && Array.isArray(payload)) {
    for (const item of payload as unknown[]) {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        if (probeRecord(row.capabilities)?.completion_chat === false) continue;
        const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name : "";
        push(id, undefined, probeModelMeta(row));
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
  discovery?: { type?: string; timeoutMs?: number; advertisedReasoning?: boolean };
  models?: Array<Record<string, YamlValue>>;
  modelOverrides?: unknown;
  disableStrictTools?: boolean;
  remoteCompaction?: unknown;
  transport?: string;
}

function webSearchProviderRecord(
  provider: { id: string; name: string; description: string; credentialFree: boolean; siteRoute?: string },
  authenticated: ReadonlySet<string>,
  authKinds: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const envKeys = WEB_SEARCH_ENV_CREDENTIALS[provider.id] ?? [];
  const authIds = WEB_SEARCH_AUTH_IDS[provider.id] ?? [];
  const firstAuthId = authIds[0];
  const loginId = firstAuthId;
  const apiKeyId = WEB_SEARCH_APIKEY_IDS[provider.id];
  const hasEnv = envKeys.some((name) => (process.env[name] ?? "").length > 0);
  const hasApiKeyRow = Boolean(apiKeyId && authKinds.get(apiKeyId)?.has("api_key"))
    || authIds.some((id) => authKinds.get(id)?.has("api_key"));
  const hasOAuthRow = authIds.some((id) => authKinds.get(id)?.has("oauth"));
  const credentialKind = hasEnv
      ? "env" as const
      : hasApiKeyRow
        ? "api-key" as const
        : hasOAuthRow
          ? "oauth" as const
          : undefined;
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    credentialFree: provider.credentialFree,
    ...(provider.siteRoute ? { siteRoute: provider.siteRoute } : {}),
    hasCredential: hasWebSearchCredential(provider.id, authenticated),
    envKeys,
    credentialProviders: [...new Set([...(apiKeyId ? [apiKeyId] : []), ...authIds])],
    ...(loginId !== undefined ? { loginId } : {}),
    ...(apiKeyId !== undefined ? { apiKeyId } : {}),
    ...(credentialKind !== undefined ? { credentialKind } : {}),
  };
}

function emptyWebSearch(): WebSearchConfigReadModel {
  return {
    routing: readWebRouting({}),
    enabled: true,
    order: [],
    exclude: [],
    timeoutSeconds: 60,
    geminiModel: "",
    providers: WEB_SEARCH_PROVIDER_CATALOG.map((provider) => webSearchProviderRecord(provider, new Set(), new Map())),
    advanced: {
      searxng: { endpoint: "", tokenSet: false, basicUsername: "", passwordSet: false },
      exa: { enabled: true, searchDelayMs: 1000 },
    },
  };
}

function emptyModel(reason: string, ompAvailable: boolean): ModelConfigReadModel {
  return {
    providers: [],
    presets: presetGroups(),
    roles: builtinRoles().map((role) => ({
      ...role,
      builtin: true,
      primary: "",
      scope: "global",
    })),
    cycleOrder: ["smol", "default", "slow"],
    availableModels: [],
    availability: { status: "unverified", source: "none", reason },
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
    webSearch: emptyWebSearch(),
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function asRecord(value: YamlValue | undefined): Record<string, YamlValue> | undefined;
function asRecord(value: unknown): Record<string, unknown> | undefined;
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
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

function authFromYaml(
  provider: ProviderYaml,
  providerId: string,
): { type: ModelAuthType; hasSecret: boolean; apiKey?: string; envName?: string } {
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
  if (typeof key === "string" && isEnvConfigName(key)) {
    return { type: "env", hasSecret: envHasValue(key), envName: key };
  }
  if (typeof key === "string" && key.length > 0) return { type: "api-key", hasSecret: true, apiKey: key };
  const conventional = envNameForProvider(providerId);
  if (envHasValue(conventional)) return { type: "env", hasSecret: true, envName: conventional };
  return { type: "api-key", hasSecret: false };
}

function parseThinking(selector: string): { primary: string; thinking?: string } {
  const match = selector.match(/^(.*):([a-z]+)$/);
  if (!match) return { primary: selector };
  const level = match[2];
  if (!level || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
    return { primary: selector };
  }
  return { primary: match[1] ?? selector, thinking: level };
}

function cacheNumber(value: unknown, allowZero = false): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && (value > 0 || (allowZero && value === 0)) ? value : undefined;
}

function cacheCost(value: unknown): ModelCostMeta | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = cacheNumber(record.input, true);
  const output = cacheNumber(record.output, true);
  const cacheRead = cacheNumber(record.cacheRead, true);
  const cacheWrite = cacheNumber(record.cacheWrite, true);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
    ...(cacheRead === undefined ? {} : { cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWrite }),
  };
}

/** Preserve bounded public metadata without carrying provider endpoints or headers. */
export function executionMetadata(value: unknown): ModelExecutionMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const model = value as Record<string, unknown>;
  const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f]/u.test(value)).slice(0,32) : undefined;
  const cache = (value: unknown): { short?: number; long?: number } | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Record<string, unknown>; const result: { short?: number; long?: number } = {};
    for (const key of ["short", "long"] as const) if (typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0) result[key] = row[key];
    return result;
  };
  const promptCache = cache(model.promptCache), promptCacheConfig = cache(model.promptCacheConfig);
  const source = { ...model, ...(asRecord(model.compat) ?? {}), ...(asRecord(model.compatibility) ?? {}) };
  const compatibility = { ...(typeof source.supportsMessageThreads === "boolean" ? { supportsMessageThreads: source.supportsMessageThreads } : {}), ...(typeof source.toolNamePrefix === "string" ? { toolNamePrefix: source.toolNamePrefix } : {}), ...(typeof source.statefulResponses === "boolean" ? { statefulResponses: source.statefulResponses } : {}), ...(typeof source.preferWebsockets === "boolean" ? { preferWebsockets: source.preferWebsockets } : {}), ...(typeof source.useResponsesLite === "boolean" ? { useResponsesLite: source.useResponsesLite } : {}), ...(source.toolMode === "code_mode_only" ? { toolMode: "code_mode_only" as const } : {}) };
  return { ...(tiers === undefined ? {} : { serviceTiers: tiers }), ...(promptCache === undefined ? {} : { promptCache }), ...(promptCacheConfig === undefined ? {} : { promptCacheConfig }), ...(Object.keys(compatibility).length ? { compatibility } : {}) };
}

/** Project imported catalog metadata for display only. This helper does not establish availability. */
export function availableFromCacheModel(
  model: Record<string, unknown>,
  providerFallback: string,
): AvailableModelRecord | undefined {
  const id = typeof model.id === "string" ? model.id : "";
  if (!id) return undefined;
  const providerOf = typeof model.provider === "string" && model.provider.length > 0 ? model.provider : providerFallback;
  if (!providerOf) return undefined;
  const input = model.input;
  const compat = model.compat !== null && typeof model.compat === "object" ? model.compat as Record<string, unknown> : undefined;
  const image = Array.isArray(input) && input.includes("image") && compat?.stripImageInput !== true;
  const thinking = parseCacheThinkingEfforts(model.thinking);
  const thinkingConfig = parseModelThinkingConfig(model.thinking);
  const contextWindow = cacheNumber(model.contextWindow);
  const maxTokens = cacheNumber(model.maxTokens);
  const cost = cacheCost(model.cost);
  const pricing = parseModelPricing(model.cost);
  const maxContextWindow = cacheNumber(model.maxContextWindow);
  return {
    ...executionMetadata(model),
    provider: providerOf,
    id,
    selector: typeof model.selector === "string" && model.selector.length > 0 ? model.selector : `${providerOf}/${id}`,
    name: typeof model.name === "string" && model.name.length > 0 ? model.name : id,
    reasoning: model.reasoning === true,
    ...(parseModelKind(model.kind) ? { kind: parseModelKind(model.kind)! } : {}),
    ...(typeof model.webSearch === "string" ? { webSearch: model.webSearch } : {}),
    image,
    tools: model.supportsTools !== false,
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(thinking.length > 0 ? { thinking } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
    ...(cost ? { cost } : {}),
    ...(pricing ? { pricing } : {}),
    ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
    ...(typeof model.api === "string" ? { api: model.api } : {}),
  };
}

export function catalogEntryFromAvailable(model: AvailableModelRecord): ModelCatalogEntry {
  const { provider: _provider, source, ...metadata } = model;
  return {
    ...metadata,
    image: model.image === true,
    tools: model.tools !== false,
    status: "available",
    source: source === "registry" ? "discovery" : "catalog",
  };
}

export function availableFromCatalogEntry(providerId: string, model: ModelCatalogEntry): AvailableModelRecord {
  return {
    ...executionMetadata(model),
    provider: providerId,
    id: model.id,
    selector: model.selector,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.kind === undefined ? {} : { kind: model.kind }),
    ...(model.webSearch === undefined ? {} : { webSearch: model.webSearch }),
    image: model.image,
    tools: model.tools,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.cost ? { cost: model.cost } : {}),
    ...(model.pricing ? { pricing: model.pricing } : {}),
    ...(model.maxContextWindow === undefined ? {} : { maxContextWindow: model.maxContextWindow }),
    ...(model.api === undefined ? {} : { api: model.api }),
    ...(model.thinking && model.thinking.length > 0 ? { thinking: model.thinking } : {}),
    ...(model.thinkingConfig === undefined ? {} : { thinkingConfig: model.thinkingConfig }),
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

function extrasFromYaml(entry: Record<string, YamlValue>): {
  bedrockMessagesApi?: boolean;
  requiresThinkingPresence?: boolean;
  extendedCacheTtlBeta?: boolean;
  statefulResponses?: boolean;
  preferWebsockets?: boolean;
  omitMaxOutputTokens?: boolean;
  premiumMultiplier?: number;
  imageCountBudget?: number;
  headers?: Record<string, string>;
  contextPromotionTarget?: string;
  compactionModel?: string;
  remoteCompaction?: ModelProviderRemoteCompaction;
  api?: string;
  baseUrl?: string;
} {
  const premiumMultiplier = numberOf(entry.premiumMultiplier);
  const imageCountBudget = numberOf(entry.imageCountBudget);
  const headers = stringMapOf(entry.headers);
  const contextPromotionTarget = stringOf(entry.contextPromotionTarget);
  const compactionModel = stringOf(entry.compactionModel);
  const remoteCompaction = remoteCompactionOf(entry.remoteCompaction);
  const api = stringOf(entry.api);
  const baseUrl = stringOf(entry.baseUrl);
  return {
    ...(typeof asRecord(entry.compat)?.requiresThinkingPresence === "boolean" ? { requiresThinkingPresence: asRecord(entry.compat)!.requiresThinkingPresence as boolean } : {}),
    ...(typeof entry.preferWebsockets === "boolean" ? { preferWebsockets: entry.preferWebsockets } : {}),
    ...(typeof asRecord(entry.compat)?.statefulResponses === "boolean" ? { statefulResponses: asRecord(entry.compat)!.statefulResponses as boolean } : {}),
    ...(typeof asRecord(entry.compat)?.extendedCacheTtlBeta === "boolean" ? { extendedCacheTtlBeta: asRecord(entry.compat)!.extendedCacheTtlBeta as boolean } : {}),
    ...(typeof entry.omitMaxOutputTokens === "boolean" ? { omitMaxOutputTokens: entry.omitMaxOutputTokens } : {}),
    ...(typeof asRecord(entry.compat)?.bedrockMessagesApi === "boolean" ? {bedrockMessagesApi: asRecord(entry.compat)!.bedrockMessagesApi as boolean} : {}),
    ...(premiumMultiplier === undefined ? {} : { premiumMultiplier }),
    ...(imageCountBudget === undefined ? {} : { imageCountBudget }),
    ...(headers ? { headers } : {}),
    ...(contextPromotionTarget === undefined ? {} : { contextPromotionTarget }),
    ...(compactionModel === undefined ? {} : { compactionModel }),
    ...(remoteCompaction ? { remoteCompaction } : {}),
    ...(api === undefined ? {} : { api }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

function writeOverrideRow(override: ModelOverridePatch, previous?: Record<string, YamlValue>): Record<string, YamlValue> | undefined {
  const row = providerOverrideYamlNode(override, previous) as Record<string, YamlValue>;
  return Object.keys(row).length ? row : undefined;
}

function parametersFromYaml(row: Record<string, YamlValue>): ModelParameterValues {
  const thinkingConfig = parseModelThinkingConfig(row.thinking);
  const shape = asRecord(row.snapcompactShape);
  const variant = stringOf(shape?.variant);
  const frameSize = numberOf(shape?.frameSize);
  return {
    ...(variant ? { snapcompactShape: { variant, ...(frameSize === undefined ? {} : { frameSize }) } } : {}),
    ...(numberOf(row.contextWindow) === undefined ? {} : { contextWindow: numberOf(row.contextWindow)! }),
    ...(numberOf(row.maxContextWindow) === undefined ? {} : { maxContextWindow: numberOf(row.maxContextWindow)! }),
    ...(numberOf(row.maxTokens) === undefined ? {} : { maxTokens: numberOf(row.maxTokens)! }),
    ...(typeof row.reasoning === "boolean" ? { reasoning: row.reasoning } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
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
    const parameters = parametersFromYaml(model);
    return [{
      ...executionMetadata(model),
      ...parameters, parameters,
      id: modelId,
      name: stringOf(model.name) ?? modelId,
      selector: `${id}/${modelId}`,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      image,
      reasoning: model.reasoning === true,
      ...(parseModelKind(model.kind) ? { kind: parseModelKind(model.kind)! } : {}),
      ...(typeof model.webSearch === "string" ? { webSearch: model.webSearch } : {}),
      tools: model.supportsTools !== false,
      ...(cost ? { cost } : {}),
      status: "unavailable" as const,
      source: "custom" as const,
      ...(extras.api === undefined ? {} : { api: extras.api }),
      ...(extras.baseUrl === undefined ? {} : { baseUrl: extras.baseUrl }),
      ...(extras.omitMaxOutputTokens === undefined ? {} : { omitMaxOutputTokens: extras.omitMaxOutputTokens }),
      ...(extras.bedrockMessagesApi === undefined ? {} : { bedrockMessagesApi: extras.bedrockMessagesApi }),
      ...(extras.requiresThinkingPresence === undefined ? {} : { requiresThinkingPresence: extras.requiresThinkingPresence }),
      ...(extras.extendedCacheTtlBeta === undefined ? {} : { extendedCacheTtlBeta: extras.extendedCacheTtlBeta }),
      ...(extras.statefulResponses === undefined ? {} : { statefulResponses: extras.statefulResponses }),
      ...(extras.preferWebsockets === undefined ? {} : { preferWebsockets: extras.preferWebsockets }),
      ...(extras.premiumMultiplier === undefined ? {} : { premiumMultiplier: extras.premiumMultiplier }),
      ...(extras.imageCountBudget === undefined ? {} : { imageCountBudget: extras.imageCountBudget }),
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
    const parameters = parametersFromYaml(entry);
    const patch: OverrideEntry = {
      ...parameters,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
      ...(typeof entry.supportsTools === "boolean" ? { tools: entry.supportsTools } : {}),
      ...(image === undefined ? {} : { image }),
      ...(cost ? { cost } : {}),
      ...(extras.omitMaxOutputTokens === undefined ? {} : { omitMaxOutputTokens: extras.omitMaxOutputTokens }),
      ...(extras.bedrockMessagesApi === undefined ? {} : { bedrockMessagesApi: extras.bedrockMessagesApi }),
      ...(extras.requiresThinkingPresence === undefined ? {} : { requiresThinkingPresence: extras.requiresThinkingPresence }),
      ...(extras.extendedCacheTtlBeta === undefined ? {} : { extendedCacheTtlBeta: extras.extendedCacheTtlBeta }),
      ...(extras.statefulResponses === undefined ? {} : { statefulResponses: extras.statefulResponses }),
      ...(extras.preferWebsockets === undefined ? {} : { preferWebsockets: extras.preferWebsockets }),
      ...(extras.premiumMultiplier === undefined ? {} : { premiumMultiplier: extras.premiumMultiplier }),
      ...(extras.imageCountBudget === undefined ? {} : { imageCountBudget: extras.imageCountBudget }),
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
  const base = { ...model };
  if (override.cost !== undefined) delete base.pricing;
  return {
    ...base,
    ...(override.name === undefined ? {} : { name: override.name }),
    ...(override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow }),
    ...(override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens }),
    ...(override.maxContextWindow === undefined ? {} : { maxContextWindow: override.maxContextWindow }),
    ...(override.thinkingConfig === undefined ? {} : { thinkingConfig: override.thinkingConfig }),
    ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
    ...(override.tools === undefined ? {} : { tools: override.tools }),
    ...(override.image === undefined ? {} : { image: override.image }),
    ...(override.cost === undefined ? {} : { cost: override.cost }),
    ...(override.omitMaxOutputTokens === undefined ? {} : { omitMaxOutputTokens: override.omitMaxOutputTokens }),
    ...(override.bedrockMessagesApi === undefined ? {} : { bedrockMessagesApi: override.bedrockMessagesApi }),
    ...(override.premiumMultiplier === undefined ? {} : { premiumMultiplier: override.premiumMultiplier }),
    ...(override.imageCountBudget === undefined ? {} : { imageCountBudget: override.imageCountBudget }),
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
    yaml.discovery = { type: discoveryType, ...(discoveryTimeout === undefined ? {} : { timeoutMs: discoveryTimeout }), ...(typeof asRecord(raw.discovery)?.advertisedReasoning === "boolean" ? { advertisedReasoning: asRecord(raw.discovery)!.advertisedReasoning as boolean } : {}) };
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
  let status: ModelProviderStatus = "offline";
  let statusDetail = hostText("已读取配置；当前 Runtime 可用性未验证", "Configuration loaded; current Runtime availability is unverified");
  if (disabled.has(id)) {
    status = "disabled";
    statusDetail = hostText("已在 disabledProviders 中禁用", "Disabled in disabledProviders");
  } else if (auth.type === "oauth" && !hasOAuth && !hasAvailable) {
    status = "not-authenticated";
    statusDetail = hostText("尚未登录", "Not logged in");
  } else if (auth.type !== "none" && auth.type !== "oauth" && !auth.hasSecret && !hasAvailable) {
    status = "not-authenticated";
    statusDetail = hostText("尚未配置凭据", "Credentials not configured");
  } else if (hasAvailable) {
    statusDetail = hostText("OMP 已解析到可用模型", "Available models resolved by OMP");
  }
  const preset = presetGroups().flatMap((group) => group.items).find((item) => item.id === id);
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
    configurationMode: id === "antigravity-cli" || yaml.api === "antigravity-acp" ? "managed" : "http",
    ...(endpointUrl === undefined ? {} : { endpointUrl }),
    local: Boolean(preset?.local ?? raw.local === true),
    enabled: !disabled.has(id),
    ...(yamlWebsite === undefined ? {} : { website: yamlWebsite }),
    ...(yamlNote === undefined || yamlNote.length === 0 ? {} : { note: yamlNote }),
    auth: {
      type: auth.type === "oauth" && hasOAuth ? "oauth" : auth.type,
      hasSecret: auth.type === "oauth" ? hasOAuth : auth.hasSecret,
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      ...(auth.envName === undefined ? {} : { envName: auth.envName }),
    },
    ...(yaml.discovery?.type
      ? { discovery: { type: yaml.discovery.type, ...(yaml.discovery.timeoutMs === undefined ? {} : { timeoutMs: yaml.discovery.timeoutMs }), ...(yaml.discovery.advertisedReasoning === undefined ? {} : { advertisedReasoning: yaml.discovery.advertisedReasoning }) } }
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

function providersFromAvailable(
  available: AvailableModelRecord[],
  existing: Set<string>,
  disabled: Set<string>,
  authenticated: Set<string>,
): ModelProviderRecord[] {
  const byProvider = new Map<string, AvailableModelRecord[]>();
  for (const model of available) {
    if (existing.has(model.provider)) continue;
    // The current Runtime already applied auth, keyless, disabled-provider and namespace policy.
    const list = byProvider.get(model.provider) ?? [];
    list.push(model);
    byProvider.set(model.provider, list);
  }
  return [...byProvider.entries()].map(([id, models]) => {
    const preset = presetGroups().flatMap((group) => group.items).find((item) => item.id === id);
    const authType = preset?.auth[0] ?? (authenticated.has(id) ? "oauth" : "api-key");
    const oauthOk = authType === "oauth" && authenticated.has(id);
    return {
      id,
      name: preset?.name ?? id,
      source: (preset ? "builtin" : "runtime") as ModelProviderRecord["source"],
      status: disabled.has(id) ? "disabled" : "available",
      statusDetail: disabled.has(id) ? hostText("已禁用", "Disabled") : hostText("OMP 已解析到可用模型", "Available models resolved by OMP"),
      api: models[0]?.api ?? mapApi(preset?.api),
      configurationMode: models[0]?.api === "antigravity-acp" ? "managed" : "http",
      ...(models[0]?.api === "antigravity-acp" || preset?.endpoint === undefined ? {} : { endpointUrl: preset.endpoint }),
      local: Boolean(preset?.local),
      enabled: !disabled.has(id),
      auth: {
        type: authType,
        hasSecret: authType === "none" || authType === "env" ? envHasSecret(id) || authType === "none" : oauthOk || authType !== "oauth",
        ...(authType === "env" ? { envName: envNameForProvider(id) } : {}),
      },
      ...(preset?.discovery ? { discovery: { type: preset.discovery } } : {}),
      models: models.map((model) => catalogEntryFromAvailable(model)),
    };
  });
}

/** Combine configuration with one current, complete Runtime generation. Recommendations never authorize selectors. */
export function withRuntimeModels(config: ModelConfigReadModel, snapshot?: Pick<ModelAvailablePage, "sessionId" | "version" | "total" | "truncated" | "models">, reason?: string): ModelConfigReadModel {
  const available = (snapshot?.models ?? []) as ReadonlyArray<AvailableModelRecord>;
  const bySelector = new Map(available.map(model => [model.selector, model]));
  const providers: ModelProviderRecord[] = config.providers.map(provider => {
    const selected = available.filter(model => model.provider === provider.id);
    const known = new Set(provider.models.map(model => model.selector));
    const models: ModelCatalogEntry[] = provider.models.map(model => {
      const native = bySelector.get(model.selector);
      return native
        ? { ...model, ...native, image: native.image === true, tools: native.tools !== false, source: model.source, status: "available" as const }
        : { ...model, status: provider.enabled ? "unavailable" as const : "disabled" as const };
    });
    models.push(...selected.filter(model => !known.has(model.selector)).map(model => catalogEntryFromAvailable(model)));
    const api = selected[0]?.api ?? provider.api;
    return {
      ...provider, api, models,
      configurationMode: api === "antigravity-acp" || provider.id === "antigravity-cli" ? "managed" as const : "http" as const,
      status: selected.length ? "available" as const : provider.status === "available" ? "offline" as const : provider.status,
      statusDetail: selected.length
        ? hostText("当前 Runtime 已解析到可用模型", "Available models resolved by the current Runtime")
        : snapshot ? hostText("当前 Runtime 未返回该供应商的可用模型", "The current Runtime returned no available models for this provider")
          : hostText("已读取配置；当前 Runtime 可用性未验证", "Configuration loaded; current Runtime availability is unverified"),
    };
  });
  providers.push(...providersFromAvailable([...available], new Set(providers.map(provider => provider.id)), new Set(), new Set(config.loginProviders.filter(provider => provider.authenticated).map(provider => provider.id))));
  const roles = config.roles.map(({ issue: _issue, ...role }) => {
    if (!snapshot || snapshot.truncated || !role.primary || bySelector.has(role.primary)) return role;
    return { ...role, issue: { kind: "model-missing" as const, detail: hostText(`${role.primary} 当前不在可用模型列表中`, `${role.primary} is not currently in the available models list`) } };
  });
  return {
    ...config, providers, roles, availableModels: available,
    availability: snapshot
      ? { status: "verified", source: "runtime", sessionId: snapshot.sessionId, version: snapshot.version, total: snapshot.total, truncated: snapshot.truncated }
      : { status: "unverified", source: "none", reason: reason ?? hostText("尚未从当前 Runtime 验证模型可用性", "Model availability has not been verified by the current Runtime") },
  };
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
      ...(asRecord(next.discovery) ?? {}),
      type: input.discovery.type,
      ...(input.discovery.advertisedReasoning === undefined ? {} : { advertisedReasoning: input.discovery.advertisedReasoning }),
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
  const prevWasEnv = prevApiKey !== undefined && !prevWasCommand && isEnvConfigName(prevApiKey);
  if (input.auth.type === "none") {
    next.auth = "none";
    delete next.apiKey;
  } else if (input.auth.type === "oauth") {
    next.auth = "oauth";
    // A leftover bearer/env-name would win over OAuth in OMP resolution.
    delete next.apiKey;
  } else if (input.auth.type === "command") {
    if (input.auth.command) {
      next.apiKey = input.auth.command.startsWith("!") ? input.auth.command : `!${input.auth.command}`;
    } else if (!prevWasCommand) {
      delete next.apiKey;
    }
    delete next.auth;
  } else if (input.auth.type === "api-key") {
    if (input.auth.clearSecret) delete next.apiKey;
    else if (input.auth.apiKey) next.apiKey = input.auth.apiKey;
    else if (prevWasCommand || prevWasEnv) delete next.apiKey;
    delete next.auth;
  } else if (input.auth.type === "env") {
    const name = input.auth.envName?.trim();
    next.apiKey = name && isEnvConfigName(name) ? name : envNameForProvider(input.id);
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
    const prevModelsList = Array.isArray(previous?.models) ? previous.models : undefined;
    next.models = input.models.map((model) => {
      const prevModel = prevModelsList?.find((item): item is Record<string, YamlValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item) && (item as Record<string, YamlValue>).id === model.id);
      return providerModelYamlNode(model, prevModel) as Record<string, YamlValue>;
    });
  }
  if (input.modelOverrides !== undefined) {
    if (input.modelOverrides === null || Object.keys(input.modelOverrides).length === 0) {
      delete next.modelOverrides;
    } else {
      const mapped: Record<string, YamlValue> = {};
      const prevOverrides = asRecord(previous?.modelOverrides);
      for (const [modelId, override] of Object.entries(input.modelOverrides)) {
        const prevOverride = asRecord(prevOverrides?.[modelId]);
        const row = writeOverrideRow(override, prevOverride);
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

/** The Runtime's agent directory, honoring profiles, XDG and `PI_CODING_AGENT_DIR` the same way. */
function defaultAgentDir(): string {
  return getAgentDir(homedir());
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
  const escapedRecord = escapeRegExp(recordKey);
  const escapedEntry = escapeRegExp(entryKey);

  // Block form: `recordKey:` on its own line followed by indented entries.
  const headerAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*$`).test(line));
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
      if (new RegExp(`^[ \\t]+${escapedEntry}:\\s*`).test(line)) {
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
  const inlineAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*\\{.*\\}\\s*$`).test(line));
  if (inlineAt >= 0) {
    const line = lines[inlineAt] ?? "";
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const body = line.slice(open + 1, close).trim();
    const entryRe = new RegExp(`(^|,\\s*)${escapedEntry}\\s*:\\s*[^,]*`);
    let nextBody: string;
    if (entryRe.test(body)) {
      nextBody = body.replace(entryRe, (_match, prefix: string) => `${prefix}${entryKey}: ${quoteInline(entryValue)}`);
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
 * Replace a string-list at `recordKey.entryKey` (e.g. `providers.webSearchOrder`)
 * with a targeted splice, so unrelated keys and comments in config.yml stay.
 * Handles the block record form (`providers:`), the inline record form
 * (`providers: { ... }`), and both block and inline list entries. A missing
 * record is appended as block form. Unlike `upsertYamlRecordEntry`, a
 * block-form list entry (`  entryKey:` + indented `- items`) is consumed
 * entirely so no stray items are left behind.
 */
export function upsertNestedRecordList(
  source: string,
  recordKey: string,
  entryKey: string,
  items: ReadonlyArray<string>,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const escapedRecord = escapeRegExp(recordKey);
  const escapedEntry = escapeRegExp(entryKey);
  const entryHeader = items.length === 0 ? `  ${entryKey}: []` : `  ${entryKey}:`;
  const itemLines = items.map((item) => `    - ${item}`);

  // Block record form: `recordKey:` on its own line followed by indented entries.
  const headerAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*$`).test(line));
  if (headerAt >= 0) {
    let cursor = headerAt + 1;
    let found: number | undefined;
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
      if (new RegExp(`^[ \\t]+${escapedEntry}:\\s*`).test(line)) {
        found = cursor;
        break;
      }
      cursor += 1;
    }
    if (found !== undefined) {
      let end = found + 1;
      // Consume the trailing indented `- item` lines owned by a block list entry.
      if (new RegExp(`^[ \\t]+${escapedEntry}:\\s*$`).test(lines[found] ?? "")) {
        while (end < lines.length) {
          const line = lines[end] ?? "";
          if (line.trim().length === 0) break;
          if (!/^[ \t]+-/.test(line)) break;
          end += 1;
        }
      }
      lines.splice(found, end - found, entryHeader, ...itemLines);
      return lines.join(newline);
    }
    lines.splice(insertAt ?? cursor, 0, entryHeader, ...itemLines);
    return lines.join(newline);
  }

  // Inline record form: `recordKey: { key: value, ... }` on a single line.
  const inlineAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*\\{.*\\}\\s*$`).test(line));
  if (inlineAt >= 0) {
    const line = lines[inlineAt] ?? "";
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const body = line.slice(open + 1, close).trim();
    const encoded = `[${items.join(", ")}]`;
    const entryRe = new RegExp(`(^|,\\s*)${escapedEntry}\\s*:\\s*[^,]*`);
    let nextBody: string;
    if (entryRe.test(body)) {
      nextBody = body.replace(entryRe, (_match, prefix: string) => `${prefix}${entryKey}: ${encoded}`);
    } else {
      nextBody = body.length > 0 ? `${body}, ${entryKey}: ${encoded}` : `${entryKey}: ${encoded}`;
    }
    lines[inlineAt] = `${recordKey}: { ${nextBody.trim()} }`;
    return lines.join(newline);
  }

  // Missing record: append block form.
  const suffix = source.endsWith("\n") ? "" : newline;
  return `${source}${suffix}${recordKey}:${newline}${entryHeader}${itemLines.length > 0 ? newline + itemLines.join(newline) : ""}${newline}`;
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
  const escapedRecord = escapeRegExp(recordKey);

  const headerAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*$`).test(line));
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

  const inlineAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*\\[.*\\]\\s*$`).test(line));
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
  const escapedRecord = escapeRegExp(recordKey);
  const escapedEntry = escapeRegExp(entryKey);
  const headerAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*$`).test(line));
  if (headerAt >= 0) {
    const found = lines.findIndex((line, index) => index > headerAt && new RegExp(`^[ \\t]+${escapedEntry}:\\s*`).test(line));
    if (found > headerAt) {
      lines.splice(found, 1);
      return lines.join(newline);
    }
  }
  const inlineAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*\\{.*\\}\\s*$`).test(line));
  if (inlineAt >= 0) {
    const line = lines[inlineAt] ?? "";
    const open = line.indexOf("{");
    const close = line.lastIndexOf("}");
    const parts = line.slice(open + 1, close).split(",").map((part) => part.trim()).filter((part) => part.length > 0 && !new RegExp(`^${escapedEntry}\\s*:`).test(part));
    lines[inlineAt] = `${recordKey}: { ${parts.join(", ")} }`;
    return lines.join(newline);
  }
  return source;
}

export function replaceYamlRecordStrings(source: string, recordKey: string, entries: Readonly<Record<string, string>>): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const escapedRecord = escapeRegExp(recordKey);
  const keys = Object.keys(entries);
  const block = keys.length === 0
    ? `${recordKey}: {}`
    : [`${recordKey}:`, ...keys.map((key) => `  ${key}: ${quoteInline(entries[key] ?? "")}`)].join(newline);
  const lines = source.split(/\r?\n/);
  const headerAt = lines.findIndex((line) => new RegExp(`^${escapedRecord}:\\s*$`).test(line) || new RegExp(`^${escapedRecord}:\\s*\\{.*\\}\\s*$`).test(line) || new RegExp(`^${escapedRecord}:\\s*\\{\\}\\s*$`).test(line));
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
  const escapedKey = escapeRegExp(key);
  const at = lines.findIndex((line) => new RegExp(`^${escapedKey}:\\s*`).test(line));
  const nextLine = `${key}: ${value}`;
  if (at >= 0) {
    lines[at] = nextLine;
    return lines.join(newline);
  }
  const suffix = source.endsWith("\n") ? "" : newline;
  return `${source}${suffix}${nextLine}${newline}`;
}

function patchYamlRoot(source: string, mutator: (root: Record<string, unknown>) => void): string {
  const doc: import("yaml").Document = parseDocument(source || "{}");
  if (doc.errors.length) throw new Error("Invalid config.yml");
  const original = doc.toJS() as unknown;
  if (original !== null && (typeof original !== "object" || Array.isArray(original))) throw new Error("config.yml must be a mapping");
  const before = (original ?? {}) as Record<string, unknown>;
  const root = structuredClone(before);
  mutator(root);
  const isMap = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const sync = (previous: Record<string, unknown>, next: Record<string, unknown>, path: string[]) => {
    for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) doc.deleteIn([...path, key]);
    for (const [key, value] of Object.entries(next)) {
      const old = previous[key]; const target = [...path, key];
      if (isMap(old) && isMap(value)) sync(old, value, target);
      else if (JSON.stringify(old) !== JSON.stringify(value)) doc.setIn(target, value);
    }
  };
  if (!doc.contents) doc.contents = doc.createNode({});
  sync(before, root, []);
  const out = doc.toString();
  return source.includes("\r\n") ? out.replace(/\n/g, "\r\n") : out;
}

export function createOmpModelsService(options: OmpModelsAdapterOptions = {}): HostModelsService {
  const locateOmp = options.locateOmp ?? defaultLocateOmp;
  const openUrl = options.openUrl;
  const doFetch = options.fetch ?? globalThis.fetch;
  const agentDirectory = options.agentDir ?? defaultAgentDir();
  const catalog = createModelCatalogService({ cachePath: options.catalogCachePath ?? join(agentDirectory, "studio-model-catalog.v1.json"), fetch: doFetch });
  const origins = createModelOriginStore(agentDirectory);


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

  type ParsedConfig = Record<string, unknown>;

  async function readRolesFromConfigFile(configPath: string, parsedOverride?: ParsedConfig): Promise<Record<string, string>> {
    try {
      const parsed = migrateModelRoleConfig(parsedOverride ?? (await readYamlFile(configPath)).root);
      const roles = asRecord(parsed.modelRoles as YamlValue | undefined);
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

  async function readStringList(configPath: string, key: string, parsedOverride?: ParsedConfig): Promise<string[]> {
    try {
      const parsed = migrateModelRoleConfig(parsedOverride ?? parseYaml(await readConfigText(configPath)));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const value = (parsed as ParsedConfig)[key];
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

  async function readCycleOrder(configPath: string, parsedOverride?: ParsedConfig): Promise<string[]> {
    return readStringList(configPath, "cycleOrder", parsedOverride);
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
    for (const [id, value] of Object.entries(asRecord(root.providers) ?? {})) {
      const provider = asRecord(value) ?? {};
      const models = Array.isArray(provider.models) ? provider.models : [];
      const overrides = Object.values(asRecord(provider.modelOverrides) ?? {});
      if (id === "antigravity-cli" || provider.api === "antigravity-acp" || [...models, ...overrides].some(model => asRecord(model)?.api === "antigravity-acp")) {
        throw { code: "INVALID_ARGUMENT", message: hostText("Antigravity ACP 由 Runtime 托管，不能保存为 models.yml HTTP 供应商。", "Antigravity ACP is managed by Runtime and cannot be saved as a models.yml HTTP provider.") };
      }
    }
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

  async function readScalar(configPath: string, key: string, parsedOverride?: ParsedConfig): Promise<string | undefined> {
    try {
      const parsed = migrateModelRoleConfig(parsedOverride ?? parseYaml(await readConfigText(configPath)));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const value = (parsed as Record<string, unknown>)[key];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /** Walk a dotted path into parsed config.yml (e.g. ["providers", "webSearchOrder"]). */
  async function readNested(configPath: string, path: readonly string[], parsedOverride?: ParsedConfig): Promise<unknown> {
    try {
      const parsed = migrateModelRoleConfig(parsedOverride ?? parseYaml(await readConfigText(configPath)));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      let current: unknown = parsed;
      for (const key of path) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
        current = (current as Record<string, unknown>)[key];
      }
      return current;
    } catch {
      return undefined;
    }
  }

  async function readNestedStringList(configPath: string, path: readonly string[], parsedOverride?: ParsedConfig): Promise<string[]> {
    const value = await readNested(configPath, path, parsedOverride);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  async function readNestedBool(configPath: string, path: readonly string[], fallback: boolean, parsedOverride?: ParsedConfig): Promise<boolean> {
    const value = await readNested(configPath, path, parsedOverride);
    return typeof value === "boolean" ? value : fallback;
  }

  async function readNestedNumber(configPath: string, path: readonly string[], fallback: number, parsedOverride?: ParsedConfig): Promise<number> {
    const value = await readNested(configPath, path, parsedOverride);
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  async function readNestedString(configPath: string, path: readonly string[], parsedOverride?: ParsedConfig): Promise<string> {
    const value = await readNested(configPath, path, parsedOverride);
    return typeof value === "string" ? value : "";
  }

  async function readWebSearch(
    configPath: string,
    authenticated: ReadonlySet<string>,
    authKinds: ReadonlyMap<string, ReadonlySet<string>>,
    parsedOverride?: ParsedConfig,
  ): Promise<WebSearchConfigReadModel> {
    const enabled = await readNestedBool(configPath, ["web_search", "enabled"], true, parsedOverride);
    const order = await readNestedStringList(configPath, ["providers", "webSearchOrder"], parsedOverride);
    const exclude = await readNestedStringList(configPath, ["providers", "webSearchExclude"], parsedOverride);
    const timeoutSeconds = await readNestedNumber(configPath, ["providers", "webSearchTimeoutSeconds"], 60, parsedOverride);
    const geminiModel = await readNestedString(configPath, ["providers", "webSearchGeminiModel"], parsedOverride);
    const searxngEndpoint = await readNestedString(configPath, ["searxng", "endpoint"], parsedOverride);
    const searxngTokenSet = Boolean(await readNestedString(configPath, ["searxng", "token"], parsedOverride));
    const searxngBasicUsername = await readNestedString(configPath, ["searxng", "basicUsername"], parsedOverride);
    const searxngPasswordSet = Boolean(await readNestedString(configPath, ["searxng", "basicPassword"], parsedOverride));
    const searxngCategories = await readNestedString(configPath, ["searxng", "categories"], parsedOverride);
    const searxngEngines = await readNestedString(configPath, ["searxng", "engines"], parsedOverride);
    const searxngLanguage = await readNestedString(configPath, ["searxng", "language"], parsedOverride);
    // safesearch 0 is a valid level; only absent/invalid values fall back to undefined.
    const safesearchRaw = await readNested(configPath, ["searxng", "safesearch"], parsedOverride);
    const searxngSafesearch =
      (safesearchRaw === 0 || safesearchRaw === 1 || safesearchRaw === 2) ? safesearchRaw : undefined;
    const exaEnabled = await readNestedBool(configPath, ["exa", "enabled"], true, parsedOverride);
    const exaSearchDelayMs = await readNestedNumber(configPath, ["exa", "searchDelayMs"], 1000, parsedOverride);
    return {
      routing: readWebRouting(parsedOverride ?? parseYaml(await readConfigText(configPath))),
      enabled,
      order,
      exclude,
      timeoutSeconds,
      geminiModel,
      providers: WEB_SEARCH_PROVIDER_CATALOG.map((provider) => webSearchProviderRecord(provider, authenticated, authKinds)),
      advanced: {
        searxng: {
          endpoint: searxngEndpoint,
          tokenSet: searxngTokenSet,
          basicUsername: searxngBasicUsername,
          passwordSet: searxngPasswordSet,
          categories: searxngCategories,
          engines: searxngEngines,
          language: searxngLanguage,
          ...(searxngSafesearch !== undefined ? { safesearch: searxngSafesearch } : {}),
        },
        exa: { enabled: exaEnabled, searchDelayMs: exaSearchDelayMs },
      },
    };
  }

  async function readFallback(configPath: string, parsedOverride?: ParsedConfig): Promise<{ chains: Record<string, string[]>; revertPolicy: ModelFallbackRevertPolicy }> {
    try {
      const parsed = migrateModelRoleConfig(parsedOverride ?? parseYaml(await readConfigText(configPath)));
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

  async function readModelTags(configPath: string, parsedOverride?: ParsedConfig): Promise<Record<string, { name: string; desc?: string; color?: string }>> {
    try {
      const parsed = migrateModelRoleConfig(parsedOverride ?? parseYaml(await readConfigText(configPath)));
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

  /** provider → enabled credential types ({"api_key","oauth"}) in agent.db. */
  async function readAuthCredentialKinds(agentDir: string): Promise<Map<string, Set<string>>> {
    const db = await openAuthDb(agentDir, true);
    if (!db) return new Map();
    try {
      const rows = db
        .prepare("SELECT DISTINCT provider, credential_type FROM auth_credentials WHERE disabled_cause IS NULL")
        .all() as unknown as Array<{ provider: string; credential_type: string }>;
      const kinds = new Map<string, Set<string>>();
      for (const row of rows) {
        if (typeof row.provider !== "string" || row.provider.length === 0) continue;
        const set = kinds.get(row.provider) ?? new Set<string>();
        set.add(row.credential_type);
        kinds.set(row.provider, set);
      }
      return kinds;
    } catch {
      return new Map();
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }

  async function readAuthData(agentDir: string): Promise<{
    authenticated: Set<string>;
    authKinds: Map<string, Set<string>>;
  }> {
    const authenticated = new Set<string>();
    const authKinds = new Map<string, Set<string>>();
    const db = await openAuthDb(agentDir, true);
    if (!db) return { authenticated, authKinds };
    try {
      const providers = db
        .prepare("SELECT DISTINCT provider FROM auth_credentials WHERE disabled_cause IS NULL")
        .all() as unknown as Array<{ provider: string }>;
      for (const row of providers) {
        if (typeof row.provider !== "string" || row.provider.length === 0) continue;
        authenticated.add(row.provider);
      }
      try {
        const rows = db
          .prepare("SELECT DISTINCT provider, credential_type FROM auth_credentials WHERE disabled_cause IS NULL")
          .all() as unknown as Array<{ provider: string; credential_type: string }>;
        for (const row of rows) {
          if (typeof row.provider !== "string" || row.provider.length === 0) continue;
          authenticated.add(row.provider);
          if (typeof row.credential_type !== "string" || row.credential_type.length === 0) continue;
          const kinds = authKinds.get(row.provider) ?? new Set<string>();
          kinds.add(row.credential_type);
          authKinds.set(row.provider, kinds);
        }
      } catch {
        // Older auth databases may not have credential_type; provider auth is
        // still valid and is already populated by the first query.
      }
    } catch {
      // Keep empty auth state, matching the forgiving individual readers.
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
    return { authenticated, authKinds };
  }

  async function logoutAuth(agentDir: string, providerId: string): Promise<number> {
    const db = await openAuthDb(agentDir, false);
    if (!db) throw { code: "UNAVAILABLE", message: hostText("未找到本机 auth 存储（agent.db）。请在终端运行 /logout。", "Local auth store (agent.db) not found. Run /logout in a terminal.") };
    try {
      const result = db
        .prepare("UPDATE auth_credentials SET disabled_cause = ?, updated_at = strftime('%s','now') WHERE provider = ? AND disabled_cause IS NULL")
        .run("logged out by user", providerId) as { changes?: number };
      return typeof result.changes === "number" ? result.changes : 0;
    } catch {
      throw { code: "UNAVAILABLE", message: hostText("无法更新 auth 存储。请在终端运行 /logout。", "Unable to update the auth store. Run /logout in a terminal.") };
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
    if (!cwd) throw { code: "UNAVAILABLE", message: hostText("未打开工作区，无法写入项目级角色。", "No workspace is open; cannot write project-scoped roles.") };
    return { path: join(getProjectConfigDir(cwd), "config.yml"), storage };
  }

  async function knownRoleIds(configPath: string): Promise<Set<string>> {
    const tags = await readModelTags(configPath);
    return new Set([...builtinRoles().map((role) => role.id), ...Object.keys(tags)]);
  }

  async function saveProviderOrigins(input: ModelProviderUpsertInput, written: Record<string, YamlValue>): Promise<boolean> {
      const records: Record<string, { values: ModelParameterValues; sources: ModelParameterSources }> = {};
      const savedSources = await origins.reader();
      for (const row of (written.models as Array<Record<string, YamlValue>> | undefined) ?? []) {
        const id = String(row.id);
        const values = parametersFromYaml(row);
        records[id] = { values, sources: input.models?.find(model => model.id === id)?.parameterSources ?? savedSources(input.id, id, values) };
      }
      for (const [id, raw] of Object.entries(asRecord(written.modelOverrides) ?? {})) {
        const row = asRecord(raw);
        if (!row) continue;
        const values = parametersFromYaml(row);
        records[id] = { values, sources: input.modelOverrides?.[id]?.parameterSources ?? savedSources(input.id, id, values) };
      }
      try { await origins.save(input.id, records); }
      catch { return false; }
      return true;
  }

  return {
    async get(): Promise<ModelConfigReadModel> {
      const paths = await resolvePaths();
      if (!paths) {
        return emptyModel(hostText(`未找到配置目录 ${defaultAgentDir()}。`, `Config directory not found: ${defaultAgentDir()}.`), false);
      }
      let file;
      try {
        file = await readModelsFile(paths.modelsPath);
      } catch (error) {
        const reason = error instanceof Error ? error.message : hostText("models.yml 无法解析", "Failed to parse models.yml");
        const fallback = emptyModel(hostText(`models.yml 校验失败：${reason}`, `models.yml validation failed: ${reason}`), false);
        return { ...fallback, generatedModelsYml: "# models.yml could not be parsed\n" };
      }
      let configRoot: ParsedConfig = {};
      try {
        const parsed = parseYaml(await readConfigText(paths.configPath)) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) configRoot = parsed as ParsedConfig;
      } catch {
        // Keep the same forgiving behavior as the individual config readers.
      }
      const modelRolesGlobal = await readRolesFromConfigFile(paths.configPath, configRoot);
      const storage = ((await readScalar(paths.configPath, "modelRoleStorage", configRoot)) === "project" ? "project" : "global") as ModelRoleStorage;
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
      const cycleOrder = await readCycleOrder(paths.configPath, configRoot);
      const modelProviderOrder = await readStringList(paths.configPath, "modelProviderOrder", configRoot);
      const fallback = await readFallback(paths.configPath, configRoot);
      if (storage === "project" && cwd) {
        const projectFallback = await readFallback(join(getProjectConfigDir(cwd), "config.yml"));
        Object.assign(fallback.chains, projectFallback.chains);
      }
      const tags = await readModelTags(paths.configPath, configRoot);
      const disabled = new Set(await readStringList(paths.configPath, "disabledProviders", configRoot));
      const { authenticated, authKinds } = await readAuthData(paths.agentDir);
      const providersMap = asRecord(file.root.providers) ?? {};
      // This is configuration, not a second model registry. Only the facade's
      // live Runtime snapshot may populate availableModels or diagnose a role.
      const providers = Object.keys(providersMap).map((id) => providerFromYaml(id, asRecord(providersMap[id]) ?? {}, [], disabled, authenticated));
      const roleDefs = [
        ...builtinRoles().map((role) => ({ ...role, builtin: true })),
        ...Object.entries({ ...Object.fromEntries(Object.keys(modelRoles).map(id => [id, { name: id, desc: hostText("自定义角色", "Custom role") }])), ...tags })
          .filter(([id]) => !builtinRoles().some((role) => role.id === id))
          .map(([id, tag]) => ({
            id,
            alias: `@${id}`,
            name: tag.name,
            desc: tag.desc ?? hostText("自定义角色", "Custom role"),
            builtin: false,
          })),
      ];
      const roles: ModelRoleRecord[] = roleDefs.map((role) => {
        const raw = modelRoles[role.id] ?? "";
        const parsed = raw ? parseThinking(raw) : { primary: "" };
        return {
          ...role,
          primary: parsed.primary,
          ...(parsed.thinking === undefined ? {} : { thinking: parsed.thinking }),
          scope: projectKeys.has(role.id) ? "project" : "global",
        };
      });
      const savedSources = await origins.reader();
      for (const provider of providers) {
        for (const model of provider.models) {
          if (model.source !== "custom") continue;
          Object.assign(model, { parameterSources: savedSources(provider.id, model.id, model.parameters ?? modelParameterValues(model)) });
        }
        for (const [id, override] of Object.entries(provider.modelOverrides ?? {})) {
          Object.assign(override, { parameterSources: savedSources(provider.id, id, modelParameterValues(override)) });
        }
      }
      const generatedConfigYml = [
        `modelRoleStorage: ${storage}`,
        `modelRoles:`,
        ...roles.filter((role) => role.primary).map((role) => `  ${role.id}: ${role.primary}${role.thinking ? `:${role.thinking}` : ""}`),
        modelProviderOrder.length > 0 ? `modelProviderOrder:\n${modelProviderOrder.map((id) => `  - ${id}`).join("\n")}` : "",
      ].filter((line) => line.length > 0).join("\n") + "\n";
      const globalWebSearch = await readWebSearch(paths.configPath, authenticated, authKinds, configRoot);
      const webSearch: WebSearchConfigReadModel = { ...globalWebSearch, routing: { ...globalWebSearch.routing!, primary: modelRoles.web ?? "", fallbacks: fallback.chains.web ?? null } };
      return {
        providers,
        presets: presetGroups(),
        catalog: await catalog.status(),
        roles,
        cycleOrder: cycleOrder.length > 0 ? cycleOrder : ["smol", "default", "slow"],
        availableModels: [],
        availability: { status: "unverified", source: "none", reason: hostText("尚未从当前 Runtime 验证模型可用性", "Model availability has not been verified by the current Runtime") },
        loginProviders: (() => {
          const fromPresets = presetGroups().flatMap((group) => group.items)
            .filter((item) => item.oauth)
            .map((item) => ({
              id: item.id,
              name: item.name,
              available: Boolean(openUrl),
              authenticated: authenticated.has(item.id),
              ...(item.id === "devin" ? { flows: [{ id: "devin-cli", name: "导入 Devin CLI / Import Devin CLI" }, { id: "devin-windsurf", name: "Windsurf 企业账号 / Enterprise" }] } : {}),
            }));
          const seen = new Set(fromPresets.map((item) => item.id));
          const fromYaml = providers
            .filter((item) => item.auth.type === "oauth" && !seen.has(item.id))
            .map((item) => ({
              id: item.id,
              name: item.name,
              available: Boolean(openUrl),
              authenticated: authenticated.has(item.id) || item.auth.hasSecret,
            }));
          return [...fromPresets, ...fromYaml];
        })(),
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
        webSearch,
      };
    },

    resolveAdaptation: (input) => catalog.resolve(input),
    refreshCatalog: () => catalog.refresh(),

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
      const sourcesSaved = await saveProviderOrigins(input, asRecord(providers[input.id])!);
      if (!sourcesSaved) return { ...writeOk(), contentHash, message: hostText("配置已保存，但来源记录未保存；重新打开时将显示为手工配置", "Configuration saved, but origin metadata was not saved; it will appear as manual on reopen") };
      return { ...writeOk(), contentHash };
    },

    async setProviderEnabled(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      await applyProviderEnabled(paths.configPath, input.id, input.enabled);
      return { ...writeOk(), message: input.enabled ? hostText(`已启用 ${input.id}`, `Enabled ${input.id}`) : hostText(`已禁用 ${input.id}`, `Disabled ${input.id}`) };
    },

    async writeModelsYml(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const file = await readModelsFile(paths.modelsPath);
      let root: Record<string, YamlValue>;
      try {
        root = parseModelsYml(input.text);
      } catch (error) {
        const reason = error instanceof Error ? error.message : hostText("YAML 无法解析", "Failed to parse YAML");
        throw { code: "INVALID_ARGUMENT", message: reason };
      }
      if (!("providers" in root) || root.providers === undefined) root.providers = {};
      if (!asRecord(root.providers)) {
        throw { code: "INVALID_ARGUMENT", message: hostText("models.yml 的 providers 必须是映射", "providers in models.yml must be a mapping") };
      }
      restoreRedactedApiKeys(root, file.root);
      if (input.overlay) {
        const providers = asRecord(root.providers) ?? {};
        providers[input.overlay.id] = toYamlProvider(input.overlay, asRecord(providers[input.overlay.id]));
        root.providers = providers;
      }
      const contentHash = await writeModelsFile(paths.modelsPath, root, input.expectedHash);
      const sourcesSaved = !input.overlay || await saveProviderOrigins(input.overlay, asRecord(asRecord(root.providers)?.[input.overlay.id])!);
      return { ...writeOk(), contentHash, message: sourcesSaved ? hostText("已写入 models.yml", "Saved models.yml") : hostText("配置已保存，但来源记录未保存；重新打开时将显示为手工配置", "Configuration saved, but origin metadata was not saved; it will appear as manual on reopen") };
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
      return { ...writeOk(), contentHash };
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
      return writeOk();
    },

    async startLogin(input): Promise<ConfigWriteResult> {
      if (!openUrl) {
        throw {
          code: "CAPABILITY_UNAVAILABLE",
          message: hostText(`应用内登录不可用。请在终端运行 omp login ${input.providerId}`, `In-app login is unavailable. Run omp login ${input.providerId} in a terminal.`),
        };
      }
      const exe = await locateOmp();
      if (!exe) throw { code: "UNAVAILABLE", message: "omp executable was not found" };
      const { spawn } = await import("node:child_process");
      return await new Promise<ConfigWriteResult>((resolve, reject) => {
        const child = spawn(exe, ["--mode", "rpc"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let buffer = "";
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        child.once("close", () => {
          if (killTimer !== undefined) {
            clearTimeout(killTimer);
            killTimer = undefined;
          }
        });
        const terminate = () => {
          try {
            child.kill();
          } catch {
            return;
          }
          if (killTimer === undefined) {
            killTimer = setTimeout(() => {
              killTimer = undefined;
              if (child.exitCode === null && child.signalCode === null) {
                try {
                  child.kill("SIGKILL");
                } catch {
                  // Best-effort escalation after SIGTERM grace.
                }
              }
            }, 500);
            killTimer.unref?.();
          }
        };
        const finish = (error?: unknown, result?: ConfigWriteResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          terminate();
          if (error) reject(toClientError(error, "CAPABILITY_UNAVAILABLE"));
          else resolve(result ?? writeOk());
        };
        const timer = setTimeout(() => finish({ code: "UNAVAILABLE", message: "login timed out; use omp login in a terminal" }), 120_000);
        timer.unref?.();
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
              child.stdin?.write(`${JSON.stringify({ id: "login-1", type: "login", providerId: input.loginId ?? input.providerId })}\n`);
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
                message: hostText(`该供应商需要交互式输入。请在终端运行 omp login ${input.providerId}`, `This provider requires interactive input. Run omp login ${input.providerId} in a terminal.`),
              });
              continue;
            }
            if (frame.type === "response" && frame.command === "login") {
              clearTimeout(timer);
              if (frame.success === true) finish(undefined, { ...writeOk(), message: hostText(`已登录 ${input.providerId}。新会话后生效。`, `Logged in to ${input.providerId}. Takes effect in a new session.`) });
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

      if (apiKey !== undefined) {
        const resolved = resolveRequestApiKey(apiKey);
        if ("command" in resolved) {
          return { ok: false, latencyMs: Date.now() - started, detail: hostText("该供应商使用外部命令取凭据，无法在此自动测试，请在终端验证。", "This provider uses an external command for credentials and cannot be tested automatically here; verify in a terminal.") };
        }
        if ("missingEnv" in resolved) {
          return { ok: false, latencyMs: Date.now() - started, detail: hostText(`未在环境中检测到 ${resolved.missingEnv}`, `${resolved.missingEnv} was not found in the environment`) };
        }
        apiKey = resolved.value;
      }

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
              const yamlAuth = stringOf(raw.auth);
              if (yamlAuth !== "none" && yamlAuth !== "oauth") {
                const resolved = resolveRequestApiKey(stringOf(raw.apiKey), input.providerId);
                if ("command" in resolved) {
                  return { ok: false, latencyMs: Date.now() - started, detail: hostText("该供应商使用外部命令取凭据，无法在此自动测试，请在终端验证。", "This provider uses an external command for credentials and cannot be tested automatically here; verify in a terminal.") };
                }
                if ("missingEnv" in resolved) {
                  return { ok: false, latencyMs: Date.now() - started, detail: hostText(`未在环境中检测到 ${resolved.missingEnv}`, `${resolved.missingEnv} was not found in the environment`) };
                }
                apiKey = resolved.value;
              }
            }
          } catch {
            // Fall through to whatever was provided in the request.
          }
        }
        const preset = presetGroups().flatMap((group) => group.items).find((item) => item.id === input.providerId);
        if (!endpointUrl) endpointUrl = preset?.endpoint;
        if (!api) api = preset?.api;
      }

      if (input.providerId === "antigravity-cli" || api === "antigravity-acp") {
        return { ok: false, latencyMs: Date.now() - started, detail: hostText("托管 ACP 服务不支持 HTTP 探测，请读取 Runtime 就绪状态。", "Managed ACP services do not support HTTP probes; read Runtime readiness instead.") };
      }
      if (!endpointUrl) {
        return { ok: false, latencyMs: Date.now() - started, detail: hostText("未配置 Base URL。", "Base URL is not configured.") };
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
          detail: hostText(`连接成功 · HTTP ${result.status}`, `Connected · HTTP ${result.status}`),
          httpStatus: result.status,
          retryCount: result.retries,
        };
      }

      // With credentials, verify them against the API's model-list endpoint
      // (per-wire URL and auth header, shared with probeProvider), falling back
      // to plain reachability when that endpoint is missing (404/405) or the API
      // has no model-list surface at all.
      const listRequest = modelListRequest(base, api ?? "openai-completions", apiKey);
      const authHeaders = listRequest.headers;
      const authProbe = listRequest.urls[0];
      if (authProbe !== undefined) {
        const authResult = await probeWithRetry(authProbe, authHeaders);
        if (authResult.error !== null) {
          return { ok: false, latencyMs: Date.now() - started, detail: networkErrorDetail(authResult.error), retryCount: authResult.retries };
        }
        if (authResult.status >= 200 && authResult.status < 300) {
          return {
            ok: true,
            latencyMs: Date.now() - started,
            detail: hostText(`连接成功 · HTTP ${authResult.status} · 凭据有效`, `Connected · HTTP ${authResult.status} · Valid credentials`),
            httpStatus: authResult.status,
            retryCount: authResult.retries,
          };
        }
        if (authResult.status === 401 || authResult.status === 403) {
          return {
            ok: false,
            latencyMs: Date.now() - started,
            detail: hostText(`连接失败：端点可达 · HTTP ${authResult.status} · 凭据无效`, `Connection failed: endpoint reachable · HTTP ${authResult.status} · Invalid credentials`),
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
          detail: hostText(`连接成功 · 端点可达（HTTP ${fallback.status}）· 模型列表接口不可用（HTTP ${authResult.status}）· 凭据未验证`, `Connected · endpoint reachable (HTTP ${fallback.status}) · model list unavailable (HTTP ${authResult.status}) · credentials unverified`),
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
        detail: hostText(`连接成功 · HTTP ${reach.status} · 凭据未验证（该 API 类型无模型列表接口）`, `Connected · HTTP ${reach.status} · credentials unverified (this API type has no model-list endpoint)`),
        httpStatus: reach.status,
        retryCount: reach.retries,
      };
    },

    async probeProvider(input: ModelProviderProbeInput): Promise<ModelDiscoveryResult> {
      const started = Date.now();
      const fail = (detail: string, httpStatus?: number): ModelDiscoveryResult => ({
        ok: false,
        found: 0,
        usable: 0,
        models: [],
        latencyMs: Date.now() - started,
        detail,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
      let endpointUrl = input.endpointUrl;
      let apiKey = input.apiKey;
      let api = input.api;
      let discoveryType = input.discoveryType;
      let transport = input.transport;
      let advertisedReasoning = input.advertisedReasoning !== false;
      let timeoutMs = input.timeoutMs ?? TEST_TIMEOUT_MS;
      if (apiKey) {
        const resolved = resolveRequestApiKey(apiKey);
        if ("command" in resolved) {
          return fail(hostText("该供应商使用外部命令取凭据，无法在此自动获取模型，请在终端验证。", "This provider uses an external command for credentials and cannot fetch models automatically here; verify in a terminal."));
        }
        if ("missingEnv" in resolved) return fail(hostText(`未在环境中检测到 ${resolved.missingEnv}`, `${resolved.missingEnv} was not found in the environment`));
        apiKey = resolved.value;
      }
      const paths = await resolvePaths();
      if (paths) {
        try {
          const file = await readModelsFile(paths.modelsPath);
          const raw = asRecord((asRecord(file.root.providers) ?? {})[input.providerId]) ?? {};
          if (!endpointUrl) endpointUrl = stringOf(raw.baseUrl);
          if (transport === undefined && raw.transport === "pi-native") transport = "pi-native";
          if (!api) api = stringOf(raw.api);
          if (!apiKey) {
            const yamlAuth = stringOf(raw.auth);
            if (yamlAuth !== "none" && yamlAuth !== "oauth") {
              const resolved = resolveRequestApiKey(stringOf(raw.apiKey), input.providerId);
              if ("command" in resolved) {
                return fail(hostText("该供应商使用外部命令取凭据，无法在此自动获取模型，请在终端验证。", "This provider uses an external command for credentials and cannot fetch models automatically here; verify in a terminal."));
              }
              if ("missingEnv" in resolved) return fail(hostText(`未在环境中检测到 ${resolved.missingEnv}`, `${resolved.missingEnv} was not found in the environment`));
              apiKey = resolved.value;
            }
          }
          const discovery = asRecord(raw.discovery);
          advertisedReasoning = input.advertisedReasoning ?? (discovery?.advertisedReasoning !== false);
          if (!discoveryType) discoveryType = stringOf(discovery?.type);
          if (input.timeoutMs === undefined) {
            const yamlTimeout = numberOf(discovery?.timeoutMs);
            if (yamlTimeout !== undefined) timeoutMs = yamlTimeout;
          }
        } catch {
          /* use request fields */
        }
      }
      const preset = presetGroups().flatMap((group) => group.items).find((item) => item.id === input.providerId);
      if (!endpointUrl) endpointUrl = preset?.endpoint;
      if (!api) api = preset?.api;
      if (!discoveryType) discoveryType = preset?.discovery;
      if (input.providerId === "antigravity-cli" || api === "antigravity-acp") {
        return fail(hostText("托管 ACP 服务不支持 HTTP 模型探测，请读取 Runtime 就绪状态。", "Managed ACP services do not support HTTP model discovery; read Runtime readiness instead."));
      }
      if (!endpointUrl) return fail(hostText("未配置 Base URL。", "Base URL is not configured."));

      // With a discovery type the runtime protocol dictates the endpoint
      // (Ollama tags, LiteLLM model info); without one the wire API does, which
      // is what the editor's model fetch uses for ordinary providers.
      const listRequest = transport === "pi-native"
        ? { urls: [`${endpointUrl.replace(/\/+$/, "")}/v1/pi/models`], headers: { Accept: "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) } }
        : modelListRequest(endpointUrl, api ?? "openai-completions", apiKey);
      const urls = discoveryType === "ollama"
        ? [ollamaTagsUrl(endpointUrl)]
        : discoveryType === "litellm"
          ? litellmInfoUrls(endpointUrl)
          : listRequest.urls;
      if (urls.length === 0) {
        return fail(hostText("该 API 类型没有模型列表接口，无法自动获取模型。", "This API type has no model-list endpoint and cannot fetch models automatically."));
      }
      // Draft custom headers never overwrite the auth headers above.
      const headers: Record<string, string> = { ...(input.headers ?? {}), ...listRequest.headers };
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
          const gatewayRows = probeRecord(payload)?.models;
          const scopedPayload = transport === "pi-native" && Array.isArray(gatewayRows) ? { models: gatewayRows.filter(row => probeRecord(row)?.provider === input.providerId) } : payload;
          let models = parseDiscoveryModels(scopedPayload, advertisedReasoning);
          if (discoveryType === "lm-studio") {
            const nativeBase = endpointUrl.replace(/\/$/, "").replace(/\/v1$/, "");
            const metadata = new Map<string, Record<string, unknown>>();
            for (const nativePath of ["/api/v0/models", "/api/v1/models"]) {
              const native = await doFetch(nativeBase + nativePath, { method: "GET", headers, signal: controller.signal }).then(response => response.ok ? response.json() : null).catch(() => null);
              const rows = probeRecord(native);
              const entries = rows?.models ?? rows?.data;
              if (!Array.isArray(entries)) continue;
              for (const raw of entries) {
                const row = probeRecord(raw);
                if (!row) continue;
                const instances = Array.isArray(row.loaded_instances) ? row.loaded_instances.map(probeRecord).filter((item): item is Record<string, unknown> => !!item) : [];
                const loadedWindow = instances.map(instance => probePositiveInt(probeRecord(instance.config)?.context_length)).find(value => value !== undefined);
                const info = { ...row, context_window: loadedWindow ?? (row.state === "loaded" ? probePositiveInt(row.loaded_context_length) : undefined) ?? row.max_context_length, input_modalities: row.has_vision_adapter === true || row.type === "vlm" ? ["text", "image"] : undefined };
                for (const id of [row.id, row.key, ...instances.map(instance => instance.id)]) if (typeof id === "string") metadata.set(id, info);
              }
            }
            models = models.map(model => {
              const row = metadata.get(model.id);
              if (!row) return model;
              const meta = probeModelMeta(row);
              const { thinkingConfig: _thinking, ...withoutThinking } = model;
              return meta.kind === "judge" ? { ...withoutThinking, ...meta, reasoning: false } : { ...model, ...meta };
            });
          }
          return {
            ok: true,
            found: models.length,
            usable: models.length,
            models,
            latencyMs: Date.now() - started,
            detail: hostText(`探测成功 · 发现 ${models.length} 个模型 · HTTP ${response.status}`, `Probe succeeded · found ${models.length} ${models.length === 1 ? "model" : "models"} · HTTP ${response.status}`),
            httpStatus: response.status,
          };
        } catch (error) {
          lastError = error;
        } finally {
          clearTimeout(timer);
        }
      }
      if (lastError) return fail(networkErrorDetail(lastError));
      if (lastStatus === 401 || lastStatus === 403) {
        return fail(hostText(`探测失败：端点可达 · HTTP ${lastStatus} · 凭据无效`, `Probe failed: endpoint reachable · HTTP ${lastStatus} · Invalid credentials`), lastStatus);
      }
      return fail(hostText(`探测失败${lastStatus ? ` · HTTP ${lastStatus}` : ""}`, `Probe failed${lastStatus ? ` · HTTP ${lastStatus}` : ""}`), lastStatus || undefined);
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
        return { ...writeOk(), message: hostText("已重新扫描 Discovery 缓存（新会话后生效）", "Rescanned Discovery cache (takes effect in a new session)") };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error) throw error;
        throw toClientError(error, "UNAVAILABLE");
      }
    },

    async logout(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const changes = await logoutAuth(paths.agentDir, input.providerId);
      return { ...writeOk(), message: changes > 0 ? hostText(`已登出 ${input.providerId}`, `Logged out of ${input.providerId}`) : hostText(`${input.providerId} 没有已保存凭据`, `No saved credentials for ${input.providerId}`) };
    },

    async writeRoles(input: ModelRolesWriteInput): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const target = await roleTargetPath(paths);
      const text = await readConfigText(target.path);
      await writeConfigText(target.path, replaceYamlRecordStrings(text, "modelRoles", input.roles));
      return { ...writeOk(), message: hostText("已写入 modelRoles", "Saved modelRoles") };
    },

    async createRole(input: ModelRoleCreateInput): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (builtinRoles().some((role) => role.id === input.id)) {
        throw { code: "INVALID_ARGUMENT", message: hostText(`${input.id} 是内置角色，不能重复创建`, `${input.id} is a built-in role and cannot be created again`) };
      }
      if (!/^[a-z][a-z0-9_-]*$/.test(input.id)) {
        throw { code: "INVALID_ARGUMENT", message: hostText("角色 id 只能使用小写字母、数字、连字符和下划线", "Role IDs may only contain lowercase letters, digits, hyphens, and underscores") };
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
      return { ...writeOk(), message: hostText(`已创建角色 ${input.id}`, `Created role ${input.id}`) };
    },

    async deleteRole(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (!/^[a-z][a-z0-9_-]*$/.test(input.roleId)) {
        throw { code: "INVALID_ARGUMENT", message: hostText("角色 id 只能使用小写字母、数字、连字符和下划线", "Role IDs may only contain lowercase letters, digits, hyphens, and underscores") };
      }
      if (builtinRoles().some((role) => role.id === input.roleId)) {
        throw { code: "INVALID_ARGUMENT", message: hostText("不能删除内置角色", "Built-in roles cannot be deleted") };
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
      return { ...writeOk(), message: hostText(`已删除角色 ${input.roleId}`, `Deleted role ${input.roleId}`) };
    },

    async setRoleStorage(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (input.storage === "project" && !cwdOf()) {
        throw { code: "UNAVAILABLE", message: hostText("未打开工作区，无法切换到 Project 作用域。", "No workspace is open; cannot switch to Project scope.") };
      }
      const text = await readConfigText(paths.configPath);
      await writeConfigText(paths.configPath, upsertYamlScalar(text, "modelRoleStorage", input.storage));
      return { ...writeOk(), message: input.storage === "project" ? hostText("角色写入项目 .omp/config.yml", "Roles now write to project .omp/config.yml") : hostText("已恢复全局角色配置", "Restored global role configuration") };
    },

    async setFallback(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      const target = await roleTargetPath(paths);
      const text = await readConfigText(target.path);
      const next = patchYamlRoot(text, (root) => {
        const retry = root.retry && typeof root.retry === "object" && !Array.isArray(root.retry)
          ? { ...(root.retry as Record<string, unknown>) }
          : {};
        retry.fallbackChains = { ...input.chains };
        if (input.revertPolicy) retry.fallbackRevertPolicy = input.revertPolicy;
        root.retry = retry;
      });
      await writeConfigText(target.path, next);
      return { ...writeOk(), message: hostText("已保存 Fallback 链", "Saved fallback chains") };
    },

    async setProviderOrder(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      await writeConfigStringList(paths.configPath, "modelProviderOrder", input.order);
      return { ...writeOk(), message: hostText("已保存 modelProviderOrder", "Saved modelProviderOrder") };
    },

    async setCycleOrder(input): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      await writeConfigStringList(paths.configPath, "cycleOrder", input.order);
      return writeOk();
    },

    async setWebSearch(input: ModelWebSearchSetInput): Promise<ConfigWriteResult> {
      const paths = await resolvePaths();
      if (!paths) throw { code: "UNAVAILABLE", message: `config directory is missing: ${defaultAgentDir()}` };
      if (input.routing) {
        if (typeof input.routing.primary !== "string" || input.routing.primary.length > 512 || (input.routing.fallbacks !== null && (!Array.isArray(input.routing.fallbacks) || input.routing.fallbacks.length > 128 || input.routing.fallbacks.some(item => typeof item !== "string" || !item.trim() || item.length > 512)))) throw { code: "INVALID_ARGUMENT", message: "Invalid web model routing" };
        const target = await roleTargetPath(paths);
        if (target.path !== paths.configPath) {
          if (Object.keys(input).some(key => key !== "routing")) throw { code: "INVALID_ARGUMENT", message: "Save project search routing separately from global transport settings" };
          const text = await readConfigText(target.path);
          await writeConfigText(target.path, patchYamlRoot(text, root => writeWebRouting(root, input.routing!)));
          return { ...writeOk(), message: hostText("已保存项目 Web 模型链", "Saved project Web model chain") };
        }
      }
      const known = new Set(WEB_SEARCH_PROVIDER_CATALOG.map((provider) => provider.id));
      const filterIds = (items: ReadonlyArray<string>): string[] => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const item of items) {
          if (!known.has(item) || seen.has(item)) continue;
          seen.add(item);
          out.push(item);
        }
        return out;
      };
      let next = await readConfigText(paths.configPath);
      // Global tool switch.
      if (input.enabled !== undefined) {
        next = upsertYamlRecordEntry(next, "web_search", "enabled", input.enabled ? "true" : "false");
      }
      if (input.routing) next = patchYamlRoot(next, root => writeWebRouting(root, input.routing!));
      else if (input.order !== undefined || input.exclude !== undefined || input.geminiModel !== undefined) {
        next = patchYamlRoot(next, root => {
          const providers = typeof root.providers === "object" && root.providers && !Array.isArray(root.providers) ? { ...root.providers as Record<string, unknown> } : {};
          if (input.order !== undefined) providers.webSearchOrder = filterIds(input.order);
          if (input.exclude !== undefined) providers.webSearchExclude = filterIds(input.exclude);
          if (input.geminiModel !== undefined) providers.webSearchGeminiModel = input.geminiModel;
          const migration = { ...root, providers, modelRoles: {}, retry: {} };
          writeWebRouting(root, readWebRouting(migration));
        });
      }
      // Per-provider transport timeout (clamped like the runtime: 1..300s).
      if (input.timeoutSeconds !== undefined) {
        const clamped = Number.isFinite(input.timeoutSeconds)
          ? Math.min(300, Math.max(1, Math.round(input.timeoutSeconds)))
          : 60;
        next = upsertYamlRecordEntry(next, "providers", "webSearchTimeoutSeconds", String(clamped));
      }
      // SearXNG advanced: plain-text fields are clearable with an empty string;
      // token and basic password only ever set (blank keeps the existing
      // secret); safesearch null deletes the key back to the instance default.
      if (input.searxng !== undefined) {
        if (input.searxng.endpoint !== undefined) {
          next = input.searxng.endpoint.length > 0
            ? upsertYamlRecordEntry(next, "searxng", "endpoint", quoteInline(input.searxng.endpoint.trim()))
            : deleteYamlRecordEntry(next, "searxng", "endpoint");
        }
        if (input.searxng.token !== undefined && input.searxng.token.length > 0) {
          next = upsertYamlRecordEntry(next, "searxng", "token", quoteInline(input.searxng.token.trim()));
        }
        if (input.searxng.basicUsername !== undefined) {
          next = input.searxng.basicUsername.length > 0
            ? upsertYamlRecordEntry(next, "searxng", "basicUsername", quoteInline(input.searxng.basicUsername.trim()))
            : deleteYamlRecordEntry(next, "searxng", "basicUsername");
        }
        if (input.searxng.basicPassword !== undefined && input.searxng.basicPassword.length > 0) {
          next = upsertYamlRecordEntry(next, "searxng", "basicPassword", quoteInline(input.searxng.basicPassword.trim()));
        }
        for (const key of ["categories", "engines", "language"] as const) {
          const value = input.searxng[key];
          if (value === undefined) continue;
          next = value.length > 0
            ? upsertYamlRecordEntry(next, "searxng", key, quoteInline(value.trim()))
            : deleteYamlRecordEntry(next, "searxng", key);
        }
        if (input.searxng.safesearch !== undefined) {
          next = input.searxng.safesearch === null
            ? deleteYamlRecordEntry(next, "searxng", "safesearch")
            : upsertYamlRecordEntry(next, "searxng", "safesearch", String(Math.min(2, Math.max(0, Math.round(input.searxng.safesearch)))));
        }
      }
      // Exa advanced.
      if (input.exa !== undefined) {
        if (input.exa.enabled !== undefined) {
          next = upsertYamlRecordEntry(next, "exa", "enabled", input.exa.enabled ? "true" : "false");
        }
        if (input.exa.searchDelayMs !== undefined && Number.isFinite(input.exa.searchDelayMs)) {
          const clamped = Math.min(60000, Math.max(0, Math.round(input.exa.searchDelayMs)));
          next = upsertYamlRecordEntry(next, "exa", "searchDelayMs", String(clamped));
        }
      }
      await writeConfigText(paths.configPath, next);
      return { ...writeOk(), message: hostText("已保存网络搜索配置", "Saved web search configuration") };
    },

    async setWebSearchApiKey(_input: ModelWebSearchCredentialSetInput): Promise<ConfigWriteResult> {
      throw { code: "CAPABILITY_UNAVAILABLE", message: "Search credentials must be saved through the connected Runtime." };
    },

    async removeWebSearchApiKey(_input: ModelWebSearchCredentialRemoveInput): Promise<ConfigWriteResult> {
      throw { code: "CAPABILITY_UNAVAILABLE", message: "Select a stored search credential in the connected Runtime to remove it." };
    },
  };
}
