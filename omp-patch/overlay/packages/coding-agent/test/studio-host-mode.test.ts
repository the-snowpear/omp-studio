import { describe, expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	createStudioHostRuntime,
	runStudioHostMode,
	type StudioBridgeLifecycle,
	type StudioHostRuntime,
} from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";

function fakeSession(sessionId = "session-test"): AgentSession {
	return {
		sessionManager: { getSessionId: () => sessionId, getCwd: () => process.cwd() },
		settings: { get: (key: string) => (key === "loop.mode" ? "prompt" : undefined) },
		isStreaming: false,
		isCompacting: false,
		hasPostPromptWork: false,
		getVibeModeState: () => undefined,
		prompt: async () => {},
		compact: async () => {},
		resetSessionContext: async () => {},
		subscribe: () => () => {},
		setBeforeNextUserTurn: () => {},
	} as unknown as AgentSession;
}

describe("studio-host runtime", () => {
	test("binds the TUI and Bridge lifecycle to one session identity", async () => {
		const session = fakeSession();
		let bridgeRuntime: StudioHostRuntime | undefined;
		let tuiRuntime: StudioHostRuntime | undefined;
		let stopCalls = 0;
		const bridge: StudioBridgeLifecycle = {
			async start(runtime) {
				bridgeRuntime = runtime;
			},
			async stop() {
				stopCalls++;
			},
		};

		await runStudioHostMode(
			session,
			{ endpoint: "omp-studio-test", tokenFile: "C:\\temp\\omp-studio.token", runtimeEpoch: 7 },
			async runtime => {
				tuiRuntime = runtime;
			},
			{ createBridge: () => bridge, createRuntimeId: () => "runtime-test" },
		);

		expect(bridgeRuntime).toBe(tuiRuntime);
		expect(tuiRuntime?.runtimeId).toBe("runtime-test");
		expect(tuiRuntime?.runtimeEpoch).toBe(7);
		expect(tuiRuntime?.sessionId).toBe("session-test");
		expect(tuiRuntime?.session).toBe(session);
		expect(tuiRuntime?.sessionManager).toBe(session.sessionManager);
		expect(tuiRuntime?.bridgeConfig).toEqual({
			endpoint: "omp-studio-test",
			tokenFile: "C:\\temp\\omp-studio.token",
			runtimeEpoch: 7,
		});
		expect(stopCalls).toBe(1);
	});

	test("installs and invalidates the Remote UI factory through the session setter", async () => {
		const setCalls: Array<{ hasUI: boolean; kind: string }> = [];
		const session = fakeSession();
		const bridge: StudioBridgeLifecycle = {
			async start() {},
			async stop() {},
		};
		await runStudioHostMode(
			session,
			{ endpoint: "omp-studio-test", tokenFile: "C:\\temp\\omp-studio.token", runtimeEpoch: 7 },
			async () => {},
			{
				createBridge: () => bridge,
				createRuntimeId: () => "runtime-test",
				setToolUIContext: (uiContext, hasUI) => {
					setCalls.push({ hasUI, kind: typeof uiContext === "function" ? "factory" : "context" });
				},
			},
		);
		expect(setCalls).toEqual([
			{ hasUI: true, kind: "factory" },
			{ hasUI: false, kind: "context" },
		]);
	});

	test("stops the Bridge lifecycle when TUI startup fails", async () => {
		let stopCalls = 0;
		const bridge: StudioBridgeLifecycle = {
			async start() {},
			async stop() {
				stopCalls++;
			},
		};

		await expect(
			runStudioHostMode(
				fakeSession(),
				{ runtimeEpoch: 1 },
				async () => {
					throw new Error("TUI failed");
				},
				{ createBridge: () => bridge },
			),
		).rejects.toThrow("TUI failed");
		expect(stopCalls).toBe(1);
	});

	test("fails closed when the default Bridge configuration is incomplete", async () => {
		await expect(runStudioHostMode(fakeSession(), {}, async () => {})).rejects.toThrow(
			"requires --bridge-endpoint, --bridge-token-file, and --bridge-runtime-epoch",
		);
	});

	test("creates one immutable runtime identity from the supplied session", () => {
		const session = fakeSession("session-one");
		const runtime = createStudioHostRuntime(session, { runtimeEpoch: 11 }, () => "runtime-one");

		expect(runtime).toEqual(
			expect.objectContaining({
				runtimeId: "runtime-one",
				runtimeEpoch: 11,
				sessionId: "session-one",
				session,
				sessionManager: session.sessionManager,
			}),
		);
	});
});
