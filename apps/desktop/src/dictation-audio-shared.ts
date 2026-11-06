import type { DictationCaptureState, DictationChannel, DictationInput } from "@omp-studio/studio-protocol";

export const DICTATION_AUDIO_CHANNELS = {
  attach: "omp-studio:desktop:dictation-attach",
  input: "omp-studio:desktop:dictation-input",
  chunk: "omp-studio:desktop:dictation-chunk",
  drain: "omp-studio:desktop:dictation-drain",
  recovery: "omp-studio:desktop:dictation-recovery",
  replay: "omp-studio:desktop:dictation-replay",
  retain: "omp-studio:desktop:dictation-retain",
  release: "omp-studio:desktop:dictation-release",
  event: "omp-studio:desktop:dictation-event",
} as const;

export const DICTATION_MAX_DURATION_MS = 10 * 60 * 1000;
export const DICTATION_MAX_PCM_BYTES = 16000 * 2 * (DICTATION_MAX_DURATION_MS / 1000);

export interface DictationOwner {
  sessionId: string;
  draftId: string;
  label?: string;
}
export interface DictationRecovery {
  audioId: string;
  owner: DictationOwner;
  state: DictationCaptureState;
  durationMs: number;
  bytes: number;
  retained: boolean;
  canReplay: boolean;
  configuration: DictationChannel["configuration"];
}
export interface DictationAudioResult {
  ok: boolean;
  code?: string;
  message?: string;
  recovery?: DictationRecovery | null;
}
export type DictationDesktopEvent =
  | { kind: "state"; audioId: string; owner: DictationOwner; state: DictationCaptureState }
  | { kind: "retained"; recovery: DictationRecovery }
  | { kind: "limit"; audioId: string }
  | { kind: "released"; audioId: string };

export interface DictationAudioAttach {
  channel: DictationChannel;
  owner: DictationOwner;
  recoveryId?: string;
}
export interface DictationAudioApi {
  attachDictationAudio(input: DictationAudioAttach): Promise<DictationAudioResult>;
  controlDictationAudio(input: { audioId: string; input: DictationInput }): Promise<DictationAudioResult>;
  appendDictationAudio(input: { audioId: string; sequence: number; bytes: ArrayBuffer }): Promise<DictationAudioResult>;
  drainDictationAudio(input: { audioId: string }): Promise<DictationAudioResult>;
  getDictationRecovery(): Promise<DictationAudioResult>;
  replayDictationAudio(input: { audioId: string }): Promise<DictationAudioResult>;
  retainDictationAudio(input: { audioId: string }): Promise<DictationAudioResult>;
  releaseDictationAudio(input: { audioId: string }): Promise<DictationAudioResult>;
  onDictationAudio(listener: (event: DictationDesktopEvent) => void): () => void;
}
