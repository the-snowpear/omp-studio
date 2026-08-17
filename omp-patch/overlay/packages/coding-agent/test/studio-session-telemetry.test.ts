import { describe, expect, test } from "bun:test";
import type { StudioEventEnvelope } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import type { ConversationRuntimeEvent } from "@oh-my-pi/pi-coding-agent/studio/conversation-protocol";
import {
	buildStudioSessionTelemetry,
	type StudioTelemetrySessionPort,
} from "@oh-my-pi/pi-coding-agent/studio/session-telemetry";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

const wait = (milliseconds: number): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, milliseconds);
	});

function runtimeFixture(options: { readonly contextAvailable?: boolean; readonly negativeUsage?: boolean } = {}): {
	readonly runtime: StudioHostRuntime;
	emitConversation(event: ConversationRuntimeEvent): void;
} {
	let conversationListener: ((event: ConversationRuntimeEvent) => void) | undefined;
	const negative = options.negativeUsage === true;
	const runtime = {
		runtimeId: "runtime-telemetry",
		runtimeEpoch: 3,
		sessionId: "session-telemetry",
		sessionManager: {},
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			getAgentId: () => "Main",
			getSessionStats: () => ({
				tokens: {
					input: negative ? -1 : 11,
					output: negative ? -2 : 7,
					reasoning: negative ? -3 : 3,
					cacheRead: negative ? -4 : 5,
					cacheWrite: negative ? -5 : 2,
					total: negative ? -6 : 28,
				},
				cost: negative ? -7 : 0.25,
			}),
			getContextBreakdown: () =>
				options.contextAvailable === true
					? {
							contextWindow: 100,
							usedTokens: 25,
							anchored: true,
							systemPromptTokens: 4,
							systemContextTokens: 3,
							systemToolsTokens: 2,
							skillsTokens: 1,
							messagesTokens: 15,
						}
					: undefined,
			messages: [
				{
					role: "assistant",
					stopReason: "stop",
					timestamp: "2026-08-16T00:00:00.000Z",
					usage: {
						input: negative ? -1 : 4,
						output: negative ? -1 : 3,
						reasoningTokens: negative ? -1 : 2,
						cacheRead: negative ? -1 : 1,
						cacheWrite: negative ? -1 : 1,
						totalTokens: negative ? -1 : 11,
						cost: { total: negative ? -1 : 0.1 },
					},
				},
			],
		},
		services: {
			pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
			loop: { state: () => undefined, onChange: () => () => {} },
			live: { state: () => ({ status: "off" }), onChange: () => () => {} },
			modes: { state: () => ({}), onChange: () => () => {} },
			commands: { manifestHash: () => "sha256:commands" },
			agents: { list: () => [], onChange: () => () => {} },
			jobs: { list: () => [] },
			conversation: {
				onEvent: (listener: (event: ConversationRuntimeEvent) => void) => {
					conversationListener = listener;
					return () => {
						if (conversationListener === listener) conversationListener = undefined;
					};
				},
			},
		},
	} as unknown as StudioHostRuntime;
	return {
		runtime,
		emitConversation(event) {
			conversationListener?.(event);
		},
	};
}

describe("studio session telemetry", () => {
	test("snapshot clamps usage and marks an unknown context window", () => {
		const fixture = runtimeFixture({ negativeUsage: true });
		const projector = new StudioStateProjector(fixture.runtime);
		const telemetry = projector.snapshot().telemetry;
		expect(telemetry?.sessionId).toBe("session-telemetry");
		expect(telemetry?.tokens).toEqual({
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: 0,
		});
		expect(telemetry?.lastCompletedTurn).toMatchObject({ total: 0, cost: 0 });
		expect(telemetry?.context).toBeNull();
		expect(telemetry?.unavailableReason).toBe("model_context_unknown");
		projector.dispose();
	});

	test("burst events coalesce, completion emits immediately, and dispose clears a timer", async () => {
		const fixture = runtimeFixture({ contextAvailable: true });
		const projector = new StudioStateProjector(fixture.runtime);
		const events: StudioEventEnvelope[] = [];
		projector.onEvent(event => events.push(event));
		// Telemetry only tracks the main session, so these must carry its id.
		const delta = {
			kind: "conversation.message.delta",
			sessionId: "session-telemetry",
		} as ConversationRuntimeEvent;
		fixture.emitConversation(delta);
		fixture.emitConversation(delta);
		fixture.emitConversation(delta);
		expect(events.filter(event => event.event.kind === "session.telemetry.changed")).toHaveLength(0);
		await wait(320);
		expect(events.filter(event => event.event.kind === "session.telemetry.changed")).toHaveLength(1);
		fixture.emitConversation({
			kind: "conversation.turn.completed",
			sessionId: "session-telemetry",
		} as ConversationRuntimeEvent);
		const telemetryEvents = events.filter(event => event.event.kind === "session.telemetry.changed");
		expect(telemetryEvents).toHaveLength(2);
		const latest = telemetryEvents.at(-1)?.event;
		expect(latest?.kind === "session.telemetry.changed" ? latest.telemetry.context?.percent : undefined).toBe(25);
		fixture.emitConversation(delta);
		projector.dispose();
		await wait(320);
		expect(events.filter(event => event.event.kind === "session.telemetry.changed")).toHaveLength(2);
	});

	test("live projector and the shared builder produce identical telemetry for the same session port", () => {
		const fixture = runtimeFixture({ contextAvailable: true });
		const projector = new StudioStateProjector(fixture.runtime);
		const live = projector.snapshot().telemetry;
		if (live === undefined) throw new Error("expected live telemetry snapshot");
		const port = fixture.runtime.session as unknown as StudioTelemetrySessionPort;
		const recomputed = buildStudioSessionTelemetry({
			sessionId: "session-telemetry",
			session: port,
			capturedAt: live.capturedAt,
		});
		expect(recomputed).toEqual(live);
		projector.dispose();
	});

	test("the shared builder clamps non-finite usage to zero", () => {
		const telemetry = buildStudioSessionTelemetry({
			sessionId: "session-nan",
			capturedAt: "2026-08-16T00:00:00.000Z",
			session: {
				getSessionStats: () => ({
					tokens: {
						input: Number.NaN,
						output: Number.POSITIVE_INFINITY,
						reasoning: -1,
						cacheRead: 0,
						cacheWrite: 0,
						total: Number.NaN,
					},
					cost: Number.POSITIVE_INFINITY,
				}),
				getContextBreakdown: () => ({
					contextWindow: 200,
					anchored: false,
					usedTokens: Number.NaN,
					systemPromptTokens: 1.5,
					systemContextTokens: Number.POSITIVE_INFINITY,
					systemToolsTokens: 2,
					skillsTokens: 0,
					messagesTokens: 3,
				}),
				messages: [],
			},
		});
		expect(telemetry.tokens).toEqual({
			input: 0,
			output: 0,
			reasoning: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
			cost: 0,
		});
		expect(telemetry.context).toEqual({
			contextWindow: 200,
			usedTokens: 0,
			percent: 0,
			anchored: false,
			systemPromptTokens: 1,
			systemContextTokens: 0,
			systemToolsTokens: 2,
			skillsTokens: 0,
			messagesTokens: 3,
		});
		expect(telemetry.lastCompletedTurn).toBeUndefined();
	});

	test("aborted and error assistant turns never become lastCompletedTurn", () => {
		const usage = {
			input: 1,
			output: 2,
			reasoningTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { total: 0.5 },
		};
		const telemetry = buildStudioSessionTelemetry({
			sessionId: "session-turns",
			capturedAt: "2026-08-16T00:00:00.000Z",
			session: {
				getSessionStats: () => ({
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
				}),
				getContextBreakdown: () => undefined,
				messages: [
					{ role: "assistant", stopReason: "aborted", timestamp: 1, usage },
					{ role: "assistant", stopReason: "error", timestamp: 2, usage },
					{
						role: "assistant",
						stopReason: "stop",
						timestamp: 3,
						usage,
					},
				],
			},
		});
		expect(telemetry.lastCompletedTurn?.completedAt).toBe(new Date(3).toISOString());
		expect(telemetry.lastCompletedTurn?.total).toBe(3);
	});

	test("lastCompletedTurn derives TPS from the measured request duration only", () => {
		const baseUsage = {
			input: 100,
			output: 450,
			reasoningTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 550,
			cost: { total: 0.01 },
		};
		const build = (message: Record<string, unknown>) =>
			buildStudioSessionTelemetry({
				sessionId: "session-tps",
				capturedAt: "2026-08-16T00:00:00.000Z",
				session: {
					getSessionStats: () => ({
						tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						cost: 0,
					}),
					getContextBreakdown: () => undefined,
					messages: [{ role: "assistant", stopReason: "stop", timestamp: 1, usage: baseUsage, ...message }],
				},
			});
		const measured = build({ duration: 10_000 });
		expect(measured.lastCompletedTurn?.durationMs).toBe(10_000);
		expect(measured.lastCompletedTurn?.tps).toBe(45);
		const unmeasured = build({});
		expect(unmeasured.lastCompletedTurn?.durationMs).toBeUndefined();
		expect(unmeasured.lastCompletedTurn?.tps).toBeUndefined();
		const bogus = build({ duration: Number.NaN });
		expect(bogus.lastCompletedTurn?.durationMs).toBeUndefined();
		expect(bogus.lastCompletedTurn?.tps).toBeUndefined();
		const tooShort = build({ duration: 50 });
		expect(tooShort.lastCompletedTurn?.durationMs).toBeUndefined();
		expect(tooShort.lastCompletedTurn?.tps).toBeUndefined();
		const zeroOutput = build({ duration: 5_000, usage: { ...baseUsage, output: 0 } });
		expect(zeroOutput.lastCompletedTurn?.durationMs).toBe(5_000);
		expect(zeroOutput.lastCompletedTurn?.tps).toBeUndefined();
	});
});
