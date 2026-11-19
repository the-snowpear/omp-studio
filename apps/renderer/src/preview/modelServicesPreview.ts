import type { ModelAntigravityReadiness, ModelAuthProvider, ModelProviderRoster, ModelSystemTemplateInspection, ModelSystemTemplatesList } from "@omp-studio/studio-protocol";
import type { ModelAvailability } from "@omp-studio/client-contract";

export const PREVIEW_MODEL_AUTH: ModelAuthProvider[] = [
  { id: "anthropic", name: "Anthropic", available: true, authenticated: true, kind: "oauth", credentials: [{ id: -1, label: "mira@studio.dev", type: "oauth" }] },
  { id: "antigravity-cli", name: "Antigravity CLI", available: true, authenticated: true, kind: "oauth", credentials: [{ id: -4, label: "mira@studio.dev", type: "oauth" }] },
  { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: true, kind: "oauth", credentials: [{ id: -5, label: "mira@studio.dev", type: "oauth" }], paused: true, pauseReason: "Usage limit reached on 2026-11-15 09:12. Requests stay paused until you resume them." },
  { id: "opencode-go", name: "OpenCode Go", available: true, authenticated: false, kind: "api-key", credentials: [] },
  { id: "opencode-zen", name: "OpenCode Zen", available: true, authenticated: false, kind: "api-key", credentials: [] },
  { id: "liquid", name: "Liquid AI", available: true, authenticated: true, kind: "api-key", credentials: [{ id: -2, label: "API key", type: "api_key" }] },
  { id: "typesafe", name: "TypeSafe", available: true, authenticated: false, kind: "api-key", credentials: [] },
  { id: "otari", name: "Otari", available: true, authenticated: true, kind: "api-key", credentials: [{ id: -3, label: "Studio workspace key", type: "api_key" }] },
  { id: "google-antigravity", name: "Google Antigravity", available: true, authenticated: false, kind: "oauth", credentials: [], warning: "Google's Antigravity terms do not allow third-party sign-in. Accounts may be suspended. Use a Gemini API key or Vertex AI for an account you depend on." },
];
/** Demo readiness only; a real `ready` never implies paid inference or quota was checked. */
export const PREVIEW_ANTIGRAVITY_READINESS: ModelAntigravityReadiness = {
  providerId: "antigravity-cli", installed: true, authenticated: true, bridgeReady: true, status: "ready", version: "1.5.9", source: "managed",
};
export function previewModelAvailability(total: number): ModelAvailability {
  return { status: "verified", source: "runtime", sessionId: "preview", version: "demo-gen-7c49c11a", total, truncated: false };
}
export const PREVIEW_SYSTEM_TEMPLATES: ModelSystemTemplatesList = {
  sessionId: "preview", version: "preview-v1", bindings: [
    { pattern: "claude", file: "~/studio-prompts/claude.md", source: "global", editable: true, effective: true },
    { pattern: "openai/gpt", file: "~/studio-prompts/gpt.md", source: "global", editable: true, effective: true },
  ],
};
export const PREVIEW_SYSTEM_TEMPLATE_CONTENT = "You are a coding assistant.\n\n{{#each tools}}- {{this}}\n{{/each}}\n\nWork in {{cwd}}.\n";
/** Pre-rendered fixture: preview never runs a second model-pattern matcher or Handlebars engine. */
export function previewSystemTemplateInspection(selector: string): ModelSystemTemplateInspection {
  return {
    selector,
    selection: { source: "model-template", pattern: "claude", path: "~/studio-prompts/claude.md", matchedTemplate: { pattern: "claude", path: "~/studio-prompts/claude.md" } },
    preview: "You are a coding assistant.\n\n- read\n- edit\n- bash\n\nWork in the OMP Studio workspace.",
    truncated: false,
  };
}
const PREVIEW_ROSTER_MODELS: Readonly<Record<string, ModelProviderRoster["models"]>> = {
  liquid: [
    { provider: "liquid", selector: "liquid/d1.1", name: "d1.1", kind: "judge", api: "liquid-systemone", reasoning: false, image: true, tools: false, contextWindow: 65536 },
    { provider: "liquid", selector: "liquid/d1-ultra", name: "d1-ultra", kind: "judge", api: "liquid-systemone", reasoning: false, image: true, tools: false, contextWindow: 32768 },
  ],
  otari: [
    { provider: "otari", selector: "otari/deepseek/deepseek-v4.1-flash", name: "DeepSeek workspace model", kind: "chat", api: "openai-completions", reasoning: true, image: false, tools: true, contextWindow: 131072 },
  ],
  "opencode-go": [
    { provider: "opencode-go", selector: "opencode-go/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", kind: "chat", api: "openai-completions", reasoning: true, image: true, tools: true },
  ],
  "opencode-zen": [
    { provider: "opencode-zen", selector: "opencode-zen/claude-sonnet-4-6", name: "Claude Sonnet 4.6", kind: "chat", api: "anthropic-messages", reasoning: true, image: true, tools: true },
  ],
};

export function previewProviderRoster(providerId: string): ModelProviderRoster {
  return { providerId, authenticated: true, authoritative: true, status: "ready", models: PREVIEW_ROSTER_MODELS[providerId] ?? [] };
}
