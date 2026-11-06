import type { DictationConfiguration } from "@omp-studio/studio-protocol";

export const PREVIEW_DICTATION_CONFIGURATION: DictationConfiguration = {
  protocolVersion: 2,
  configurationId: "demo-dictation-only",
  available: true,
  enabled: true,
  model: "local/whisper-small",
  language: "zh",
  submitTrigger: "never",
  mode: "segmented",
  languageSupport: "supported",
  cloud: false,
  credentials: "local",
  downloadRequired: false,
  sources: { enabled: "global", language: "global", submitTrigger: "default" },
};
export const PREVIEW_DICTATION_TEXT = "请检查 session 恢复后，API 配置和附件是否保留。";
