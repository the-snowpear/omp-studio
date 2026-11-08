import type { WebMcpListOptions, StudioWebMcpCatalog } from "./webmcp.js";
import type { LiveAudioState } from "./live-audio.js";
import type { ShellVizPreferences, ShellVizPresentation } from "./shell-view.js";
import type { RuntimeFeatureResultMap } from "./runtime-features.js";

export interface PromptCacheStatus {
  state: "warm" | "cold";
  reason?: { kind: "expired"; at: number } | { kind: "model" | "thinking"; from: string; to: string } | { kind: "refresh-missed" | "tools" | "system-prompt" | "retention" | "compaction" };
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
  | { kind: "agent.spawn.options.read"; sessionId: string; definition: string }
  | { kind: "session.lease.read"; sessionId: string; targetSessionIds: string[] }
  | { kind: "extensions.links.list"; sessionId: string; sourceSessionId?: string; agentId?: string }
  | { kind: "browser.webmcp.list"; sessionId: string; pageId: string; options?: WebMcpListOptions }
  | { kind: "session.cache.get"; sessionId: string }
  | { kind: "shell.view.read"; sessionId: string; sourceSessionId?: string; agentId?: string; toolCallId: string; preferences?: ShellVizPreferences }
  | { kind: "shell.view.release"; sessionId: string; sourceSessionId?: string; agentId?: string; toolCallId: string }
  | { kind: "live.webrtc.connect"; sessionId: string; audioId: string; sdpOffer: string; voice?: string }
  | { kind: "live.webrtc.status"; sessionId: string; audioId?: string }
  | { kind: "live.webrtc.mute"; sessionId: string; audioId: string; muted: boolean }
  | { kind: "live.webrtc.release"; sessionId: string; audioId: string };
export interface RuntimeViewResultMap {
  "agent.spawn.options.read": RuntimeFeatureResultMap["agent.spawn.options"];
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
export const RUNTIME_VIEW_KINDS = ["agent.spawn.options.read", "session.lease.read", "extensions.links.list", "browser.webmcp.list", "session.cache.get", "shell.view.read", "shell.view.release", "live.webrtc.connect", "live.webrtc.status", "live.webrtc.mute", "live.webrtc.release"] as const;
export function isRuntimeViewKind(kind: string): kind is RuntimeViewOperation["kind"] {
  return (RUNTIME_VIEW_KINDS as readonly string[]).includes(kind);
}
