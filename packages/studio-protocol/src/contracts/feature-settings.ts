import type { SessionCompactionState } from "./session-compaction.js";
/** Additive settings surface for Runtime 18.10; the published settings payload stays unchanged. */
export const FEATURE_SETTING_KEYS = [
  "magicKeywords.enabled", "magicKeywords.chillax",
  "out.enabled",
  "btw.inject",
  "composer.predictionAlternatives",
  "display.shellVisualization",
  "title.refreshAfterPrompts",
  "display.advisorCollapsedLines",
  "task.file",
  "task.perCallModel",
  "task.perCallModelAllow",
  "task.workerThreads",
  "ovnfs.path",
  "prewalk.from",
  "prewalk.into",
  "retry.rateLimitWalksChain",
  "providers.openaiResponsesWebsockets",
  "providers.openai-codex.daybreak",
  "judgment.attemptTimeoutMs",
  "skills.manualSkills",
  "hindsight.globalScope",
  "tools.xdevNotices",
  "spotlight.experiment.enabled",
  "spotlight.url",
  "spotlight.model",
  "spotlight.thinking",
  "spotlight.timeoutMs",
  "spotlight.experiment.holdout",
  "spotlight.experiment.scoreFree",
  "spotlight.experiment.tools",

  "task.agentAccountPools", "compaction.modelThresholds", "retry.fallbackOn",
  "contextFiles.extra", "task.structured", "bash.gitGuard", "worktree.onStart",
  "worktree.onExit", "composer.predictions", "speech.speed", "tts.localSpeed",
  "gc.compress", "gc.compressAfterDays", "prewalk.auto", "prewalk.autoTarget",
  "async.widgets", "computer.enabled", "computer.display", "computer.maxWidth", "computer.maxHeight",
  "computer.backgroundFallback", "tools.restrictedFolders",
  "extensionHandlers.modeControl", "recap.enabled", "recap.idleSeconds",
  "compaction.idleEnabled", "compaction.idleThresholdTokens", "compaction.idleTimeoutSeconds",
  "gc.autoCompress", "session.worktreeScope", "stt.enabled", "stt.language", "stt.submitTrigger",
] as const;
export type FeatureSettingKey = (typeof FEATURE_SETTING_KEYS)[number];
export type FeatureSettingValue = null | boolean | number | string | FeatureSettingValue[] | { [key: string]: FeatureSettingValue };
export interface FeatureSettingRow {
  key: FeatureSettingKey;
  value: FeatureSettingValue;
  source: "env" | "runtime" | "overlay" | "project" | "global" | "default";
}
export interface PoolAccountOption { provider: string; identityKey: string; label: string }
export type ProviderAccountPools = Record<string, string[]>;
export type AgentAccountPools = Record<string, ProviderAccountPools | null>;
export interface AgentAccountPoolState {
  global: AgentAccountPools;
  effective: AgentAccountPools;
}
export interface CompactionPreview {
  valid: boolean;
  summary?: string;
  window?: number;
  trigger?: number;
  extended: boolean;
}
export type FeatureSettingsOperation =
  | { kind: "session.compaction.get"; sessionId: string }
  | { kind: "session.compaction.set"; sessionId: string; input: string }
  | { kind: "preferences.features.get"; sessionId: string }
  | { kind: "preferences.features.set"; sessionId: string; key: FeatureSettingKey; value: FeatureSettingValue; scope: "session" | "global" }
  | { kind: "preferences.features.clearOverride"; sessionId: string; key: FeatureSettingKey }
  | { kind: "accounts.pool.options"; sessionId: string }
  | { kind: "accounts.pool.get"; sessionId: string }
  | { kind: "accounts.pool.set"; sessionId: string; agent: string; pools: ProviderAccountPools | null }
  | { kind: "models.compaction.preview"; sessionId: string; selector: string; input: string }
  | { kind: "models.compaction.set"; sessionId: string; selector: string; input: string; confirmed?: boolean };
export interface FeatureSettingsResultMap {
  "session.compaction.get": SessionCompactionState;
  "session.compaction.set": SessionCompactionState;
  "preferences.features.get": { settings: FeatureSettingRow[] };
  "preferences.features.set": FeatureSettingRow;
  "preferences.features.clearOverride": FeatureSettingRow;
  "accounts.pool.options": { accounts: PoolAccountOption[]; truncated: boolean };
  "accounts.pool.get": AgentAccountPoolState;
  "accounts.pool.set": AgentAccountPoolState;
  "models.compaction.preview": CompactionPreview;
  "models.compaction.set": { saved: boolean; confirmationRequired: boolean; summary: string };
}
export const FEATURE_SETTINGS_KINDS = ["session.compaction.get", "session.compaction.set", "preferences.features.get", "preferences.features.set", "preferences.features.clearOverride", "accounts.pool.options", "accounts.pool.get", "accounts.pool.set", "models.compaction.preview", "models.compaction.set"] as const;
export const FEATURE_SETTINGS_READ_KINDS = ["session.compaction.get", "preferences.features.get", "accounts.pool.options", "accounts.pool.get", "models.compaction.preview"] as const;
export function isFeatureSettingsKind(kind: string): kind is FeatureSettingsOperation["kind"] {
  return (FEATURE_SETTINGS_KINDS as readonly string[]).includes(kind);
}
