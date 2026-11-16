import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { StudioForkService } from "../src/studio/services/fork-service";
import { StudioTreeService } from "../src/studio/services/tree-service";
import { SessionControlService } from "../src/studio/services/session-control-service";
import { StudioRuntimeQueueService } from "../src/studio/services/runtime-queue-service";

function fixture() {
	let sessionId = "session-old";
	let streaming = true;
	const settled = Promise.withResolvers<void>();
	const events: string[] = [];
	const session = {
		get sessionId() {
			return sessionId;
		},
		get isStreaming() {
			return streaming;
		},
		isCompacting: false,
		getVibeModeState: () => undefined,
		async abort() {
			events.push("abort");
		},
		async waitForIdle() {
			events.push("wait");
			await settled.promise;
			streaming = false;
		},
		beginStudioQueueBarrier() {},
		releaseStudioQueueBarrier() {},
		clearQueue() {},
		async fork() {
			events.push("fork");
			sessionId = "session-new";
			return true;
		},
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as AgentSession;
	return { session, service: new StudioForkService(session), settled, events };
}

describe("Studio streaming fork", () => {
	test("waits for native settlement before side-channel settlement and fork, rejecting concurrent input", async () => {
		const { session, service, settled, events } = fixture();
		const control = new SessionControlService(session);
		const result = service.fork(async () => {
			events.push("side-channels");
		});
		await Promise.resolve();
		expect(events).toEqual(["abort", "wait"]);
		await expect(control.followUp("must stay in the composer")).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		settled.resolve();
		expect(await result).toEqual({ forked: true, sessionId: "session-new" });
		expect(events).toEqual(["abort", "wait", "side-channels", "fork"]);
	});

	test("operator cancellation while settling keeps the old identity and releases the transition gate", async () => {
		const { session, service, settled, events } = fixture();
		const control = new SessionControlService(session);
		const result = service.fork();
		await Promise.resolve();
		await control.abort();
		settled.resolve();
		await expect(result).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(session.sessionId).toBe("session-old");
		expect(events).not.toContain("fork");
		expect(await service.fork()).toEqual({ forked: true, sessionId: "session-new" });
	});

	test("does not interrupt compaction or vibe when the native transition is disallowed", async () => {
		const compacting = fixture();
		Object.defineProperty(compacting.session, "isCompacting", { value: true });
		await expect(compacting.service.fork()).rejects.toMatchObject({ code: "BUSY_COMPACTING" });
		expect(compacting.events).toEqual([]);
		const vibe = fixture();
		vibe.session.getVibeModeState = () => ({ enabled: true }) as never;
		await expect(vibe.service.fork()).rejects.toMatchObject({ code: "MODE_CONFLICT" });
		expect(vibe.events).toEqual([]);
	});
});

async function nativeFixture(persist: boolean) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-streaming-fork-"));
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	auth.keys.setRuntime("anthropic", "test-only");
	const mock = createMockModel({
		responses: [{ content: ["interrupted"], delayMs: 1000 }, { content: ["finished"] }],
	});
	const agent = new Agent({
		getApiKey: () => "test-only",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: [], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const manager = persist
		? SessionManager.create(directory, path.join(directory, "sessions"))
		: SessionManager.inMemory(directory);
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
	});
	return {
		session,
		mock,
		queue: new StudioRuntimeQueueService(session),
		async close() {
			await session.dispose();
			await manager.close();
			auth.close();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

for (const kind of ["fork", "branch"] as const) {
	test(`a real native streaming ${kind} never delivers old or late queued input to its new identity`, async () => {
		const fixture = await nativeFixture(true);
		const { session, mock, queue } = fixture;
		const sideChannels = Promise.withResolvers<void>();
		const proceed = Promise.withResolvers<void>();
		try {
			const original = session.sessionId;
			const prompt = session.prompt("start");
			while (!mock.calls.length) await Bun.sleep(5);
			await session.followUp("source session input only");
			const queuedId = queue.get().entries[0]!.id;
			const beforeTransition = async () => {
				sideChannels.resolve();
				await proceed.promise;
			};
			const entry = session.sessionManager
				.getEntries()
				.find(row => row.type === "message" && row.message.role === "user")!;
			const changing =
				kind === "fork"
					? new StudioForkService(session).fork(beforeTransition)
					: new StudioTreeService(session).branch("branch", { targetId: entry.id }, beforeTransition);
			await sideChannels.promise;
			await session.followUp("late source input only");
			await expect(new SessionControlService(session).prompt("concurrent input")).rejects.toMatchObject({
				code: "COMMAND_BLOCKED",
			});
			proceed.resolve();
			const changed = (await changing) as { sessionId: string };
			await prompt;
			await session.waitForIdle();
			expect(changed.sessionId).not.toBe(original);
			expect(mock.calls).toHaveLength(1);
			expect(queue.get().entries).toEqual([]);
			expect(() =>
				queue.execute({ kind: "session.queue.restore", sessionId: original, id: queuedId, queue: "followUp" }),
			).toThrow("another session");
			await session.prompt("new session input");
			await session.waitForIdle();
			const delivered = JSON.stringify(mock.calls[1]!.context.messages);
			expect(delivered).not.toContain("source session input only");
			expect(delivered).not.toContain("late source input only");
		} finally {
			proceed.resolve();
			await fixture.close();
		}
	});
}

test("a refused native fork keeps held input recoverable on the original session", async () => {
	const fixture = await nativeFixture(false);
	const { session, mock, queue } = fixture;
	try {
		const original = session.sessionId;
		const prompt = session.prompt("start");
		while (!mock.calls.length) await Bun.sleep(5);
		await session.followUp("recover this input");
		const queuedId = queue.get().entries[0]!.id;
		await expect(new StudioForkService(session).fork()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		await prompt;
		expect(session.sessionId).toBe(original);
		expect(queue.get().entries).toMatchObject([{ id: queuedId, state: "held" }]);
		expect(mock.calls).toHaveLength(1);
		queue.execute({ kind: "session.queue.restore", sessionId: original, id: queuedId, queue: "followUp" });
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("recover this input");
	} finally {
		await fixture.close();
	}
});
