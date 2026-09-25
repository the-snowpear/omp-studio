import type { LiveAudioState } from "@omp-studio/studio-protocol";
export const PREVIEW_LIVE_AUDIO: LiveAudioState = {
  available: true, attached: false, voice: "sol", phase: "off", muted: false, inputLevel: 0, outputLevel: 0,
  transcripts: [
    { role: "user", turn: 1, text: "帮我检查服务配置，但先不要启动。", final: true },
    { role: "assistant", turn: 1, text: "已把检查任务交给当前会话。配置保存后不会自动启动服务。", final: true },
  ],
};
