import type { WebMcpListOptions, StudioWebMcpCatalog } from "./webmcp-protocol";
import type { LiveAudioState } from "./live-audio-protocol";
import type { ShellVizPreferences, ShellVizPresentation } from "./shell-view-protocol";

export interface PromptCacheStatus {
	state: "warm" | "cold";
	reason?:
		| { kind: "expired"; at: number }
		| { kind: "model" | "thinking"; from: string; to: string }
		| { kind: "refresh-missed" | "tools" | "system-prompt" | "retention" | "compaction" };
	inferred: boolean;
	tier: "short" | "long";
	touchedAt: number;
	ttlMs?: number;
	cachedTokens: number;
	nextTokens: number;
	warming?: { state: "scheduled" | "refreshing" | "inactive"; nextWarmAt?: number; stopsAt?: number; reason?: string };
}

/** Transient reads and media negotiation: no payload is persisted in the command ledger. */
export type RuntimeViewOperation =
	| { kind: "extensions.links.list"; sessionId: string; sourceSessionId?: string; agentId?: string }
	| { kind: "browser.webmcp.list"; sessionId: string; pageId: string; options?: WebMcpListOptions }
	| { kind: "session.cache.get"; sessionId: string }
	| {
			kind: "shell.view.read";
			sessionId: string;
			sourceSessionId?: string;
			agentId?: string;
			toolCallId: string;
			preferences?: ShellVizPreferences;
	  }
	| { kind: "live.webrtc.connect"; sessionId: string; audioId: string; sdpOffer: string; voice?: string }
	| { kind: "live.webrtc.status"; sessionId: string; audioId?: string }
	| { kind: "live.webrtc.mute"; sessionId: string; audioId: string; muted: boolean }
	| { kind: "live.webrtc.release"; sessionId: string; audioId: string };
export interface RuntimeViewResultMap {
	"extensions.links.list": { schemes: string[] };
	"browser.webmcp.list": StudioWebMcpCatalog;
	"session.cache.get": { cache: PromptCacheStatus | null };
	"shell.view.read": { available: boolean; presentation?: ShellVizPresentation; reason?: string };
	"live.webrtc.connect": { audioId: string; sdpAnswer: string; state: LiveAudioState };
	"live.webrtc.status": LiveAudioState;
	"live.webrtc.mute": LiveAudioState;
	"live.webrtc.release": LiveAudioState;
}
export const RUNTIME_VIEW_KINDS = [
	"extensions.links.list",
	"browser.webmcp.list",
	"session.cache.get",
	"shell.view.read",
	"live.webrtc.connect",
	"live.webrtc.status",
	"live.webrtc.mute",
	"live.webrtc.release",
] as const;
export function isRuntimeViewKind(kind: string): kind is RuntimeViewOperation["kind"] {
	return (RUNTIME_VIEW_KINDS as readonly string[]).includes(kind);
}
