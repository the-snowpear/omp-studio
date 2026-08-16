import type { SessionId } from "./ids.js";

/** Sanitized, numeric-only Runtime telemetry for the active session. */
export interface SessionTelemetrySnapshot {
  readonly sessionId: SessionId;
  readonly capturedAt: string;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
    /** Runtime-native cost value; currency is intentionally not inferred. */
    readonly cost: number;
  };
  /** Usage from the latest completed assistant response, if available. */
  readonly lastCompletedTurn?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
    readonly cost: number;
    readonly completedAt: string;
  };
  readonly context: {
    readonly contextWindow: number;
    readonly usedTokens: number;
    readonly percent: number;
    readonly anchored: boolean;
    readonly systemPromptTokens: number;
    readonly systemContextTokens: number;
    readonly systemToolsTokens: number;
    readonly skillsTokens: number;
    readonly messagesTokens: number;
  } | null;
  readonly unavailableReason?: "runtime_not_ready" | "model_context_unknown";
}

export type SessionTelemetryEvent = {
  readonly kind: "session.telemetry.changed";
  readonly sessionId: SessionId;
  readonly telemetry: SessionTelemetrySnapshot;
};
