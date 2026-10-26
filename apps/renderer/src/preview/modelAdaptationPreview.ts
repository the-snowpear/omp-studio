import { mergeModelParameters, MODEL_PARAMETER_FIELDS, type ModelAdaptationInput, type ModelAdaptationResult, type ModelAdaptationCandidate } from "@omp-studio/client-contract";

const entries: readonly ModelAdaptationCandidate[] = [
  { key: "demo/openai/glm-5", provider: "zhipu", api: "openai-completions", id: "glm-5", name: "GLM 5", aliases: ["glm-5-gateway"], values: { contextWindow: 202752, maxTokens: 65536, reasoning: true, thinkingConfig: { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "high" } } },
  { key: "demo/openrouter/glm-5", provider: "openrouter", api: "openai-completions", id: "z-ai/glm-5", name: "GLM 5 (OpenRouter)", aliases: ["glm-5-gateway"], values: { contextWindow: 131072, maxTokens: 32768, reasoning: true, thinkingConfig: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" } } },
  { key: "demo/openai/gpt-4.1", provider: "openai", api: "openai-completions", id: "gpt-4.1", name: "GPT 4.1", values: { contextWindow: 1047576, maxTokens: 32768, reasoning: false } },
  { key: "demo/anthropic/claude-opus", provider: "anthropic", api: "anthropic-messages", id: "claude-opus-4-1", name: "Claude Opus 4.1", values: { contextWindow: 200000, maxTokens: 32000, reasoning: true, thinkingConfig: { mode: "budget", efforts: ["low", "medium", "high"], defaultLevel: "medium" } } },
];

export function previewModelAdaptation(input: ModelAdaptationInput): ModelAdaptationResult {
  const normalize = (name: string) => name.toLowerCase().replace(/[\s._]+/g, "-");
  const candidates = entries.filter(row => row.api === input.api && [input.modelId, input.name].some(name => name && [row.id, row.name, ...(row.aliases ?? [])].some(alias => normalize(name) === normalize(alias))));
  const values = mergeModelParameters(candidates.length === 1 ? candidates[0]!.values : {}, input.endpoint ?? {});
  return {
    catalogVersion: "demo-v1", status: candidates.length === 1 ? "matched" : candidates.length ? "ambiguous" : "none", candidates, values,
    sources: Object.fromEntries(MODEL_PARAMETER_FIELDS.filter(field => values[field] !== undefined).map(field => [field, input.endpoint?.[field] !== undefined ? { source: "endpoint" } : { source: "catalog", catalogVersion: "demo-v1", catalogModel: candidates[0]?.key }])),
  };
}
