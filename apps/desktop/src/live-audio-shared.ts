export const LIVE_AUDIO_CHANNELS = {
  attach: "omp-studio:desktop:live-audio-attach",
  chunk: "omp-studio:desktop:live-audio-chunk",
  detach: "omp-studio:desktop:live-audio-detach",
} as const;
export interface LiveAudioResult { ok: boolean; message?: string }
export interface LiveAudioAttach { audioId: string; sessionId: string }
export interface LiveAudioChunk { audioId: string; sequence: number; bytes: ArrayBuffer }
