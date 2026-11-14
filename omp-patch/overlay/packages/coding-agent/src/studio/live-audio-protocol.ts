export const LIVE_AUDIO_VOICES = [
	"arbor",
	"breeze",
	"cove",
	"ember",
	"juniper",
	"maple",
	"sol",
	"spruce",
	"vale",
] as const;
export interface LiveAudioState {
	available: boolean;
	audioId?: string;
	attached: boolean;
	voice: string;
	phase: "off" | "prepared" | "connecting" | "listening" | "speaking" | "working" | "muted" | "error";
	muted: boolean;
	inputLevel: number;
	outputLevel: number;
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
export const LIVE_AUDIO_OPERATION_KINDS = [
	"live.audio.prepare",
	"live.audio.start",
	"live.audio.status",
	"live.audio.mute",
	"live.audio.release",
] as const;
export function isLiveAudioOperationKind(kind: string): kind is LiveAudioOperation["kind"] {
	return (LIVE_AUDIO_OPERATION_KINDS as readonly string[]).includes(kind);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Live audio fields");
	return value as Record<string, unknown>;
}
function id(value: unknown): void {
	if (typeof value !== "string" || !/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid Live audio id");
}
export function validateLiveAudioOperation(value: unknown): asserts value is LiveAudioOperation {
	const kind = (value as { kind?: unknown } | null)?.kind;
	if (typeof kind !== "string" || !isLiveAudioOperationKind(kind)) throw new Error("Unknown Live audio operation");
	const row = object(value);
	if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > 512)
		throw new Error("Invalid Live session");
	if (row.voice !== undefined && !(LIVE_AUDIO_VOICES as readonly unknown[]).includes(row.voice))
		throw new Error("Unknown Live voice");
	if (kind === "live.audio.start" || kind === "live.audio.mute" || kind === "live.audio.release") id(row.audioId);
	if (kind === "live.audio.mute" && typeof row.muted !== "boolean") throw new Error("Invalid mute flag");
}
