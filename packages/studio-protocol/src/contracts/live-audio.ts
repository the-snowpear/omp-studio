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
function object(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid Live audio fields"); return value as Record<string, unknown>; }
function id(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid Live audio id"); }
export function validateLiveAudioOperation(value: unknown): asserts value is LiveAudioOperation {
  const kind = (value as { kind?: unknown } | null)?.kind; if (typeof kind !== "string" || !isLiveAudioOperationKind(kind)) throw new Error("Unknown Live audio operation");
  const row = object(value, ["kind", "sessionId", ...(kind === "live.audio.prepare" ? ["voice"] : kind === "live.audio.mute" ? ["audioId", "muted"] : (kind === "live.audio.release" || kind === "live.audio.start") ? ["audioId"] : [])]);
  if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > 512) throw new Error("Invalid Live session");
  if (row.voice !== undefined && !(LIVE_AUDIO_VOICES as readonly unknown[]).includes(row.voice)) throw new Error("Unknown Live voice");
  if (kind === "live.audio.start" || kind === "live.audio.mute" || kind === "live.audio.release") id(row.audioId);
  if (kind === "live.audio.mute" && typeof row.muted !== "boolean") throw new Error("Invalid mute flag");
}
export function validateLiveAudioResult(_kind: LiveAudioOperation["kind"], value: unknown): void {
  const row = object(value, ["available", "audioId", "attached", "voice", "phase", "muted", "inputLevel", "outputLevel", "transcripts", "error"]);
  for (const key of ["available", "attached", "muted"]) if (typeof row[key] !== "boolean") throw new Error("Invalid Live state");
  if (row.audioId !== undefined) id(row.audioId);
  if (!(LIVE_AUDIO_VOICES as readonly unknown[]).includes(row.voice) || !["off", "prepared", "connecting", "listening", "speaking", "working", "muted", "error"].includes(row.phase as string)) throw new Error("Invalid Live phase or voice");
  for (const key of ["inputLevel", "outputLevel"]) if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1) throw new Error("Invalid Live level");
  if (row.error !== undefined && (typeof row.error !== "string" || row.error.length > 1000)) throw new Error("Invalid Live error");
  if (!Array.isArray(row.transcripts) || row.transcripts.length > 40) throw new Error("Invalid Live transcripts");
  for (const value of row.transcripts) { const item = object(value, ["role", "turn", "text", "final"]); if (!["user", "assistant"].includes(item.role as string) || !Number.isSafeInteger(item.turn) || (item.turn as number) < 0 || typeof item.text !== "string" || item.text.length > 2000 || typeof item.final !== "boolean") throw new Error("Invalid Live transcript"); }
}
