import type { WebMcpListOptions, StudioWebMcpCatalog } from "./webmcp-protocol";
import {
	SELECTIVE_COMMIT_QUERY_KINDS,
	type SelectiveCommitOperation,
	type SelectiveCommitQueryInputMap,
	type SelectiveCommitQueryResultMap,
} from "./commit-protocol";
import {
	PROMPT_HISTORY_QUERY_KINDS,
	type PromptHistoryQueryOperation,
	type PromptHistoryQueryResultMap,
} from "./prompt-history-protocol";
import type { LiveAudioState } from "./live-audio-protocol";
import type { ShellVizPreferences, ShellVizPresentation } from "./shell-view-protocol";
import type { RuntimeFeatureResultMap } from "./runtime-features-protocol";
import type { InteractionForm } from "./form-protocol";
import {
	MODEL_SERVICES_QUERY_KINDS,
	type ModelServicesOperation,
	type ModelServicesQueryInputMap,
	type ModelServicesQueryResultMap,
} from "./model-services-protocol";

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

/** One agent-to-agent message, as the recipient's session recorded it. */
export interface StudioAgentMessage {
	peer?: boolean;
	peerInstance?: string;
	id: string;
	from: string;
	to: string;
	body: string;
	/** Epoch milliseconds. */
	at: number;
	/** Id of the message this one answers. */
	replyTo?: string;
	/** One leg of the main agent's message to everyone. */
	broadcast?: boolean;
	/** An interim note on something the recipient asked. */
	progress?: boolean;
	/** A woken agent's turn output, relayed back to the agent that woke it. */
	relay?: boolean;
}

export interface StudioAgentMessages {
	/** Oldest first; the newest 500. */
	messages: StudioAgentMessage[];
	truncated: boolean;
}

/** Transient reads, reversible close checks and media negotiation: no payload is persisted in the command ledger. */
export type RuntimeViewOperation =
	| Extract<SelectiveCommitOperation, { kind: keyof SelectiveCommitQueryInputMap }>
	| PromptHistoryQueryOperation
	| Extract<ModelServicesOperation, { kind: keyof ModelServicesQueryInputMap }>
	| { kind: "runtime.close.confirm"; sessionId: string }
	| { kind: "interaction.form.read"; sessionId: string; interactionId: string; leaseGeneration: number }
	| { kind: "agent.spawn.options.read"; sessionId: string; definition: string }
	| { kind: "agent.messages.list"; sessionId: string }
	| { kind: "session.lease.read"; sessionId: string; targetSessionIds: string[] }
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
	| { kind: "shell.view.release"; sessionId: string; sourceSessionId?: string; agentId?: string; toolCallId: string }
	| { kind: "live.webrtc.connect"; sessionId: string; audioId: string; sdpOffer: string; voice?: string }
	| { kind: "live.webrtc.status"; sessionId: string; audioId?: string }
	| { kind: "live.webrtc.mute"; sessionId: string; audioId: string; muted: boolean }
	| { kind: "live.webrtc.release"; sessionId: string; audioId: string };
export interface RuntimeViewResultMap
	extends ModelServicesQueryResultMap, SelectiveCommitQueryResultMap, PromptHistoryQueryResultMap {
	"runtime.close.confirm": { allowed: boolean };
	"interaction.form.read": { form: InteractionForm };
	"agent.spawn.options.read": RuntimeFeatureResultMap["agent.spawn.options"];
	"agent.messages.list": StudioAgentMessages;
	"session.lease.read": RuntimeFeatureResultMap["session.lease.inspect"];
	"extensions.links.list": { schemes: string[] };
	"browser.webmcp.list": StudioWebMcpCatalog;
	"session.cache.get": { cache: PromptCacheStatus | null };
	"shell.view.read": { available: boolean; presentation?: ShellVizPresentation; reason?: string };
	"shell.view.release": { released: true };
	"live.webrtc.connect": { audioId: string; sdpAnswer: string; state: LiveAudioState };
	"live.webrtc.status": LiveAudioState;
	"live.webrtc.mute": LiveAudioState;
	"live.webrtc.release": LiveAudioState;
}
export const RUNTIME_VIEW_KINDS = [
	...SELECTIVE_COMMIT_QUERY_KINDS,
	...PROMPT_HISTORY_QUERY_KINDS,
	...MODEL_SERVICES_QUERY_KINDS,
	"runtime.close.confirm",
	"interaction.form.read",
	"agent.spawn.options.read",
	"agent.messages.list",
	"session.lease.read",
	"extensions.links.list",
	"browser.webmcp.list",
	"session.cache.get",
	"shell.view.read",
	"shell.view.release",
	"live.webrtc.connect",
	"live.webrtc.status",
	"live.webrtc.mute",
	"live.webrtc.release",
] as const;
export function isRuntimeViewKind(kind: string): kind is RuntimeViewOperation["kind"] {
	return (RUNTIME_VIEW_KINDS as readonly string[]).includes(kind);
}
