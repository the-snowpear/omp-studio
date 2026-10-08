import type { ModelPresetRow, SessionSpeedState, SessionWarmingState } from "@omp-studio/studio-protocol";
export const PREVIEW_MODEL_PRESETS: ModelPresetRow[] = [
  { name: "everyday", source: "global", active: true, roles: { default: "demo/swift", task: "demo/swift", judge: "demo/reason" }, thinking: "medium" },
  { name: "review", source: "project", active: false, roles: { default: "demo/reason", task: "demo/swift", judge: "demo/reason" }, thinking: "high" },
];
export const PREVIEW_SPEED: SessionSpeedState = { model: "demo/reason", selected: "normal", supported: ["normal", "fast", "ultrafast", "slow"], fastActive: false, slowEnabled: false, slowScope: "session" };
export const PREVIEW_WARMING: SessionWarmingState = { mode: "off", source: "runtime", state: "inactive" };
