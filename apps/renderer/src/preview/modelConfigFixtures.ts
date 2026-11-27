/**
 * Preview fixtures for the model-config page, ported from
 * ui_reference/ver1/assets/js/models-data.js. Display only.
 */

import { BUILTIN_MODEL_ROLES } from "@omp-studio/client-contract";
import { isZh } from "../i18n";

import type {
  ModelApiKind,
  ModelAuthType,
  ModelCatalogEntry,
  ModelConfigReadModel,
  ModelDiscoveryModel,
  ModelPresetGroup,
  ModelProviderRecord,
  ModelRoleRecord,
} from "@omp-studio/client-contract";

function m(
  id: string,
  name: string,
  ctx: number,
  maxOut: number,
  opts: { img?: boolean; reason?: boolean; tools?: boolean; cIn?: number; cOut?: number; status?: ModelCatalogEntry["status"]; src?: ModelCatalogEntry["source"] } = {},
): ModelCatalogEntry {
  return {
    id,
    name,
    selector: id,
    contextWindow: ctx,
    maxTokens: maxOut,
    image: Boolean(opts.img),
    reasoning: Boolean(opts.reason),
    tools: opts.tools !== false,
    ...(opts.cIn === undefined ? {} : { cost: { input: opts.cIn, ...(opts.cOut === undefined ? {} : { output: opts.cOut }) } }),
    status: opts.status ?? "available",
    source: opts.src ?? "catalog",
  };
}

function withSelector(providerId: string, models: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return models.map((model) => ({
    ...model,
    selector: `${providerId}/${model.id}`,
    ...(providerId === "deepseek" ? {
      pricing: { timeBased: { offPeakMultiplier: 0.5, peakWindows: [{ weekdays: [1, 2, 3, 4, 5], startMinute: 480, endMinute: 1080 }] } },
    } : {}),
  }));
}

export function getModelPresets(zh = isZh()): ReadonlyArray<ModelPresetGroup> {
  return [
    {
      group: zh ? "官方 / 主流" : "Official / Major",
      items: [
        { id: "muse-code", name: "Muse Code", desc: zh ? "Muse Spark 订阅与账号模型发现" : "Muse Spark subscription and account model discovery", api: "openai-responses", auth: ["oauth"], oauth: true },
        { id: "anthropic", name: "Anthropic", desc: zh ? "Claude 系列模型官方 API" : "Official Claude API", api: "anthropic-messages", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.anthropic.com/v1" },
        { id: "openai", name: "OpenAI", desc: zh ? "GPT 系列模型官方 API" : "Official GPT API", api: "openai-responses", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.openai.com/v1" },
        { id: "openai-codex", name: "OpenAI Codex", desc: zh ? "Codex 订阅额度（ChatGPT 账号）" : "Codex subscription quota (ChatGPT account)", api: "openai-codex-responses", auth: ["oauth"], oauth: true, endpoint: "https://api.openai.com/v1" },
        { id: "google-gemini", name: "Google Gemini", desc: zh ? "Gemini 系列模型官方 API" : "Official Gemini API", api: "google-generative-ai", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://generativelanguage.googleapis.com/v1beta" },
        { id: "gemini-cli", name: "Google Gemini CLI", desc: zh ? "Gemini Code Assist 订阅" : "Gemini Code Assist subscription", api: "google-gemini-cli", auth: ["oauth"], oauth: true },
        { id: "xai", name: "xAI", desc: zh ? "Grok 系列模型" : "Grok models", api: "openai-responses", auth: ["api-key"], endpoint: "https://api.x.ai/v1" },
        { id: "groq", name: "Groq", desc: zh ? "高速推理（Llama / Mixtral）" : "High-speed inference (Llama / Mixtral)", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.groq.com/openai/v1" },
        { id: "deepseek", name: "DeepSeek", desc: zh ? "DeepSeek V / R 系列" : "DeepSeek V / R series", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.deepseek.com/v1" },
        { id: "moonshot", name: "Moonshot / Kimi", desc: zh ? "Kimi K 系列模型" : "Kimi K series models", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.moonshot.cn/v1" },
      ],
    },
    {
      group: zh ? "Gateway / 聚合" : "Gateway / Aggregators",
      items: [
        { id: "commandcode", name: "Command Code", desc: zh ? "原生 OpenAI / Anthropic 路由" : "Native OpenAI / Anthropic routing", api: "openai-completions", auth: ["api-key", "env"], endpoint: "https://api.commandcode.ai/provider/v1" },
        { id: "openrouter", name: "OpenRouter", desc: zh ? "一个 Key 访问多家模型" : "Access multiple providers with one key", api: "openrouter", auth: ["api-key"], popular: true, endpoint: "https://openrouter.ai/api/v1" },
        { id: "github-copilot", name: "GitHub Copilot", desc: zh ? "Copilot 订阅额度" : "Copilot subscription quota", api: "openai-responses", auth: ["oauth"], oauth: true },
        { id: "litellm", name: "LiteLLM", desc: zh ? "自托管统一模型代理" : "Self-hosted unified model proxy", api: "openai-completions", auth: ["api-key", "env"], endpoint: "http://localhost:4000/v1", discovery: "litellm" },
      ],
    },
    {
      group: zh ? "本地" : "Local",
      items: [
        { id: "ollama", name: "Ollama", desc: zh ? "本地模型服务，自动发现已拉取模型" : "Local model server with automatic pulled model discovery", api: "openai-completions", auth: ["none"], local: true, popular: true, endpoint: "http://localhost:11434/v1", discovery: "ollama" },
        { id: "lm-studio", name: "LM Studio", desc: zh ? "本地 OpenAI 兼容服务" : "Local OpenAI-compatible server", api: "openai-completions", auth: ["none"], local: true, endpoint: "http://localhost:1234/v1", discovery: "lm-studio" },
        { id: "llama.cpp", name: "llama.cpp", desc: zh ? "llama-server OpenAI 兼容接口" : "llama-server OpenAI-compatible endpoint", api: "openai-completions", auth: ["none"], local: true, endpoint: "http://localhost:8080/v1", discovery: "llama.cpp" },
      ],
    },
    {
      group: zh ? "更多 Provider" : "More Providers",
      items: [
        { id: "qwen", name: "Qwen", desc: zh ? "通义千问官方 API" : "Official Qwen API", api: "openai-completions", auth: ["api-key"], endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
        { id: "zhipu", name: zh ? "Zhipu / 智谱" : "Zhipu AI", desc: zh ? "GLM 系列模型" : "GLM series models", api: "openai-completions", auth: ["api-key"], endpoint: "https://open.bigmodel.cn/api/paas/v4" },
        { id: "fireworks", name: "Fireworks", desc: zh ? "Fireworks AI 托管推理" : "Fireworks AI hosted inference", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.fireworks.ai/inference/v1" },
        { id: "siliconflow", name: "SiliconFlow", desc: zh ? "硅基流动模型云" : "SiliconFlow model cloud", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.siliconflow.cn/v1" },
      ],
    },
  ];
}

export const MODEL_PRESETS: ReadonlyArray<ModelPresetGroup> = getModelPresets();

export const MODEL_API_TYPES: ReadonlyArray<{ id: ModelApiKind | string; label: string }> = [
  { id: "openrouter", label: "OpenRouter" },
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "openai-codex-responses", label: "OpenAI Codex Responses" },
  { id: "azure-openai-responses", label: "Azure OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "bedrock-converse-stream", label: "Bedrock Converse" },
  { id: "google-generative-ai", label: "Google Generative AI" },
  { id: "google-gemini-cli", label: "Google Gemini CLI" },
  { id: "google-vertex", label: "Google Vertex" },
];

export function getModelAuthTypes(zh = isZh()): ReadonlyArray<{ id: ModelAuthType; label: string; hint: string }> {
  return [
    { id: "oauth", label: "OMP Login / OAuth", hint: zh ? "用 omp login 写入本机凭据" : "Write local credentials with omp login" },
    { id: "api-key", label: "API Key", hint: zh ? "密钥写入 models.yml" : "Write secret to models.yml" },
    { id: "env", label: "Environment Variable", hint: zh ? "从环境变量读取，不写密钥" : "Read from environment variable without saving secrets" },
    { id: "command", label: "External Command", hint: zh ? "用命令取密，Secret 不落盘" : "Fetch secret via command without writing to disk" },
    { id: "none", label: zh ? "无需认证" : "No authentication", hint: zh ? "适用于 Ollama 等本地服务" : "For local services such as Ollama" },
  ];
}

export const MODEL_AUTH_TYPES: ReadonlyArray<{ id: ModelAuthType; label: string; hint: string }> = getModelAuthTypes();

export const MODEL_THINKING = [
  { id: "off", label: "Off" },
  { id: "minimal", label: "Minimal" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
] as const;

function provider(
  partial: Omit<ModelProviderRecord, "models"> & { models: ModelCatalogEntry[] },
): ModelProviderRecord {
  return { ...partial, models: withSelector(partial.id, partial.models) };
}

export function createPreviewModelConfig(zh = isZh()): ModelConfigReadModel {
  const providers: ModelProviderRecord[] = [
    provider({
      id: "anthropic", name: "Anthropic", source: "builtin", status: "available",
      statusDetail: zh ? "已登录 · 个人账号" : "Signed in · Personal", api: "anthropic-messages",
      endpointUrl: "https://api.anthropic.com/v1", local: false, enabled: true,
      website: "https://www.anthropic.com", auth: { type: "oauth", hasSecret: true, account: "mira@studio.dev" },
      models: [
        m("claude-opus-4.8", "Claude Opus 4.8", 200000, 64000, { img: true, reason: true, cIn: 15, cOut: 75 }),
        m("claude-sonnet-4.5", "Claude Sonnet 4.5", 200000, 64000, { img: true, reason: true, cIn: 3, cOut: 15 }),
        m("claude-haiku-4.5", "Claude Haiku 4.5", 200000, 64000, { img: true, cIn: 1, cOut: 5 }),
      ],
    }),
    provider({
      id: "openai", name: "OpenAI", source: "builtin", status: "available",
      statusDetail: zh ? "API Key 已保存" : "API Key saved", api: "openai-responses",
      endpointUrl: "https://api.openai.com/v1", local: false, enabled: true,
      website: "https://platform.openai.com", auth: { type: "api-key", hasSecret: true, apiKey: "sk-demo-openai-9f2c7e1a" },
      models: [
        m("gpt-5.2", "GPT-5.2", 400000, 128000, { img: true, reason: true, cIn: 1.75, cOut: 14 }),
        m("gpt-5.2-codex", "GPT-5.2 Codex", 400000, 128000, { img: true, reason: true, cIn: 1.75, cOut: 14 }),
        m("gpt-5-mini", "GPT-5 mini", 400000, 128000, { img: true, reason: true, cIn: 0.25, cOut: 2 }),
      ],
    }),
    provider({
      id: "openrouter", name: "OpenRouter", source: "builtin", status: "not-authenticated",
      statusDetail: zh ? "尚未配置凭据" : "Credentials not configured", api: "openrouter",
      endpointUrl: "https://openrouter.ai/api/v1", local: false, enabled: true,
      auth: { type: "api-key", hasSecret: false },
      models: [m("auto", "OpenRouter Auto", 200000, 32000, { img: true, reason: true, status: "unavailable" })],
    }),
    provider({
      id: "lm-studio", name: "LM Studio", source: "runtime", status: "offline",
      statusDetail: zh ? "本地服务未运行" : "Local service offline", api: "openai-completions",
      endpointUrl: "http://localhost:1234/v1", local: true, enabled: true,
      auth: { type: "none", hasSecret: false },
      discovery: { type: "lm-studio", timeoutMs: 5000 },
      models: [],
    }),
    provider({
      id: "zhipu", name: zh ? "Zhipu / 智谱" : "Zhipu AI", source: "builtin", status: "disabled",
      statusDetail: zh ? "已禁用" : "Disabled", api: "openai-completions",
      endpointUrl: "https://open.bigmodel.cn/api/paas/v4", local: false, enabled: false,
      auth: { type: "api-key", hasSecret: true, apiKey: "sk-demo-zhipu-3b8d5f2c" },
      models: [m("glm-4.6", "GLM 4.6", 200000, 8192, { reason: true, status: "disabled" })],
    }),
  ];

  providers.push(provider({ id: "liquid", name: "Liquid AI", source: "builtin", status: "available", statusDetail: "Judge credentials configured", api: "liquid-systemone", local: false, enabled: true, auth: { type: "api-key", hasSecret: true }, models: [
    { id: "d1.1", selector: "liquid/d1.1", name: "d1.1", kind: "judge", api: "liquid-systemone", contextWindow: 65536, image: true, reasoning: false, tools: false, cost: { input: .02, output: 0 }, status: "available", source: "catalog" },
    { id: "d1-ultra", selector: "liquid/d1-ultra", name: "d1-ultra", kind: "judge", api: "liquid-systemone", contextWindow: 32768, image: true, reasoning: false, tools: false, cost: { input: .042, output: 0 }, status: "available", source: "catalog" },
  ] }));
  const roles: ModelRoleRecord[] = [
    { id: "default", alias: "@default", name: "Default", desc: zh ? "默认主模型" : "Default primary model", builtin: true, primary: "anthropic/claude-sonnet-4.5", scope: "global" },
    { id: "smol", alias: "@smol", name: "Fast", desc: zh ? "快速、低成本任务" : "Fast, low-cost tasks", builtin: true, primary: "openai/gpt-5-mini", thinking: "low", scope: "global" },
    { id: "slow", alias: "@slow", name: "Thinking", desc: zh ? "复杂推理任务" : "Complex reasoning tasks", builtin: true, primary: "openai/gpt-5.2", thinking: "high", scope: "global" },
    { id: "vision", alias: "@vision", name: "Vision", desc: zh ? "视觉与图片任务" : "Vision and image tasks", builtin: true, primary: "anthropic/claude-sonnet-4.5", scope: "global" },
    { id: "plan", alias: "@plan", name: "Architect", desc: zh ? "规划和架构任务" : "Planning and architecture tasks", builtin: true, primary: "anthropic/claude-opus-4.8", thinking: "high", scope: "global" },
    { id: "designer", alias: "@designer", name: "Designer", desc: zh ? "设计相关任务" : "Design-related tasks", builtin: true, primary: "openrouter/auto", thinking: "medium", scope: "global", issue: { kind: "model-unavailable", detail: zh ? "模型不可用" : "Model unavailable" } },
    { id: "commit", alias: "@commit", name: "Commit", desc: zh ? "Commit 相关任务" : "Commit-related tasks", builtin: true, primary: "anthropic/claude-haiku-4.5", scope: "global" },
    { id: "tiny", alias: "@tiny", name: "Tiny", desc: zh ? "标题、记忆等极轻量后台任务" : "Lightweight background tasks such as titles and memory", builtin: true, primary: "lm-studio/qwen", thinking: "off", scope: "global", issue: { kind: "provider-down", detail: zh ? "本地服务未运行" : "Local service offline" } },
    { id: "task", alias: "@task", name: "Subtask", desc: zh ? "通用子任务" : "General subtasks", builtin: true, primary: "openai/gpt-5-mini", scope: "global" },
    { id: "advisor", alias: "@advisor", name: "Advisor", desc: zh ? "第二模型审查" : "Second-opinion review", builtin: true, primary: "openai/gpt-5.2", thinking: "medium", scope: "global" },
    { id: "review", alias: "@review", name: "Review", desc: zh ? "自定义审查角色" : "Custom review role", builtin: false, primary: "anthropic/claude-sonnet-4.5", scope: "project" },
  ];

  for (const role of BUILTIN_MODEL_ROLES) {
    if (!roles.some(existing => existing.id === role.id)) {
      roles.push({ ...role, alias: `@${role.id}`, builtin: true, primary: role.id === "judge" ? "liquid/d1.1" : "", scope: "global" });
    }
  }

  const demoOpenAI = providers.find(item => item.id === "openai" || item.id === "openai-codex");
  if (demoOpenAI) {
    (demoOpenAI.models as ModelCatalogEntry[]).push(...withSelector(demoOpenAI.id, [
      { ...m("gpt-image-1", "GPT Image", 128000, 8192, { img: true }), kind: "image", api: "openai-images" },
      { ...m("gpt-4o-mini-tts", "Mini TTS", 4096, 4096), kind: "tts" },
      { ...m("whisper-1", "Whisper", 4096, 4096), kind: "stt" },
    ]));
  }
  const availableModels: import("@omp-studio/client-contract").AvailableModelRecord[] = providers.flatMap((item) =>
    item.models.filter((model) => model.status === "available").map((model) => {
      const thinking = !model.reasoning
        ? undefined
        : model.id.startsWith("gpt-5.2")
          ? ["low", "medium", "high", "xhigh"]
          : model.id.includes("opus") || model.id.includes("sonnet")
            ? ["low", "medium", "high", "max"]
            : ["minimal", "low", "medium", "high"];
      return {
        ...(item.id === "anthropic" ? { compatibility: { supportsMessageThreads: true } } : {}),
        provider: item.id,
        id: model.id,
        selector: model.selector,
        ...(model.id.startsWith("gpt-5.2") ? { thinkingConfig: {mode:"effort" as const, efforts:["low","medium","high","xhigh"] as const, unverified:false} } :
          item.local ? { thinkingConfig: {mode:"effort" as const, efforts:[], unverified:true} } : {}),
        name: model.name,
        reasoning: model.reasoning,
        ...(model.kind === undefined ? {} : { kind: model.kind }),
        ...(model.api === undefined ? {} : { api: model.api }),
        ...(item.id === "anthropic" ? { webSearch: "anthropic" } : model.webSearch === undefined ? {} : { webSearch: model.webSearch }),
        image: model.image,
        tools: model.tools,
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
        ...(model.cost ? { cost: model.cost } : {}),
        ...(thinking ? { thinking } : {}),
      };
    }),
  );

  availableModels.push(...["parallel", "perplexity", "exa", "keenable", "deepseek", "ollama", "zai", "tinyfish", "sofya", "hackernews", "jina", "kagi", "tavily", "firecrawl", "brave", "kimi", "synthetic", "searxng", "startpage", "duckduckgo", "ecosia", "google", "mojeek", "public"].map(id => ({ provider: "web", id, selector: "web/" + id, name: id, reasoning: false, kind: "search" as const })),
    { provider: "local", id: "title-model", selector: "local/title-model", name: "Local title model", reasoning: false, kind: "tiny" },
    { provider: "local", id: "rule-judge", selector: "local/rule-judge", name: "Local judge", reasoning: false, kind: "judge" });

  availableModels.push(
    { provider: "google", id: "gemini-2.5-flash", selector: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", reasoning: true, webSearch: "gemini" },
    { provider: "google", id: "gemini-2.5-pro", selector: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, webSearch: "gemini" },
  );
  return {
    providers,
    catalog: { version: "2026.10", upstreamCommit: "preview", source: "builtin" },
    presets: [...getModelPresets(zh), { group: zh ? "登录与云服务" : "Login & Cloud", items: [
      { id: "mistral", name: "Mistral", desc: zh ? "Vibe 浏览器登录或 API Key" : "Vibe browser login or API key", api: "openai-completions", auth: ["oauth", "api-key"], oauth: true, endpoint: "https://api.mistral.ai/v1" },
      { id: "devin", name: "Devin", desc: zh ? "Devin CLI / Windsurf 企业账号" : "Devin CLI / Windsurf Enterprise", api: "devin", auth: ["oauth", "api-key"], oauth: true },
      { id: "modular", name: "Modular Cloud", desc: zh ? "云端模型" : "Cloud models", api: "openai-completions", auth: ["api-key", "env"], endpoint: "https://api.modular.com/v1" },
    ] }],
    roles,
    cycleOrder: ["smol", "default", "slow"],
    availableModels,
    loginProviders: [
      { id: "mistral", name: "Mistral", available: true, authenticated: false },
      { id: "devin", name: "Devin", available: true, authenticated: false, flows: [{ id: "devin-cli", name: zh ? "导入 Devin CLI / Import Devin CLI" : "Import Devin CLI" }, { id: "devin-windsurf", name: zh ? "Windsurf 企业账号 / Enterprise" : "Windsurf Enterprise" }] },
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "openai", name: "OpenAI", available: true, authenticated: false },
      { id: "google-gemini", name: "Google Gemini", available: true, authenticated: true },
    ],
    generatedModelsYml: "providers:\n  anthropic:\n    api: anthropic-messages\n",
    generatedConfigYml: "modelRoles:\n  default: anthropic/claude-sonnet-4.5\n",
    runtimeEffectHint: zh ? "改动只作用于当前页面，尚未写入本机 OMP 配置。" : "Changes apply to this view only and are not written to local OMP config.",
    loginAvailable: true,
    ompAvailable: true,
    modelRoleStorage: "project",
    projectScopeAvailable: true,
    modelProviderOrder: ["anthropic", "openai", "openrouter"],
    fallbackChains: {
      "anthropic/claude-sonnet-4.5": ["openai/gpt-5.2", "openai/gpt-5-mini"],
    },
    fallbackRevertPolicy: "cooldown-expiry",
    webSearch: {
      routing: { primary: "web/perplexity", fallbacks: ["web/exa", "google/gemini-2.5-flash"], defaultCandidates: ["web/parallel", "web/perplexity", "google/gemini-2.5-flash"], migratedLegacy: false },
      enabled: true,
      order: ["perplexity", "exa", "gemini"],
      exclude: ["mojeek"],
      timeoutSeconds: 60,
      geminiModel: "gemini-2.5-flash",
      providers: [
        { id: "parallel", name: "Parallel", description: "Keyless search with optional API key", credentialFree: true, hasCredential: true, apiKeyId: "parallel" },
        { id: "perplexity", name: "Perplexity", description: "Uses auth when configured; explicit selection falls back to anonymous search", credentialFree: false, hasCredential: true, envKeys: ["PERPLEXITY_API_KEY", "PERPLEXITY_COOKIES"], loginId: "perplexity", apiKeyId: "perplexity", credentialKind: "api-key" },
        { id: "gemini", name: "Gemini", description: "Google Search grounding via Gemini (uses google-gemini-cli or google-antigravity OAuth)", credentialFree: false, hasCredential: true, envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], apiKeyId: "google" },
        { id: "anthropic", name: "Anthropic", description: "Claude's native web_search tool (uses Anthropic OAuth or ANTHROPIC_API_KEY)", credentialFree: false, hasCredential: true, apiKeyId: "anthropic" },
        { id: "codex", name: "OpenAI", description: "OpenAI's native web_search (uses ChatGPT OAuth via /login openai-codex)", credentialFree: false, hasCredential: true, envKeys: [], loginId: "openai-codex" },
        { id: "xai", name: "xAI", description: "Grok web search via xAI Responses API (uses SuperGrok/X Premium+ OAuth via /login xai-oauth, or XAI_API_KEY)", credentialFree: false, hasCredential: false, apiKeyId: "xai" },
        { id: "zai", name: "Z.AI", description: "Calls Z.AI webSearchPrime MCP", credentialFree: false, hasCredential: false, apiKeyId: "zai" },
        { id: "exa", name: "Exa", description: "Exa API with a key, public MCP without one", credentialFree: true, hasCredential: false, envKeys: ["EXA_API_KEY"], loginId: "exa", apiKeyId: "exa" },
        { id: "keenable", name: "Keenable", description: "API key or explicit keyless search", credentialFree: false, hasCredential: false, envKeys: ["KEENABLE_API_KEY"], apiKeyId: "keenable" },
        { id: "tinyfish", name: "TinyFish", description: "Requires TINYFISH_API_KEY", credentialFree: false, hasCredential: false, apiKeyId: "tinyfish" },
        { id: "sofya", name: "Sofya", description: "Native Sofya search with the stored Sofya key", credentialFree: false, hasCredential: false, envKeys: ["SOFYA_API_KEY"], apiKeyId: "sofya", credentialProviders: ["sofya"] },
        { id: "jina", name: "Jina", description: "Requires JINA_API_KEY", credentialFree: false, hasCredential: false, apiKeyId: "jina" },
        { id: "kagi", name: "Kagi", description: "Requires KAGI_API_KEY and Kagi Search API beta access", credentialFree: false, hasCredential: false, apiKeyId: "kagi" },
        { id: "tavily", name: "Tavily", description: "Requires TAVILY_API_KEY", credentialFree: false, hasCredential: false, envKeys: ["TAVILY_API_KEY"], loginId: "tavily", apiKeyId: "tavily" },
        { id: "firecrawl", name: "Firecrawl", description: "Uses Firecrawl API when FIRECRAWL_API_KEY is set; falls back to keyless mode", credentialFree: true, hasCredential: false, apiKeyId: "firecrawl" },
        { id: "brave", name: "Brave", description: "Requires BRAVE_API_KEY", credentialFree: false, hasCredential: false, envKeys: ["BRAVE_API_KEY"], apiKeyId: "brave" },
        { id: "deepseek", name: "DeepSeek", description: "DeepSeek Search API using the existing DeepSeek key", credentialFree: false, hasCredential: false, envKeys: ["DEEPSEEK_API_KEY"], apiKeyId: "deepseek" },
        { id: "kimi", name: "Kimi", description: "Kimi Code search (requires a Kimi Code Console key via KIMI_SEARCH_API_KEY/MOONSHOT_SEARCH_API_KEY or /login kimi-code; not MOONSHOT_API_KEY)", credentialFree: false, hasCredential: false, envKeys: ["KIMI_SEARCH_API_KEY", "MOONSHOT_SEARCH_API_KEY"], loginId: "kimi-code", apiKeyId: "kimi-code" },
        { id: "synthetic", name: "Synthetic", description: "Requires SYNTHETIC_API_KEY", credentialFree: false, hasCredential: false, apiKeyId: "synthetic" },
        { id: "ollama", name: "Ollama Cloud", description: "Hosted web search", credentialFree: false, hasCredential: false, envKeys: ["OLLAMA_CLOUD_API_KEY"], apiKeyId: "ollama-cloud" },
        { id: "searxng", name: "SearXNG", description: "Requires SEARXNG_ENDPOINT or searxng.endpoint", credentialFree: true, hasCredential: true },
        { id: "startpage", name: "Startpage", description: "Credential-free scrape of Startpage (Google-backed) results; may be bot-challenged", credentialFree: true, hasCredential: true },
        { id: "duckduckgo", name: "DuckDuckGo", description: "Credential-free best-effort fallback; may be bot-challenged on datacenter/shared-egress IPs", credentialFree: true, hasCredential: true },
        { id: "ecosia", name: "Ecosia", description: "Credential-free browser-backed scrape of Ecosia (Google-backed) results", credentialFree: true, hasCredential: true },
        { id: "google", name: "Google", description: "Credential-free browser-backed fallback; slower and may be bot-challenged", credentialFree: true, hasCredential: true },
        { id: "mojeek", name: "Mojeek", description: "Credential-free browser-backed scrape of Mojeek's independent index", credentialFree: true, hasCredential: true },
        { id: "public", name: "Public Web", description: "Queries every credential-free engine in parallel and consolidates deduplicated results", credentialFree: true, hasCredential: true },
        { id: "hackernews", name: "Hacker News", description: "Keyless news.ycombinator.com route only; not a general-web fallback", credentialFree: true, hasCredential: false, siteRoute: "news.ycombinator.com", credentialProviders: [] },
      ],
      advanced: {
        searxng: { endpoint: "https://search.example.com", tokenSet: false, basicUsername: "", passwordSet: false, categories: "general,it", engines: "", language: "zh-CN" },
        exa: { enabled: true, searchDelayMs: 1000 },
      },
    },
  };
}

/**
 * Demo payload for the editor's "auto-fetch models" button: what an
 * OpenAI-compatible `/v1/models` would plausibly return for a gateway. Display
 * only — preview mode never calls the Host for this.
 */
export function createPreviewFetchedModels(): ModelDiscoveryModel[] {
  return [
    { id: "glm-5", name: "GLM-5", contextWindow: 200_000, maxTokens: 64_000, reasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_000_000, reasoning: true },
    { id: "qwen3-max", name: "Qwen3 Max", contextWindow: 262_144, image: true },
    { id: "gpt-5-mini", name: "GPT-5 mini" },
  ];
}

/** Credential metadata only; preview never stores entered key bytes. */
export function previewSearchCredentials(providers: readonly import("@omp-studio/client-contract").WebSearchProviderRecord[]): import("@omp-studio/studio-protocol").SearchCredentialStatus[] {
  const rows = new Map<string, import("@omp-studio/studio-protocol").SearchCredentialStatus>();
  for (const provider of providers) {
    const ids = provider.credentialProviders ?? [...new Set([provider.apiKeyId, provider.loginId].filter((id): id is string => Boolean(id)))];
    for (const id of ids) {
      const configured = provider.hasCredential && !provider.credentialFree;
      rows.set(id, { provider: id, configured, source: configured ? "api_key" : null,
        apiKeyLogin: ["exa", "ollama-cloud", "parallel", "tavily", "kagi", "zai", "synthetic"].includes(id),
        ...(id === "exa" ? { keyUrl: "https://dashboard.exa.ai/api-keys" } : id === "ollama-cloud" ? { keyUrl: "https://ollama.com/settings/keys" } : {}),
        credentials: configured ? [{ id: rows.size + 1, label: "API key", type: "api_key" }] : [],
      });
    }
  }
  return [...rows.values()];
}
