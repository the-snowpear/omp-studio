import type { LiveAudioState } from "@omp-studio/studio-protocol";
import { isZh } from "../i18n";

export function getPreviewLiveAudio(zh = isZh()): LiveAudioState {
  return {
    available: true, attached: false, voice: "sol", phase: "off", muted: false, inputLevel: 0, outputLevel: 0,
    transcripts: [
      { role: "user", turn: 1, text: zh ? "帮我检查服务配置，但先不要启动。" : "Check the service configuration for me, but do not start it yet.", final: true },
      { role: "assistant", turn: 1, text: zh ? "已把检查任务交给当前会话。配置保存后不会自动启动服务。" : "Assigned the inspection task to the current session. Services will not auto-start after saving the config.", final: true },
    ],
  };
}

export const PREVIEW_LIVE_AUDIO: LiveAudioState = getPreviewLiveAudio();
