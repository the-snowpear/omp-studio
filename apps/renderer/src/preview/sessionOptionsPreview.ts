import type { ModelPresetRow, SessionSpeedState, SessionWarmingState } from "@omp-studio/studio-protocol";
export const PREVIEW_MODEL_PRESETS: ModelPresetRow[] = [
  { name: "everyday", source: "global", active: true, roles: { default: "anthropic/claude-haiku-4.5", task: "anthropic/claude-haiku-4.5", judge: "anthropic/claude-opus-4.1" }, thinking: "medium" },
  { name: "review", source: "project", active: false, roles: { default: "anthropic/claude-opus-4.1", task: "anthropic/claude-haiku-4.5", judge: "anthropic/claude-opus-4.1" }, thinking: "high" },
];
export const PREVIEW_SPEED: SessionSpeedState = { model: "anthropic/claude-opus-4.1", selected: "normal", supported: ["normal", "fast", "ultrafast", "slow"], fastActive: false, slowEnabled: false, slowScope: "session" };
export const PREVIEW_WARMING: SessionWarmingState = { mode: "off", source: "runtime", state: "inactive" };
