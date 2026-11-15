

export const STATUS_META: Record<string, { label: string; chip: string; dot: string }> = {
  available: { label: "Available", chip: "green", dot: "green" },
  "not-authenticated": { label: "Not Authenticated", chip: "amber", dot: "amber" },
  disabled: { label: "Disabled", chip: "gray", dot: "" },
  offline: { label: "Offline", chip: "red", dot: "red" },
  "auth-expired": { label: "Authentication Expired", chip: "amber", dot: "amber" },
  "config-error": { label: "Configuration Error", chip: "red", dot: "red" },
  "connection-failed": { label: "Connection Failed", chip: "red", dot: "red" },
};

// 原生 = OMP 内置/运行时解析；第三方 = 用户自定义/扩展。
export const SOURCE_GROUP = (source: string): "native" | "third" =>
  source === "builtin" || source === "runtime" ? "native" : "third";

const BUILTIN_ROLE_DESC_KEYS: Record<string, string> = {
  default: "modelConfig.roleDescDefault",
  smol: "modelConfig.roleDescFast",
  slow: "modelConfig.roleDescThinking",
  vision: "modelConfig.roleDescVision",
  plan: "modelConfig.roleDescArchitect",
  designer: "modelConfig.roleDescDesigner",
  commit: "modelConfig.roleDescCommit",
  tiny: "modelConfig.roleDescTiny",
  task: "modelConfig.roleDescSubtask",
  advisor: "modelConfig.roleDescAdvisor",
  widget: "modelConfig.roleDescWidget",
  memory: "modelConfig.roleDescMemory",
  image: "modelConfig.roleDescImage",
  web: "modelConfig.roleDescWeb",
  speech: "modelConfig.roleDescSpeech",
  dictation: "modelConfig.roleDescDictation",
  judge: "modelConfig.roleDescJudge",
};

const PRESET_GROUP_EN: Record<string, string> = {
  "官方 / 主流": "Official / Popular",
  "Gateway / 聚合": "Gateway / Aggregators",
  "本地": "Local",
  "更多 Provider": "More Providers",
};

const PRESET_NAME_EN: Record<string, string> = {
  zhipu: "Zhipu",
};

const PRESET_DESC_EN: Record<string, string> = {
  mistral: "Mistral Vibe browser login or API key",
  devin: "Import Devin CLI credentials or use Windsurf enterprise account",
  "muse-code": "Muse Spark subscription, account model discovery, and quota",
  anthropic: "Official Claude model API",
  openai: "Official GPT model API",
  "openai-codex": "Codex subscription quota (ChatGPT account)",
  "google-gemini": "Official Gemini model API",
  "gemini-cli": "Gemini Code Assist subscription",
  xai: "Grok model family",
  groq: "High-speed inference (Llama / Mixtral)",
  deepseek: "DeepSeek V / R series",
  moonshot: "Kimi K series models",
  modular: "Modular Cloud models and native reasoning parameters",
  commandcode: "Native OpenAI / Anthropic routing, discovery, and pricing",
  openrouter: "Access multiple providers with one key",
  "github-copilot": "Copilot subscription quota",
  litellm: "Self-hosted unified model proxy",
  ollama: "Local model server; auto-discovers pulled models",
  "lm-studio": "Local OpenAI-compatible server",
  "llama.cpp": "llama-server OpenAI-compatible endpoint",
  qwen: "Official Qwen (Tongyi Qianwen) API",
  zhipu: "GLM series models",
  fireworks: "Fireworks AI hosted inference",
  siliconflow: "SiliconFlow model cloud",
};

export function formatPresetGroup(group: string, zh: boolean): string {
  return zh ? group : (PRESET_GROUP_EN[group] ?? group);
}

export function formatPresetName(id: string, name: string, zh: boolean): string {
  return zh ? name : (PRESET_NAME_EN[id] ?? name);
}

export function formatPresetDesc(id: string, desc: string, zh: boolean): string {
  return zh ? desc : (PRESET_DESC_EN[id] ?? desc);
}

export function formatRoleDesc(role: { id: string; desc: string; builtin?: boolean }, t: (k: string) => string): string {
  const key = BUILTIN_ROLE_DESC_KEYS[role.id];
  if (role.builtin && key) {
    return t(key);
  }
  return role.desc;
}

const PROVIDER_STATUS_DETAIL_KEYS: Record<string, string> = {
  "OMP 已解析到可用模型": "modelConfig.statusOmpResolved",
  "已从 models.yml 读取": "modelConfig.statusReadFromModelsYml",
  "已在 disabledProviders 中禁用": "modelConfig.statusDisabledInConfig",
  "已禁用": "modelConfig.statusDisabled",
  "尚未登录": "modelConfig.statusNotLoggedIn",
  "尚未配置凭据": "modelConfig.statusNoCredentials",
  "已登录 · 演示账号": "modelConfig.statusDemoAccount",
  "API Key 已保存": "modelConfig.statusApiKeySaved",
  "本地服务未运行": "modelConfig.statusLocalServiceNotRunning",
};

export function formatProviderStatusDetail(detail: string | undefined, t: (k: string) => string, marks = true, zh = false): string {
  if (!detail) return "";
  if (!marks) {
    if (detail === "已登录 · 演示账号" || detail === "Logged in · Demo Account") return zh ? "已登录" : "Logged in";
    if (detail === "Demo · Not written to Host") return "";
    return detail;
  }
  if (PROVIDER_STATUS_DETAIL_KEYS[detail]) {
    return t(PROVIDER_STATUS_DETAIL_KEYS[detail]);
  }
  return detail;
}
