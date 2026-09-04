/**
 * Shared Studio session-telemetry builder.
 *
 * One algorithm serves both producers:
 * - the live `StudioStateProjector` (telemetry for the running session), and
 * - the offline `--studio-session-telemetry-probe` (recomputed telemetry for
 *   an archived session transcript copy).
 *
 * Both call {@link buildStudioSessionTelemetry} with a {@link StudioTelemetrySessionPort}.
 * Duplicating the clamp/derivation logic in a second place is forbidden: the
 * live and recomputed numbers must stay byte-identical for identical inputs.
 */

import type { StudioSessionTelemetry } from "./bridge-protocol";

/** Hidden CLI argument handled by `cli.ts` before command dispatch. */
export const STUDIO_SESSION_TELEMETRY_PROBE_ARG = "--studio-session-telemetry-probe";

/**
 * Minimal read-only session surface consumed by the telemetry builder. The
 * live projector satisfies it with its `AgentSession`; the offline probe
 * satisfies it with a read-only stats session reconstructed from a validated
 * transcript copy. Every numeric input is clamped defensively so a partially
 * available port degrades to zeros instead of throwing.
 */
export interface StudioTelemetrySessionPort {
	getSessionStats(): {
		tokens: {
			input: number;
			output: number;
			reasoning: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		cost: number;
	};
	getContextBreakdown():
		| {
				contextWindow: number;
				anchored: boolean;
				usedTokens: number;
				systemPromptTokens: number;
				systemContextTokens: number;
				systemToolsTokens: number;
				skillsTokens: number;
				messagesTokens: number;
		  }
		| undefined;
	readonly messages: readonly unknown[];
}

export interface BuildStudioSessionTelemetryInput {
	readonly sessionId: string;
	readonly session: StudioTelemetrySessionPort;
	readonly capturedAt: string;
}

interface TelemetryUsageShape {
	role?: string;
	stopReason?: string;
	timestamp?: number | string;
	/** Provider request wall time in milliseconds, measured by the client. */
	duration?: number;
	usage?: {
		input?: number;
		output?: number;
		reasoningTokens?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
}

function finiteNonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeNonNegativeInteger(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	const truncated = Math.trunc(value);
	return Number.isSafeInteger(truncated) ? truncated : Number.MAX_SAFE_INTEGER;
}

/** Clamp an assistant usage number: NaN/Infinity/negative all become 0. */
function usageValue(value: number | undefined): number {
	return finiteNonNegative(typeof value === "number" ? value : 0);
}

export function buildStudioSessionTelemetry(input: BuildStudioSessionTelemetryInput): StudioSessionTelemetry {
	const session = input.session;
	const stats =
		typeof session.getSessionStats === "function"
			? session.getSessionStats()
			: {
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
				};
	// Both calls walk the context: `getSessionStats` ends in `getContextUsage()`,
	// which is `getContextBreakdown()` again (session/session-stats.ts). The
	// breakdown cannot be hoisted out of the duplication from here — the upstream
	// `getSessionStats()` takes no arguments and its `contextUsage` carries only
	// tokens/window/percent, not the per-category fields this telemetry reports.
	// Removing the second walk means changing an upstream signature, which is a
	// seam change, not an overlay one.
	const context = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;
	const tokens = stats.tokens;
	const contextKnown = context !== undefined && Number.isFinite(context.contextWindow) && context.contextWindow > 0;
	const telemetry: StudioSessionTelemetry = {
		sessionId: input.sessionId,
		capturedAt: input.capturedAt,
		tokens: {
			input: finiteNonNegative(tokens.input),
			output: finiteNonNegative(tokens.output),
			reasoning: finiteNonNegative(tokens.reasoning),
			cacheRead: finiteNonNegative(tokens.cacheRead),
			cacheWrite: finiteNonNegative(tokens.cacheWrite),
			total: finiteNonNegative(tokens.total),
			cost: finiteNonNegative(stats.cost),
		},
		context: contextKnown
			? {
					contextWindow: Math.max(1, safeNonNegativeInteger(context.contextWindow)),
					usedTokens: safeNonNegativeInteger(context.usedTokens),
					percent:
						context.contextWindow > 0 ? finiteNonNegative((context.usedTokens / context.contextWindow) * 100) : 0,
					anchored: context.anchored === true,
					systemPromptTokens: safeNonNegativeInteger(context.systemPromptTokens),
					systemContextTokens: safeNonNegativeInteger(context.systemContextTokens),
					systemToolsTokens: safeNonNegativeInteger(context.systemToolsTokens),
					skillsTokens: safeNonNegativeInteger(context.skillsTokens),
					messagesTokens: safeNonNegativeInteger(context.messagesTokens),
				}
			: null,
		...(contextKnown ? {} : { unavailableReason: "model_context_unknown" as const }),
	};
	const rawMessages = session.messages;
	const messages = (Array.isArray(rawMessages) ? rawMessages : []) as TelemetryUsageShape[];
	// Scan backwards in place. Copying and reversing the whole message array to
	// find one message costs an allocation proportional to the session on every
	// rebuild, and rebuilds run on every message/turn/compaction terminal.
	let assistant: TelemetryUsageShape | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (
			message !== undefined &&
			message.role === "assistant" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			message.usage?.cost?.total !== undefined
		) {
			assistant = message;
			break;
		}
	}
	if (assistant?.usage) {
		const usage = assistant.usage;
		const completedAt =
			typeof assistant.timestamp === "number"
				? new Date(assistant.timestamp).toISOString()
				: typeof assistant.timestamp === "string" && assistant.timestamp.length > 0
					? assistant.timestamp
					: telemetry.capturedAt;
		// `assistant.duration` is the provider request wall time measured by
		// the client — the same source the status line's tok/s uses. Mirror
		// utils/token-rate.ts: skip sub-100ms requests so TPS stays sane.
		const durationMs =
			typeof assistant.duration === "number" && Number.isFinite(assistant.duration) && assistant.duration >= 100
				? assistant.duration
				: undefined;
		const outputTokens = usageValue(usage.output);
		const tps =
			durationMs !== undefined && outputTokens > 0
				? Number((outputTokens / (durationMs / 1000)).toFixed(1))
				: undefined;
		telemetry.lastCompletedTurn = {
			input: usageValue(usage.input),
			output: usageValue(usage.output),
			reasoning: usageValue(usage.reasoningTokens),
			cacheRead: usageValue(usage.cacheRead),
			cacheWrite: usageValue(usage.cacheWrite),
			total: usageValue(usage.totalTokens),
			cost: usageValue(usage.cost?.total),
			completedAt,
			...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
			...(tps === undefined || !Number.isFinite(tps) ? {} : { tps }),
		};
	}
	return telemetry;
}
