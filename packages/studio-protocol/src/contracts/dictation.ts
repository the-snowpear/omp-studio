export interface DictationState {
  available: boolean; enabled: boolean; audioId?: string;
  phase: "off" | "prepared" | "starting" | "recording" | "transcribing" | "complete" | "error";
  text: string; model: string; language: string; cloud: boolean; downloadRequired: boolean; downloadSize?: string; error?: string;
}
export type DictationOperation =
  | { kind: "dictation.status"; sessionId: string }
  | { kind: "dictation.prepare"; sessionId: string }
  | { kind: "dictation.start"; sessionId: string; audioId: string }
  | { kind: "dictation.stop"; sessionId: string; audioId: string }
  | { kind: "dictation.cancel"; sessionId: string; audioId: string };
export interface DictationResultMap {
  "dictation.status": DictationState; "dictation.prepare": DictationState; "dictation.start": DictationState; "dictation.stop": DictationState; "dictation.cancel": DictationState;
}
export const DICTATION_KINDS = ["dictation.status", "dictation.prepare", "dictation.start", "dictation.stop", "dictation.cancel"] as const;
export function isDictationKind(kind: string): kind is DictationOperation["kind"] { return (DICTATION_KINDS as readonly string[]).includes(kind); }
