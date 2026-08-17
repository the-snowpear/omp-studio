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
    /** Provider request wall time in milliseconds; absent when unmeasured. */
    readonly durationMs?: number;
    /** Output tokens per second over `durationMs`; absent when underivable. */
    readonly tps?: number;
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
  readonly unavailableReason?: SessionTelemetryUnavailableReason;
}

export type SessionTelemetryUnavailableReason =
  | "runtime_not_ready"
  | "model_context_unknown"
  | "probe_dynamic_context_disabled";

/** Where a `session.telemetry.read` result came from. */
export type SessionTelemetrySource = "live" | "persisted" | "archive-recomputed";

/** How to interpret the numbers of a `session.telemetry.read` result. */
export type SessionTelemetrySemantics =
  | "current-live"
  | "last-observed"
  | "current-environment-recomputed";

/** Result of the read-only `session.telemetry.read` client query. */
export interface SessionTelemetryReadResult {
  readonly sessionId: SessionId;
  readonly source: SessionTelemetrySource;
  readonly semantics: SessionTelemetrySemantics;
  readonly telemetry: SessionTelemetrySnapshot;
}

export type SessionTelemetryEvent = {
  readonly kind: "session.telemetry.changed";
  readonly sessionId: SessionId;
  readonly telemetry: SessionTelemetrySnapshot;
};
