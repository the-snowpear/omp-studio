import type { DictationConfiguration, DictationProgress } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewDictationConfiguration(zh = isZh()): DictationConfiguration {
  return {
    protocolVersion: 2,
    configurationId: "demo-dictation-only",
    available: true,
    enabled: true,
    model: "local/whisper-small",
    language: zh ? "zh" : "en",
    submitTrigger: "never",
    mode: "segmented",
    languageSupport: "supported",
    cloud: false,
    credentials: "local",
    downloadRequired: false,
    sources: { enabled: "global", language: "global", submitTrigger: "default" },
  };
}

export function getPreviewDictationText(zh = isZh()): string {
  return zh
    ? "请检查 session 恢复后，API 配置和附件是否保留。"
    : "Check whether the API configuration and attachments remain intact after restoring the session.";
}

export const PREVIEW_DICTATION_CONFIGURATION: DictationConfiguration = getPreviewDictationConfiguration();
export const PREVIEW_DICTATION_TEXT = getPreviewDictationText();

export const PREVIEW_DICTATION_PREPARATION: DictationProgress = { stage: "initiate", component: "sherpa-onnx-node", loaded: 0, total: 0 };
