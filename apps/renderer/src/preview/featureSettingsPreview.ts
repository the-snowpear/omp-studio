import type { FeatureSettingRow, PoolAccountOption } from "@omp-studio/studio-protocol";
export const PREVIEW_FEATURE_SETTINGS: FeatureSettingRow[] = [
  { key: "task.agentAccountPools", value: { reviewer: { anthropic: ["email:review@example.test"] } }, source: "project" },
  { key: "compaction.modelThresholds", value: {}, source: "default" },
  { key: "retry.fallbackOn", value: "any", source: "default" },
  { key: "contextFiles.extra", value: ["AGENTS.local.md"], source: "project" },
  { key: "task.structured", value: false, source: "default" },
  { key: "bash.gitGuard", value: false, source: "default" },
  { key: "worktree.onStart", value: "off", source: "default" },
  { key: "worktree.onExit", value: "keep", source: "default" },
  { key: "composer.predictions", value: false, source: "default" },
  { key: "speech.speed", value: 1, source: "default" },
  { key: "tts.localSpeed", value: 1, source: "default" },
  { key: "gc.compress", value: false, source: "default" },
  { key: "gc.compressAfterDays", value: 7, source: "default" },
  { key: "prewalk.auto", value: "suggest", source: "global" },
  { key: "prewalk.autoTarget", value: "@smol", source: "default" },
  { key: "async.widgets", value: true, source: "default" },
  { key: "computer.backgroundFallback", value: "takeover", source: "default" },
];
export const PREVIEW_POOL_ACCOUNTS: PoolAccountOption[] = [
  { provider: "anthropic", identityKey: "email:review@example.test", label: "Review · Team" },
  { provider: "anthropic", identityKey: "email:personal@example.test", label: "Personal" },
  { provider: "openai-codex", identityKey: "account:studio-demo", label: "Studio · Pro" },
];
