import { afterEach, expect, spyOn, test, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { tagImageAttachmentSource } from "@oh-my-pi/pi-tui/prompt/image-source";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentSession } from "../src/session/agent-session";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { StudioQueuedCompactionService } from "../src/studio/services/queued-compaction-service";
import { StudioRuntimeQueueService } from "../src/studio/services/runtime-queue-service";
import { StudioBtwService, type StudioBtwSessionPort } from "../src/studio/services/btw-service";
import { sendStudioBtwInjection } from "../src/studio/services/btw-injection";
import { StudioLiveAudioService } from "../src/studio/services/live-audio-service";
import { StudioLiveService } from "../src/studio/services/live-service";
import { StudioRuntimeCommandArbiter } from "../src/studio/command-arbiter";
import { StudioInteractionGateway, StudioRemoteInteractionPort } from "../src/studio/services/interaction-port";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

afterEach(() => mock.restore());

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Runtime state did not settle");
		await Bun.sleep(5);
	}
}

async function sessionFixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-18180-"));
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("anthropic", "test-only");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
	const provider = createMockModel({ id: model.id, provider: model.provider, handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		initialState: { model, systemPrompt: [], tools: [] },
		convertToLlm,
		getApiKey: () => "test-only",
		streamFn: provider.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(directory, path.join(directory, "sessions")),
		settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false, "todo.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
	});
	const compaction = new StudioQueuedCompactionService(session);
	const queue = new StudioRuntimeQueueService(session, compaction);
	return {
		session,
		provider,
		agent,
		compaction,
		queue,
		async dispose() {
			compaction.dispose();
			await session.dispose();
			auth.close();
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

test("queued compaction runs after yield and before later input, keeping image companions exactly once", async () => {
	const f = await sessionFixture();
	const yielded = Promise.withResolvers<void>(),
		finishTurn = Promise.withResolvers<void>(),
		compacting = Promise.withResolvers<void>(),
		finishCompaction = Promise.withResolvers<void>();
	let first = true;
	f.agent.setOnBeforeYield(async () => {
		if (first) {
			first = false;
			yielded.resolve();
			await finishTurn.promise;
		}
	});
	spyOn(f.session, "compact").mockImplementation(async () => {
		compacting.resolve();
		await finishCompaction.promise;
		return { summary: "kept", firstKeptEntryId: f.session.sessionManager.getLeafId()!, tokensBefore: 10 };
	});
	try {
		const running = f.session.prompt("before compaction");
		await yielded.promise;
		f.compaction.enqueue();
		const image = tagImageAttachmentSource(
			{
				type: "image",
				mimeType: "image/png",
				data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			},
			"/private/queued.png",
			"image",
		);
		await f.session.prompt("after compaction", { streamingBehavior: "followUp", images: [image] });
		const queued = f.queue.get();
		expect(queued.entries.map(entry => entry.kind ?? entry.heldFor)).toEqual(["compaction", "compaction"]);
		expect(queued.entries[1]).toMatchObject({ text: "after compaction", imageCount: 1, state: "held" });
		finishTurn.resolve();
		await running;
		await compacting.promise;
		expect(f.provider.calls).toHaveLength(1);
		finishCompaction.resolve();
		await f.compaction.wait();
		await waitFor(() => f.provider.calls.length === 2 && !f.session.isStreaming);
		const messages = f.provider.calls[1]!.context.messages;
		expect(
			messages
				.flatMap(message => (typeof message.content === "string" ? [] : message.content))
				.filter(part => part.type === "image"),
		).toHaveLength(1);
		expect(JSON.stringify(messages)).toContain("/private/queued.png");
		expect(f.queue.get().entries).toEqual([]);
	} finally {
		finishTurn.resolve();
		finishCompaction.resolve();
		await f.dispose();
	}
});

test("aborting queued compaction retains later input across a session switch until explicit restore", async () => {
	const f = await sessionFixture();
	const yielded = Promise.withResolvers<void>(),
		finishTurn = Promise.withResolvers<void>();
	let first = true;
	f.agent.setOnBeforeYield(async () => {
		if (first) {
			first = false;
			yielded.resolve();
			await finishTurn.promise;
		}
	});
	const compact = spyOn(f.session, "compact");
	try {
		const running = f.session.prompt("original");
		await yielded.promise;
		const originalId = f.session.sessionId,
			file = f.session.sessionManager.getSessionFile()!;
		f.compaction.enqueue();
		await f.session.prompt("recover me", { streamingBehavior: "followUp" });
		const aborting = f.session.abort();
		finishTurn.resolve();
		await Promise.all([running, aborting]);
		await f.compaction.wait();
		expect(compact).not.toHaveBeenCalled();
		const held = f.queue.get().entries[0]!;
		expect(held).toMatchObject({ text: "recover me", state: "held" });
		expect(held.heldFor).toBeUndefined();
		await f.session.newSession();
		expect(f.queue.get().entries).toEqual([]);
		await f.session.switchSession(file);
		expect(f.session.sessionId).toBe(originalId);
		expect(f.queue.get().entries[0]?.id).toBe(held.id);
		expect(f.provider.calls).toHaveLength(1);
		f.queue.execute({ kind: "session.queue.restore", sessionId: originalId, id: held.id, queue: "followUp" });
		await waitFor(() => f.provider.calls.length === 2 && !f.session.isStreaming);
		expect(JSON.stringify(f.provider.calls[1]!.context.messages)).toContain("recover me");
	} finally {
		finishTurn.resolve();
		await f.dispose();
	}
});

test("BTW injection retries a failed admission and concurrent clicks never send twice", async () => {
	const sent = Promise.withResolvers<void>();
	let sends = 0;
	const session: StudioBtwSessionPort = {
		model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
		isStreaming: false,
		sessionManager: { getSessionId: () => "one", getLeafId: () => null, ensureOnDisk: async () => {} },
		runEphemeralTurn: async () => ({
			replyText: "Context <inject>Use the native worker bridge.</inject> Ready.",
			assistantMessage: createAssistantMessage("Context <inject>Use the native worker bridge.</inject> Ready."),
		}),
		branchFromBtw: async () => ({ cancelled: true }),
	};
	const service = new StudioBtwService(session, {
		injectEnabled: () => true,
		sendInjection: async text => {
			expect(text).toContain("native worker bridge");
			sends++;
			if (sends === 1) throw new Error("admission failed");
			await sent.promise;
		},
	});
	try {
		const ask = service.ask("What should the main agent do?");
		await waitFor(() => service.get(ask.ephemeralId).status === "completed");
		await service.flush();
		const id = service.get(ask.ephemeralId).injection!.id;
		await expect(service.inject(id)).rejects.toThrow("admission failed");
		expect(service.get(ask.ephemeralId).injection?.state).toBe("ready");
		const first = service.inject(id),
			second = service.inject(id);
		await waitFor(() => sends === 2);
		sent.resolve();
		await Promise.all([first, second]);
		await service.inject(id);
		expect(sends).toBe(2);
		expect(service.get(ask.ephemeralId).injection?.state).toBe("sent");
	} finally {
		sent.resolve();
		service.dispose();
	}
});

test("BTW send completes on admission, so a later provider failure cannot trigger duplicate injection", async () => {
	const turn = Promise.withResolvers<boolean>();
	let calls = 0;
	const session = {
		sessionManager: { getSessionId: () => "one" },
		prompt: (_text: string, options: Parameters<AgentSession["prompt"]>[1]) => {
			calls++;
			options?.onPromptAdmitted?.();
			return turn.promise;
		},
	} as unknown as AgentSession;
	await sendStudioBtwInjection(session, "/literal text", "one");
	turn.reject(new Error("provider failed after admission"));
	await Bun.sleep(0);
	const admission = spyOn(session, "prompt").mockRejectedValue(new Error("dropped before admission"));
	await expect(sendStudioBtwInjection(session, "retryable", "one")).rejects.toThrow("dropped before admission");
	admission.mockRestore();
	expect(calls).toBe(1);
});

test("simultaneous dialogs wait in order and cancelling one agent leaves the others answerable", async () => {
	const port = new StudioRemoteInteractionPort(
		new StudioRuntimeCommandArbiter(
			() => ({ runtimeEpoch: 1, stateVersion: 0, isStreaming: false, isCompacting: false }),
			[],
		),
		() => {},
		() => {},
	);
	const gateway = new StudioInteractionGateway();
	gateway.bind(port);
	const first = gateway.confirm({ commandId: "studio-tool:one", title: "one", message: "one" });
	const cancelled = gateway
		.confirm({ commandId: "studio-tool:two", title: "two", message: "two" })
		.catch(error => error.message);
	const third = gateway.confirm({ commandId: "studio-tool:three", title: "three", message: "three" });
	gateway.cancelCommand("studio-tool:two", "agent cancelled");
	expect(await cancelled).toBe("agent cancelled");
	for (const commandId of ["studio-tool:one", "studio-tool:three"]) {
		const pending = port.pending()!;
		expect(pending.request.commandId).toBe(commandId);
		port.respond({
			kind: "interaction.respond",
			commandId,
			interactionId: pending.request.interactionId,
			decision: "submit",
			value: true,
		});
	}
	expect(await Promise.all([first, third])).toEqual([true, true]);
	expect(port.pending()).toBeUndefined();
});

test("WebRTC uses browser audio, renews only its owner's lease, and stops after owner disconnect", async () => {
	const stopped = Promise.withResolvers<void>();
	let stops = 0;
	const session = { sessionId: "one" } as AgentSession;
	const audio = new StudioLiveAudioService(session, {
		webRtcOwnerTimeoutMs: 80,
		createController: options => {
			expect(options.createAudioInput).toBeUndefined();
			expect(options.sdpOffer).toBe("test-offer");
			let muted = false,
				done = false;
			return {
				sdpAnswer: "test-answer",
				get muted() {
					return muted;
				},
				start: async () => {
					options.callbacks.onPhase("listening");
				},
				stop: async () => {
					if (done) return;
					done = true;
					stops++;
					options.callbacks.onTerminal();
					stopped.resolve();
				},
				toggleMute: () => {
					muted = !muted;
					options.callbacks.onPhase(muted ? "muted" : "listening");
				},
			};
		},
	});
	audio.bindControl(new StudioLiveService(audio.factory));
	try {
		const result = await audio.connectWebRtc({
			sessionId: "one",
			audioId: "11111111-1111-4111-8111-111111111111",
			sdpOffer: "test-offer",
		});
		expect(result.sdpAnswer).toBe("test-answer");
		for (let i = 0; i < 5; i++) {
			await Bun.sleep(25);
			await audio.webRtcStatus("one", result.audioId);
		}
		expect(stops).toBe(0);
		expect(
			(await audio.execute({ kind: "live.audio.mute", sessionId: "one", audioId: result.audioId, muted: true }))
				.muted,
		).toBe(true);
		await audio.webRtcStatus("one", "another-window");
		await stopped.promise;
		expect((await audio.webRtcStatus("one")).phase).toBe("off");
		expect(stops).toBe(1);
	} finally {
		audio.dispose();
	}
});

test("cancelling pending WebRTC negotiation releases the call before its SDP answer arrives", async () => {
	const starting = Promise.withResolvers<void>(),
		answer = Promise.withResolvers<void>();
	let stops = 0;
	const audio = new StudioLiveAudioService({ sessionId: "one" } as AgentSession, {
		createController: options => ({
			sdpAnswer: "late-answer",
			muted: false,
			start: async () => {
				starting.resolve();
				await answer.promise;
			},
			stop: async () => {
				stops++;
				answer.resolve();
				options.callbacks.onTerminal();
			},
			toggleMute: () => {},
		}),
	});
	audio.bindControl(new StudioLiveService(audio.factory));
	try {
		const pending = audio
			.connectWebRtc({ sessionId: "one", audioId: "22222222-2222-4222-8222-222222222222", sdpOffer: "offer" })
			.catch(error => error);
		await starting.promise;
		await audio.execute({
			kind: "live.audio.release",
			sessionId: "one",
			audioId: "22222222-2222-4222-8222-222222222222",
		});
		expect(await pending).toMatchObject({ code: "COMMAND_BLOCKED" });
		expect((await audio.webRtcStatus("one")).attached).toBe(false);
		expect(stops).toBeGreaterThan(0);
	} finally {
		answer.resolve();
		audio.dispose();
	}
});
