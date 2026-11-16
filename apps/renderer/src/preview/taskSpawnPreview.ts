import type { RuntimeFeatureResultMap } from "@omp-studio/studio-protocol";

export const PREVIEW_TASK_SPAWN_OPTIONS: RuntimeFeatureResultMap["agent.spawn.options"] = {
  stepsAdvertised: true,
  autoParallel: "off",
  effortSelection: true,
  modelSelection: true,
  maxEffort: "max",
  models: [
    { selector: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet", thinkingLevels: ["low", "medium", "high"] },
    { selector: "openai-codex/gpt-6-astra", name: "GPT-6 Astra", thinkingLevels: ["low", "medium", "high", "xhigh"] },
  ],
};
