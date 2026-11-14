export const LIVE_AUDIO_VOICES = ["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"] as const;
export interface LiveAudioState {
  available: boolean; audioId?: string; attached: boolean; voice: string;
  phase: "off" | "prepared" | "connecting" | "listening" | "speaking" | "working" | "muted" | "error";
  muted: boolean; inputLevel: number; outputLevel: number;
  transcripts: Array<{ role: "user" | "assistant"; turn: number; text: string; final: boolean }>;
  error?: string;
}
export type LiveAudioOperation =
  | { kind: "live.audio.prepare"; sessionId: string; voice?: string }
  | { kind: "live.audio.start"; sessionId: string; audioId: string }
  | { kind: "live.audio.status"; sessionId: string }
  | { kind: "live.audio.mute"; sessionId: string; audioId: string; muted: boolean }
  | { kind: "live.audio.release"; sessionId: string; audioId: string };
export interface LiveAudioResultMap {
  "live.audio.prepare": LiveAudioState;
  "live.audio.start": LiveAudioState;
  "live.audio.status": LiveAudioState;
  "live.audio.mute": LiveAudioState;
  "live.audio.release": LiveAudioState;
}
export const LIVE_AUDIO_OPERATION_KINDS = ["live.audio.prepare", "live.audio.start", "live.audio.status", "live.audio.mute", "live.audio.release"] as const;
export function isLiveAudioOperationKind(kind: string): kind is LiveAudioOperation["kind"] { return (LIVE_AUDIO_OPERATION_KINDS as readonly string[]).includes(kind); }
