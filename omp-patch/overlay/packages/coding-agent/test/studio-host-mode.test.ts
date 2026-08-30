import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	createStudioHostRuntime,
	runStudioHostMode,
	type StudioBridgeLifecycle,
	type StudioHostRuntime,
} from "@oh-my-pi/pi-coding-agent/studio/studio-host-mode";
import { TempDir } from "@oh-my-pi/pi-utils";

function fakeSession(
	sessionId = "session-test",
	options: { getSessionFile?: () => string | null; sessionChangeListeners?: Array<() => void> } = {},
): AgentSession {
	const sessionChangeListeners = options.sessionChangeListeners ?? [];
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getCwd: () => process.cwd(),
			getSessionFile: options.getSessionFile ?? (() => null),
		},
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
		registerSessionChangeCallback: (callback: () => void) => {
			sessionChangeListeners.push(callback);
			return () => {
				const index = sessionChangeListeners.indexOf(callback);
				if (index >= 0) sessionChangeListeners.splice(index, 1);
			};
		},
	} as unknown as AgentSession;
}

function statsSession(
	sessionId: string,
	stats: { tokens: number; requests: number; tools: number; cost: number },
): AgentSession {
	return {
		...fakeSession(sessionId),
		getSessionStats: () => ({
			tokens: { total: stats.tokens },
			assistantMessages: stats.requests,
			toolCalls: stats.tools,
			cost: stats.cost,
		}),
	} as unknown as AgentSession;
}

function silentBridge(): StudioBridgeLifecycle {
	return {
		async start() {},
		async stop() {},
	};
}

async function writeTranscript(filePath: string, sessionId: string, text: string): Promise<void> {
	const lines = [
		JSON.stringify({ type: "session", id: sessionId, timestamp: "2026-08-17T00:00:00.000Z", cwd: "/tmp" }),
		JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-08-17T00:00:01.000Z",
			message: { role: "user", content: text, timestamp: Date.parse("2026-08-17T00:00:01.000Z") },
		}),
	];
	await Bun.write(filePath, `${lines.join("\n")}\n`);
}

async function waitForListedAgent(runtime: StudioHostRuntime, agentId: string, includePersisted = true) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const row = runtime.services.agents.list({ includePersisted }).find(agent => agent.agentId === agentId);
		if (row) return row;
		await Bun.sleep(10);
	}
	throw new Error(`Agent "${agentId}" did not appear in the Studio roster`);
}

describe("studio-host runtime", () => {
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

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

	test("registers parked child transcripts before the Bridge handshake", async () => {
		using tempDir = TempDir.createSync("@omp-studio-persisted-subagents-");
		const parentFile = path.join(tempDir.path(), "parent.jsonl");
		const childFile = path.join(tempDir.path(), "parent", "ToolTestA.jsonl");
		await writeTranscript(parentFile, "parent-sess", "parent");
		await writeTranscript(childFile, "child-sess", "extract notes");
		const session = fakeSession("session-test", { getSessionFile: () => parentFile });
		await runStudioHostMode(
			session,
			{ endpoint: "omp-studio-test", tokenFile: "C:\\temp\\omp-studio.token", runtimeEpoch: 7 },
			async runtime => {
				const listed = runtime.services.agents.list({ includePersisted: true });
				const row = listed.find(agent => agent.agentId === "ToolTestA");
				expect(row?.status).toBe("parked");
				const page = await runtime.services.agentConversation.read({ agentId: "ToolTestA" });
				expect(page.sessionId).toBe("child-sess");
				expect(page.items.some(item => item.kind === "message")).toBe(true);
			},
			{ createBridge: silentBridge, createRuntimeId: () => "runtime-persisted" },
		);
	});

	test("keeps a tombstoned child readable as aborted", async () => {
		using tempDir = TempDir.createSync("@omp-studio-persisted-tombstone-");
		const parentFile = path.join(tempDir.path(), "parent.jsonl");
		const childFile = path.join(tempDir.path(), "parent", "ToolTestA.jsonl");
		await writeTranscript(parentFile, "parent-sess", "parent");
		await writeTranscript(childFile, "child-sess", "killed worker notes");
		await Bun.write(`${childFile}.tombstone`, "");
		const session = fakeSession("session-test", { getSessionFile: () => parentFile });
		await runStudioHostMode(
			session,
			{ endpoint: "omp-studio-test", tokenFile: "C:\\temp\\omp-studio.token", runtimeEpoch: 7 },
			async runtime => {
				const listed = runtime.services.agents.list({ includePersisted: true });
				const row = listed.find(agent => agent.agentId === "ToolTestA");
				expect(row?.status).toBe("aborted");
				const page = await runtime.services.agentConversation.read({ agentId: "ToolTestA" });
				expect(page.sessionId).toBe("child-sess");
				expect(page.items.some(item => item.kind === "message")).toBe(true);
			},
			{ createBridge: silentBridge, createRuntimeId: () => "runtime-tombstone" },
		);
	});

	test("rescans child transcripts after an in-process session change", async () => {
		using tempDir = TempDir.createSync("@omp-studio-persisted-switch-");
		const firstParent = path.join(tempDir.path(), "first.jsonl");
		const secondParent = path.join(tempDir.path(), "second.jsonl");
		await writeTranscript(firstParent, "first-sess", "first");
		await writeTranscript(path.join(tempDir.path(), "first", "ToolTestA.jsonl"), "child-a", "first child");
		await writeTranscript(secondParent, "second-sess", "second");
		await writeTranscript(path.join(tempDir.path(), "second", "ToolTestB.jsonl"), "child-b", "second child");
		let sessionFile = firstParent;
		const sessionChangeListeners: Array<() => void> = [];
		const session = fakeSession("session-test", {
			getSessionFile: () => sessionFile,
			sessionChangeListeners,
		});
		await runStudioHostMode(
			session,
			{ endpoint: "omp-studio-test", tokenFile: "C:\\temp\\omp-studio.token", runtimeEpoch: 7 },
			async runtime => {
				expect(
					runtime.services.agents.list({ includePersisted: true }).some(agent => agent.agentId === "ToolTestA"),
				).toBe(true);
				sessionFile = secondParent;
				for (const listener of sessionChangeListeners) listener();
				const row = await waitForListedAgent(runtime, "ToolTestB");
				expect(row.status).toBe("parked");
				const page = await runtime.services.agentConversation.read({ agentId: "ToolTestB" });
				expect(page.sessionId).toBe("child-b");
			},
			{ createBridge: silentBridge, createRuntimeId: () => "runtime-switch" },
		);
	});

	test("keeps the last measured usage of a parked agent as a frozen span", async () => {
		const registry = AgentRegistry.global();
		const createdAt = Date.now() - 600_000;
		const lastActivity = createdAt + 480_000;
		registry.register({
			id: "ToolTestA",
			displayName: "ToolTestA",
			kind: "sub",
			session: statsSession("child-sess", { tokens: 12_600, requests: 9, tools: 14, cost: 0.51 }),
			status: "running",
			createdAt,
			lastActivity,
		});
		const runtime = createStudioHostRuntime(fakeSession(), { runtimeEpoch: 1 }, () => "runtime-usage");
		const running = runtime.services.agents.list({}).find(agent => agent.agentId === "ToolTestA");
		expect(running?.usage).toMatchObject({
			tokens: 12_600,
			requests: 9,
			tools: 14,
			durationMs: 480_000,
			durationKind: "active",
		});

		// Parking disposes the session, so live stats vanish; the roster must still
		// report what the agent actually spent instead of dropping to `usage —`.
		// `setStatus` stamps `lastActivity`, so the span ends at park time and then
		// stops moving — the clock must not keep climbing on later reads.
		expect(registry.detachSession("ToolTestA")).toBe(true);
		expect(registry.setStatus("ToolTestA", "parked")).toBe(true);
		const parked = runtime.services.agents.list({}).find(agent => agent.agentId === "ToolTestA");
		expect(parked?.hasLiveSession).toBe(false);
		expect(parked?.usage).toMatchObject({
			tokens: 12_600,
			requests: 9,
			tools: 14,
			cost: 0.51,
			durationKind: "span",
		});
		expect(parked?.usage?.durationMs).toBeGreaterThanOrEqual(480_000);
		await Bun.sleep(25);
		const later = runtime.services.agents.list({}).find(agent => agent.agentId === "ToolTestA");
		expect(later?.usage?.durationMs).toBe(parked?.usage?.durationMs);
		expect(later?.updatedAt).toBe(parked?.updatedAt);
	});
});
