import { describe, expect, test } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { StudioEventEnvelope } from "@oh-my-pi/pi-coding-agent/studio/bridge-protocol";
import { StudioStateProjector } from "@oh-my-pi/pi-coding-agent/studio/state-projector";
import type { StudioHostRuntime, StudioWorkerResidency } from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

function runtimeFixture(): { runtime: StudioHostRuntime; manager: SessionManager } {
	const manager = SessionManager.inMemory();
	const runtime = {
		runtimeId: "runtime-title",
		runtimeEpoch: 3,
		sessionId: "session-title",
		sessionManager: manager,
		session: {
			isStreaming: false,
			isCompacting: false,
			queuedMessageCount: 0,
			getAgentId: () => "Main",
			getSessionStats: () => ({
				tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				cost: 0,
			}),
			getContextBreakdown: () => undefined,
			messages: [],
		},
		services: {
			pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
			loop: { state: () => undefined, onChange: () => () => {} },
			live: { state: () => ({ status: "off" }), onChange: () => () => {} },
			modes: { state: () => ({}), onChange: () => () => {} },
			agents: { list: () => [], onChange: () => () => {} },
			jobs: { list: () => [] },
		},
	} as unknown as StudioHostRuntime;
	return { runtime, manager };
}

describe("Studio session title projection", () => {
	test("retry deadlines survive repeated snapshots and disappear when recovery ends", () => {
		const { runtime } = runtimeFixture();
		const listeners = new Set<(event: AgentSessionEvent) => void>();
		runtime.session.subscribe = listener => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		};
		const projector = new StudioStateProjector(runtime);
		const before = Date.now();
		for (const listener of listeners)
			listener({
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 3600000,
				errorMessage: "quota unavailable",
			});
		const first = projector.snapshot();
		expect(first.retry?.nextRetryAt).toBeGreaterThanOrEqual(before + 3600000);
		expect(projector.snapshot().retry).toEqual(first.retry);
		for (const listener of listeners) listener({ type: "auto_retry_end", success: false, attempt: 1 });
		expect(projector.snapshot().retry).toBeUndefined();
		projector.dispose();
		expect(listeners.size).toBe(0);
	});
	test("projects native auto and manual title changes through state.changed", async () => {
		const { runtime, manager } = runtimeFixture();
		const projector = new StudioStateProjector(runtime);
		const events: StudioEventEnvelope[] = [];
		projector.onEvent(event => events.push(event));

		expect(projector.snapshot()).not.toHaveProperty("sessionTitle");
		expect(await manager.setSessionName("Generated title", "auto")).toBe(true);
		expect(await manager.setSessionName("Manual title", "user")).toBe(true);
		expect(await manager.setSessionName("Late generated title", "auto")).toBe(false);

		const titleSnapshots = events
			.filter(event => event.event.kind === "state.changed")
			.map(event => (event.event.kind === "state.changed" ? event.event.snapshot : undefined));
		expect(titleSnapshots).toHaveLength(2);
		expect(titleSnapshots[0]).toMatchObject({
			sessionTitle: "Generated title",
			sessionTitleSource: "auto",
		});
		expect(titleSnapshots[1]).toMatchObject({
			sessionTitle: "Manual title",
			sessionTitleSource: "user",
		});
		projector.dispose();
	});

	test("rebinds session title projection across worker revival and session manager replacement", async () => {
		const initialManager = SessionManager.inMemory();
		const revivedManager = SessionManager.inMemory();
		let activeManager = initialManager;
		let residency: StudioWorkerResidency = "active";
		let generation = 0;
		const workerListeners = new Set<() => void>();
		const sessionChangeListeners = new Set<() => void>();
		const runtime = {
			runtimeId: "runtime-revival-title",
			runtimeEpoch: 5,
			get sessionId() {
				return activeManager.getSessionId();
			},
			get sessionManager() {
				return activeManager;
			},
			workerResidency: () => residency,
			workerGeneration: () => generation,
			onWorkerStateChange: (listener: () => void) => {
				workerListeners.add(listener);
				return () => workerListeners.delete(listener);
			},
			session: {
				isStreaming: false,
				isCompacting: false,
				queuedMessageCount: 0,
				getAgentId: () => "Main",
				getSessionStats: () => ({
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					cost: 0,
				}),
				getContextBreakdown: () => undefined,
				messages: [],
				registerSessionChangeCallback: (listener: () => void) => {
					sessionChangeListeners.add(listener);
					return () => sessionChangeListeners.delete(listener);
				},
			},
			services: {
				pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
				loop: { state: () => undefined, onChange: () => () => {} },
				live: { state: () => ({ status: "off" }), onChange: () => () => {} },
				modes: { state: () => ({}), onChange: () => () => {} },
				agents: { list: () => [], onChange: () => () => {} },
				jobs: { list: () => [] },
			},
		} as unknown as StudioHostRuntime;

		const projector = new StudioStateProjector(runtime);
		const events: StudioEventEnvelope[] = [];
		projector.onEvent(event => events.push(event));

		// Simulate idle worker recycle -> revival with a new SessionManager instance.
		residency = "dormant";
		generation = 1;
		for (const listener of workerListeners) listener();
		activeManager = revivedManager;
		residency = "active";
		generation = 2;
		for (const listener of workerListeners) listener();

		events.length = 0;
		expect(await revivedManager.setSessionName("Revived streaming title", "auto")).toBe(true);
		// Old manager writes must no longer trigger state changes.
		expect(await initialManager.setSessionName("Stale disposed title", "auto")).toBe(true);

		const titleSnapshots = events
			.filter(event => event.event.kind === "state.changed")
			.map(event => (event.event.kind === "state.changed" ? event.event.snapshot : undefined));
		expect(titleSnapshots).toHaveLength(1);
		expect(titleSnapshots[0]).toMatchObject({
			sessionId: revivedManager.getSessionId(),
			sessionTitle: "Revived streaming title",
			sessionTitleSource: "auto",
		});

		// Also verify direct session replacement via registerSessionChangeCallback.
		const switchedManager = SessionManager.inMemory();
		activeManager = switchedManager;
		for (const listener of sessionChangeListeners) listener();
		events.length = 0;
		expect(await switchedManager.setSessionName("Switched session title", "auto")).toBe(true);
		expect(
			events
				.filter(event => event.event.kind === "state.changed")
				.map(event => (event.event.kind === "state.changed" ? event.event.snapshot?.sessionTitle : undefined)),
		).toEqual(["Switched session title"]);

		projector.dispose();
		expect(workerListeners.size).toBe(0);
		expect(sessionChangeListeners.size).toBe(0);
	});

	test("projects native toolcall_start auto-title through StudioStateProjector mid-turn after newSession()", async () => {
		const previousNoTitle = Bun.env.PI_NO_TITLE;
		delete Bun.env.PI_NO_TITLE;
		const authStorage = await AuthStorage.create(":memory:");
		let session: AgentSession | undefined;
		let projector: StudioStateProjector | undefined;
		try {
			authStorage.keys.setRuntime("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected claude-sonnet-4-5 model");

			const finishTurn = Promise.withResolvers<void>();
			const toolCallStarted = Promise.withResolvers<void>();
			const mainStreamFn = () => {
				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					const partial = {
						role: "assistant" as const,
						content: [
							{
								type: "toolCall" as const,
								id: "call_1",
								name: "read",
								arguments: {},
							},
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 10,
							output: 5,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 15,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial });
					toolCallStarted.resolve();
					await finishTurn.promise;
					const finalMessage = {
						...partial,
						content: [{ type: "text" as const, text: "Completed after long turn." }],
					};
					stream.push({ type: "text_start", contentIndex: 0, partial: finalMessage });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "Completed after long turn.", partial: finalMessage });
					stream.push({ type: "text_end", contentIndex: 0, content: "Completed after long turn.", partial: finalMessage });
					stream.push({ type: "done", reason: "stop", message: finalMessage });
				});
				return stream;
			};

			const side = createMockModel({
				handler: { content: ['<title emoji="⚡" code="TITLE">Project title at first tool call</title>'] },
			});
			session = new AgentSession({
				agent: new Agent({
					getApiKey: () => "test-key",
					initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
					streamFn: mainStreamFn,
				}),
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({
					"compaction.enabled": false,
					"retry.enabled": false,
					"title.icons": "emoji",
				}),
				modelRegistry: new ModelRegistry(authStorage),
				toolRegistry: new Map(),
				sideStreamFn: side.stream,
				autoTitle: true,
			});

			const activeSession = session;
			const runtime = {
				runtimeId: "runtime-live-title",
				runtimeEpoch: 7,
				get sessionId() {
					return activeSession.sessionManager.getSessionId();
				},
				get sessionManager() {
					return activeSession.sessionManager;
				},
				session: activeSession,
				services: {
					pause: { state: () => ({ paused: false, pauseEpoch: 0 }), onChange: () => () => {} },
					loop: { state: () => undefined, onChange: () => () => {} },
					live: { state: () => ({ status: "off" }), onChange: () => () => {} },
					modes: { state: () => ({}), onChange: () => () => {} },
					agents: { list: () => [], onChange: () => () => {} },
					jobs: { list: () => [] },
				},
			} as unknown as StudioHostRuntime;

			projector = new StudioStateProjector(runtime);
			// Switch to a fresh session (replaces sessionManager via registerSessionChangeCallback) before prompting.
			expect(await session.newSession()).toBe(true);

			const titleProjected = Promise.withResolvers<string>();
			projector.onEvent(event => {
				if (event.event.kind === "state.changed" && event.event.snapshot.sessionTitle) {
					titleProjected.resolve(event.event.snapshot.sessionTitle);
				}
			});

			const turnPromise = session.prompt("audit why studio title updates wait until turn end");
			await toolCallStarted.promise;
			// StudioStateProjector emits state.changed as soon as native OMP names the session at toolcall_start,
			// while the main turn is still mid-stream!
			expect(await titleProjected.promise).toBe("⚡ TITLE: Project title at first tool call");
			expect(session.isStreaming).toBe(true);

			finishTurn.resolve();
			await turnPromise;
		} finally {
			projector?.dispose();
			if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
			else Bun.env.PI_NO_TITLE = previousNoTitle;
			await session?.dispose();
			authStorage.close();
		}
	});
});
