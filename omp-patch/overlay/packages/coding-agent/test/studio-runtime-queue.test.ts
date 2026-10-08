import { expect, test } from "bun:test";
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
import { AuthStorage } from "../src/session/auth-storage";
import { SessionControlService } from "../src/studio/services/session-control-service";
import { convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";
import { StudioRuntimeQueueService } from "../src/studio/services/runtime-queue-service";
import { validateRuntimeQueueResult, type RuntimeQueueResult } from "../src/studio/runtime-queue-protocol";

test("identity-based edits and promotion retain the exact duplicate's image companions without replay", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-queue-"));
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	auth.keys.setRuntime("anthropic", "test-only");
	const mock = createMockModel({ responses: [{ content: ["first"] }, { content: ["next"] }] });
	const agent = new Agent({
		getApiKey: () => "test-only",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: [], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
	});
	const service = new StudioRuntimeQueueService(session);
	const image = tagImageAttachmentSource(
		{
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		},
		"/private/second.png",
		"image",
	);
	let before: RuntimeQueueResult | undefined;
	let after: RuntimeQueueResult | undefined;
	let once = false;
	let staleRejected = false;
	agent.setOnBeforeYield(async () => {
		if (once) return;
		once = true;
		await session.followUp("duplicate");
		await session.followUp("duplicate", [image]);
		before = service.get();
		const [first, second] = before.entries;
		service.execute({
			kind: "session.queue.entry.remove",
			sessionId: session.sessionId,
			id: first!.id,
			queue: "followUp",
		});
		try {
			service.execute({
				kind: "session.queue.edit",
				sessionId: session.sessionId,
				id: second!.id,
				queue: "followUp",
				expectedText: "stale",
				text: "incorrect",
			});
		} catch {
			staleRejected = true;
		}
		service.execute({
			kind: "session.queue.edit",
			sessionId: session.sessionId,
			id: second!.id,
			queue: "followUp",
			expectedText: second!.text,
			text: "edited",
		});
		after = service.execute({
			kind: "session.queue.promote",
			sessionId: session.sessionId,
			id: second!.id,
			queue: "followUp",
		});
	});
	try {
		await session.prompt("start");
		await session.waitForIdle();
		expect(before?.entries).toHaveLength(2);
		expect(before?.entries[0]?.id).not.toBe(before?.entries[1]?.id);
		expect(staleRejected).toBe(true);
		expect(after?.entries).toHaveLength(1);
		expect(after?.entries[0]).toMatchObject({
			id: before!.entries[1]!.id,
			text: "edited",
			queue: "steering",
			imageCount: 1,
		});
		validateRuntimeQueueResult("session.queue.get", after);
		const wire = JSON.stringify(after);
		expect(wire).not.toContain(image.data);
		expect(wire).not.toContain("/private/");
		expect(mock.calls).toHaveLength(2);
		const delivered = JSON.stringify(mock.calls[1]!.context.messages);
		expect(delivered).toContain("edited");
		expect(delivered).toContain("/private/second.png");
		expect(
			mock.calls[1]!.context.messages.filter(message => message.role === "user")
				.flatMap(message => (typeof message.content === "string" ? [] : message.content))
				.filter(part => part.type === "image"),
		).toHaveLength(1);
		expect(delivered).not.toContain("duplicate");
		expect(service.get().entries).toEqual([]);
		expect(() =>
			service.execute({
				kind: "session.queue.entry.remove",
				sessionId: session.sessionId,
				id: before!.entries[1]!.id,
				queue: "steering",
			}),
		).toThrow("no longer queued");
		expect(() => service.execute({ kind: "session.queue.get", sessionId: "other" })).toThrow("another session");
	} finally {
		await session.dispose();
		auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});

test("operator abort holds image groups and never redispatches until explicit restoration", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-queue-stop-"));
	const auth = await AuthStorage.create(path.join(directory, "auth.db"));
	auth.keys.setRuntime("anthropic", "test-only");
	const mock = createMockModel({
		responses: [{ content: ["interrupted"], delayMs: 1000 }, { content: ["restored"] }],
	});
	const agent = new Agent({
		getApiKey: () => "test-only",
		initialState: { model: getBundledModel("anthropic", "claude-sonnet-4-5")!, systemPrompt: [], tools: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(directory, "models.yml")),
	});
	const service = new StudioRuntimeQueueService(session);
	const control = new SessionControlService(session);
	const image = tagImageAttachmentSource(
		{
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
		},
		"/private/preserved.png",
		"image",
	);
	try {
		const prompt = session.prompt("start");
		while (!mock.calls.length) await Bun.sleep(5);
		await session.followUp("preserve screenshot", [image]);
		const id = service.get().entries[0]!.id;
		await control.abort();
		await prompt;
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(1);
		expect(agent.hasQueuedMessages()).toBe(false);
		const held = service.get();
		expect(held.entries).toHaveLength(1);
		expect(held.entries[0]).toMatchObject({ id, state: "held", imageCount: 1 });
		service.execute({
			kind: "session.queue.edit",
			sessionId: session.sessionId,
			id,
			queue: "followUp",
			expectedText: held.entries[0]!.text,
			text: "restore screenshot",
		});
		service.execute({ kind: "session.queue.restore", sessionId: session.sessionId, id, queue: "followUp" });
		await session.waitForIdle();
		expect(mock.calls).toHaveLength(2);
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("/private/preserved.png");
		expect(JSON.stringify(mock.calls[1]!.context.messages)).toContain("restore screenshot");
		expect(service.get().entries).toEqual([]);
	} finally {
		await session.dispose();
		auth.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
});
