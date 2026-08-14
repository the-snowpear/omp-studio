/**
 * Preview fixtures for the model-config page, ported from
 * ui_reference/ver1/assets/js/models-data.js. Display only.
 */

import type {
  ModelApiKind,
  ModelAuthType,
  ModelCatalogEntry,
  ModelConfigReadModel,
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
  return models.map((model) => ({ ...model, selector: `${providerId}/${model.id}` }));
}

export const MODEL_PRESETS: ReadonlyArray<ModelPresetGroup> = [
  {
    group: "官方 / 主流",
    items: [
      { id: "anthropic", name: "Anthropic", desc: "Claude 系列模型官方 API", api: "anthropic-messages", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.anthropic.com/v1" },
      { id: "openai", name: "OpenAI", desc: "GPT 系列模型官方 API", api: "openai-responses", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://api.openai.com/v1" },
      { id: "openai-codex", name: "OpenAI Codex", desc: "Codex 订阅额度（ChatGPT 账号）", api: "openai-codex-responses", auth: ["oauth"], oauth: true, endpoint: "https://api.openai.com/v1" },
      { id: "google-gemini", name: "Google Gemini", desc: "Gemini 系列模型官方 API", api: "google-generative-ai", auth: ["oauth", "api-key"], popular: true, oauth: true, endpoint: "https://generativelanguage.googleapis.com/v1beta" },
      { id: "xai", name: "xAI", desc: "Grok 系列模型", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.x.ai/v1" },
      { id: "deepseek", name: "DeepSeek", desc: "DeepSeek V / R 系列", api: "openai-completions", auth: ["api-key"], endpoint: "https://api.deepseek.com/v1" },
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
    ],
  },
];

export const MODEL_API_TYPES: ReadonlyArray<{ id: ModelApiKind | string; label: string }> = [
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

export const MODEL_AUTH_TYPES: ReadonlyArray<{ id: ModelAuthType; label: string }> = [
  { id: "oauth", label: "OMP Login / OAuth" },
  { id: "api-key", label: "API Key" },
  { id: "env", label: "Environment Variable" },
  { id: "command", label: "External Command" },
  { id: "none", label: "无需认证" },
];

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

export function createPreviewModelConfig(): ModelConfigReadModel {
  const providers: ModelProviderRecord[] = [
    provider({
      id: "anthropic", name: "Anthropic", source: "builtin", status: "available",
      statusDetail: "已登录 · 演示账号", api: "anthropic-messages",
      endpointUrl: "https://api.anthropic.com/v1", local: false, enabled: true,
      website: "https://www.anthropic.com", auth: { type: "oauth", hasSecret: true, account: "demo@anthropic.com" },
      models: [
        m("claude-opus-4.8", "Claude Opus 4.8", 200000, 64000, { img: true, reason: true, cIn: 15, cOut: 75 }),
        m("claude-sonnet-4.5", "Claude Sonnet 4.5", 200000, 64000, { img: true, reason: true, cIn: 3, cOut: 15 }),
        m("claude-haiku-4.5", "Claude Haiku 4.5", 200000, 64000, { img: true, cIn: 1, cOut: 5 }),
      ],
    }),
    provider({
      id: "openai", name: "OpenAI", source: "builtin", status: "available",
      statusDetail: "API Key 已保存", api: "openai-responses",
      endpointUrl: "https://api.openai.com/v1", local: false, enabled: true,
      website: "https://platform.openai.com", auth: { type: "api-key", hasSecret: true },
      models: [
        m("gpt-5.2", "GPT-5.2", 400000, 128000, { img: true, reason: true, cIn: 1.75, cOut: 14 }),
        m("gpt-5.2-codex", "GPT-5.2 Codex", 400000, 128000, { img: true, reason: true, cIn: 1.75, cOut: 14 }),
        m("gpt-5-mini", "GPT-5 mini", 400000, 128000, { img: true, reason: true, cIn: 0.25, cOut: 2 }),
      ],
    }),
    provider({
      id: "openrouter", name: "OpenRouter", source: "builtin", status: "not-authenticated",
      statusDetail: "尚未配置凭据", api: "openai-completions",
      endpointUrl: "https://openrouter.ai/api/v1", local: false, enabled: true,
      auth: { type: "api-key", hasSecret: false },
      models: [m("auto", "OpenRouter Auto", 200000, 32000, { img: true, reason: true, status: "unavailable" })],
    }),
    provider({
      id: "lm-studio", name: "LM Studio", source: "runtime", status: "offline",
      statusDetail: "本地服务未运行", api: "openai-completions",
      endpointUrl: "http://localhost:1234/v1", local: true, enabled: true,
      auth: { type: "none", hasSecret: false },
      discovery: { type: "lm-studio", timeoutMs: 5000 },
      models: [],
    }),
    provider({
      id: "zhipu", name: "Zhipu / 智谱", source: "builtin", status: "disabled",
      statusDetail: "已禁用", api: "openai-completions",
      endpointUrl: "https://open.bigmodel.cn/api/paas/v4", local: false, enabled: false,
      auth: { type: "api-key", hasSecret: true },
      models: [m("glm-4.6", "GLM 4.6", 200000, 8192, { reason: true, status: "disabled" })],
    }),
  ];

  const roles: ModelRoleRecord[] = [
    { id: "default", alias: "@default", name: "Default", desc: "默认主模型", builtin: true, primary: "anthropic/claude-sonnet-4.5", scope: "global" },
    { id: "smol", alias: "@smol", name: "Fast", desc: "快速、低成本任务", builtin: true, primary: "openai/gpt-5-mini", thinking: "low", scope: "global" },
    { id: "slow", alias: "@slow", name: "Thinking", desc: "复杂推理任务", builtin: true, primary: "openai/gpt-5.2", thinking: "high", scope: "global" },
    { id: "vision", alias: "@vision", name: "Vision", desc: "视觉与图片任务", builtin: true, primary: "anthropic/claude-sonnet-4.5", scope: "global" },
    { id: "plan", alias: "@plan", name: "Architect", desc: "规划和架构任务", builtin: true, primary: "anthropic/claude-opus-4.8", thinking: "high", scope: "global" },
    { id: "designer", alias: "@designer", name: "Designer", desc: "设计相关任务", builtin: true, primary: "openrouter/auto", thinking: "medium", scope: "global", issue: { kind: "model-unavailable", detail: "模型不可用" } },
    { id: "commit", alias: "@commit", name: "Commit", desc: "Commit 相关任务", builtin: true, primary: "anthropic/claude-haiku-4.5", thinking: "low", scope: "global" },
    { id: "tiny", alias: "@tiny", name: "Tiny", desc: "标题、记忆等极轻量后台任务", builtin: true, primary: "lm-studio/qwen", thinking: "off", scope: "global", issue: { kind: "provider-down", detail: "本地服务未运行" } },
    { id: "task", alias: "@task", name: "Subtask", desc: "通用子任务", builtin: true, primary: "openai/gpt-5-mini", scope: "global" },
    { id: "advisor", alias: "@advisor", name: "Advisor", desc: "第二模型审查", builtin: true, primary: "openai/gpt-5.2", thinking: "medium", scope: "global" },
  ];

  const availableModels = providers.flatMap((item) =>
    item.models.filter((model) => model.status === "available").map((model) => ({
      provider: item.id,
      id: model.id,
      selector: model.selector,
      name: model.name,
      reasoning: model.reasoning,
    })),
  );

  return {
    providers,
    presets: MODEL_PRESETS,
    roles,
    cycleOrder: ["smol", "default", "slow"],
    availableModels,
    loginProviders: [
      { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
      { id: "openai", name: "OpenAI", available: true, authenticated: false },
    ],
    generatedModelsYml: "providers:\n  anthropic:\n    api: anthropic-messages\n",
    generatedConfigYml: "modelRoles:\n  default: anthropic/claude-sonnet-4.5\n",
    runtimeEffectHint: "演示数据不会写入本机 OMP 配置。",
    loginAvailable: false,
    ompAvailable: true,
  };
}
