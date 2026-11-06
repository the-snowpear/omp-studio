export type DictationSubmitTrigger = "never" | "release" | "release-complete" | "say-submit";
export type DictationInputMode = "click" | "hold" | "toggle" | "retry";
export type DictationPhase =
	| "prepared"
	| "preparing"
	| "ready"
	| "recording"
	| "transcribing"
	| "complete"
	| "error"
	| "cancelled";
export interface DictationConfiguration {
	protocolVersion: 2;
	configurationId: string;
	/** Effective native keybindings; empty lists explicitly disable the action. */
	hotkeys?: { pushToTalk: string[]; toggle: string[] };
	available: boolean;
	enabled: boolean;
	model: string;
	language: string;
	submitTrigger: DictationSubmitTrigger;
	mode: "streaming" | "segmented" | "batch";
	languageSupport: "supported" | "unsupported" | "unknown";
	cloud: boolean;
	credentials: "local" | "configured" | "missing" | "unknown";
	downloadRequired: boolean;
	downloadSize?: string;
	blockedReason?:
		| "desktop-unavailable"
		| "live-active"
		| "capture-active"
		| "disabled"
		| "model-unavailable"
		| "language-unsupported"
		| "credentials-missing";
	message?: string;
	sources: { enabled: string; language: string; submitTrigger: string; model?: string; credentials?: string };
}
export interface DictationChannel {
	protocolVersion: 2;
	audioId: string;
	sessionId: string;
	expiresAt: number;
	configuration: DictationConfiguration;
}
export interface DictationProgress {
	stage: string;
	percent?: number;
	loaded?: number;
	total?: number;
}
/** Ephemeral audio sideband only; never returned in a command receipt. */
export interface DictationCaptureState {
	phase: DictationPhase;
	committedText: string;
	partialText: string;
	submit: boolean;
	notice?: "no-speech";
	message?: string;
	progress?: DictationProgress;
	error?: { code: string; message: string };
}
export type DictationInput =
	| { kind: "start"; mode: DictationInputMode; configurationId: string }
	| { kind: "recording" }
	| { kind: "drain"; requestId: string }
	| { kind: "stop" }
	| { kind: "cancel" }
	| { kind: "snapshot" }
	| { kind: "ping" };
export type DictationEvent =
	| { kind: "state"; audioId: string; sequence: number; state: DictationCaptureState }
	| { kind: "drained"; audioId: string; sequence: number; requestId: string };
/** Legacy metadata: text always empty on the Studio command plane. */
export interface DictationState {
	available: boolean;
	enabled: boolean;
	audioId?: string;
	phase: "off" | "prepared" | "starting" | "recording" | "transcribing" | "complete" | "error";
	text: string;
	model: string;
	language: string;
	cloud: boolean;
	downloadRequired: boolean;
	downloadSize?: string;
	error?: string;
}
export type DictationOperation =
	| { kind: "dictation.inspect"; sessionId: string }
	| { kind: "dictation.open"; sessionId: string; configurationId: string }
	| { kind: "dictation.status"; sessionId: string }
	| { kind: "dictation.prepare"; sessionId: string }
	| { kind: "dictation.start"; sessionId: string; audioId: string }
	| { kind: "dictation.stop"; sessionId: string; audioId: string }
	| { kind: "dictation.cancel"; sessionId: string; audioId: string };
export interface DictationResultMap {
	"dictation.inspect": DictationConfiguration;
	"dictation.open": DictationChannel;
	"dictation.status": DictationState;
	"dictation.prepare": DictationState;
	"dictation.start": DictationState;
	"dictation.stop": DictationState;
	"dictation.cancel": DictationState;
}
export const DICTATION_KINDS = [
	"dictation.inspect",
	"dictation.open",
	"dictation.status",
	"dictation.prepare",
	"dictation.start",
	"dictation.stop",
	"dictation.cancel",
] as const;
export function isDictationKind(kind: string): kind is DictationOperation["kind"] {
	return (DICTATION_KINDS as readonly string[]).includes(kind);
}
