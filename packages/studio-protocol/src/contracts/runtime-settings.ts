import type { SessionId } from "./ids.js";

/** Runtime settings intentionally exposed to the Studio Bridge. */
export const STUDIO_RUNTIME_SETTING_KEYS = [
  "edit.autoRepair.enabled",
  "features.unexpectedStopDetection",
  "providers.unexpectedStopModel",
  "extendedContext",
  "compaction.asyncEnabled",
  "compaction.methodOrder",
  "providers.openai-codex.codeMode",
] as const;

export type StudioRuntimeSettingKey = (typeof STUDIO_RUNTIME_SETTING_KEYS)[number];

export const STUDIO_RUNTIME_UNEXPECTED_STOP_MODES = ["none", "mechanical", "smart"] as const;
export type StudioRuntimeUnexpectedStopMode = (typeof STUDIO_RUNTIME_UNEXPECTED_STOP_MODES)[number];

export const STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS = [
  "online",
  "qwen3-1.7b",
  "llama3.2:3b",
  "gemma-3-1b",
  "qwen2.5-1.5b",
  "lfm2-1.2b",
] as const;
export type StudioRuntimeUnexpectedStopModel = (typeof STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS)[number];

export const STUDIO_RUNTIME_COMPACTION_METHODS = [
  "remote",
  "snapcompact",
  "handoff",
  "soft",
  "shake",
] as const;
export type StudioRuntimeCompactionMethod = (typeof STUDIO_RUNTIME_COMPACTION_METHODS)[number];

export const STUDIO_RUNTIME_CODE_MODES = ["off", "on", "auto"] as const;
export type StudioRuntimeCodeMode = (typeof STUDIO_RUNTIME_CODE_MODES)[number];

/** Exact schema-backed public values; no arbitrary key/value escapes. */
export interface StudioRuntimeSettingsSnapshot {
  "edit.autoRepair.enabled": boolean;
  "features.unexpectedStopDetection": StudioRuntimeUnexpectedStopMode;
  "providers.unexpectedStopModel": StudioRuntimeUnexpectedStopModel;
  extendedContext: boolean;
  "compaction.asyncEnabled": boolean;
  "compaction.methodOrder": StudioRuntimeCompactionMethod[];
  "providers.openai-codex.codeMode": StudioRuntimeCodeMode;
}

export type StudioRuntimeSettingValue = StudioRuntimeSettingsSnapshot[StudioRuntimeSettingKey];

type StudioRuntimeSettingSetInputFor<K extends StudioRuntimeSettingKey> = {
  key: K;
  value: StudioRuntimeSettingsSnapshot[K];
  persist: boolean;
};

/** Correlated client input without the Runtime operation discriminant. */
export type StudioRuntimeSettingSetInput = {
  [K in StudioRuntimeSettingKey]: StudioRuntimeSettingSetInputFor<K>;
}[StudioRuntimeSettingKey];

/** Correlated key/value operation used by `runtime.settings.set`. */
export type StudioRuntimeSettingSetOperation = {
  [K in StudioRuntimeSettingKey]: StudioRuntimeSettingSetInputFor<K> & {
    kind: "runtime.settings.set";
  };
}[StudioRuntimeSettingKey];

export interface StudioRuntimeSettingsGetResult {
  values: Partial<StudioRuntimeSettingsSnapshot>;
}

export interface StudioRuntimeSettingsSetResult {
  key: StudioRuntimeSettingKey;
  value: StudioRuntimeSettingValue;
  persisted: boolean;
}

export interface StudioPlanSaveAndQuitResult {
  saved: true;
  path: string;
  exitedPlan: true;
  /** `failed` means save + Plan exit committed, but new-session creation threw. */
  newSession: "started" | "cancelled" | "failed";
  sessionId?: SessionId;
}

/** Runtime's optional snapshot-only speculation state. */
export type StudioCompactionSpeculation = "idle" | "running" | "armed";
