import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { StudioBtwService, type StudioBtwSessionPort } from "@oh-my-pi/pi-coding-agent/studio/services/btw-service";
import { BtwHistoryStore } from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StudioUpgradeService } from "@oh-my-pi/pi-coding-agent/studio/services/upgrade-service";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	validateUpgradeOperation,
	validateUpgradeResult,
} from "@oh-my-pi/pi-coding-agent/studio/runtime-upgrade-protocol";
const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function directory() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-btw-1825-"));
	roots.push(root);
	return root;
}
function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function setup(root: string) {
	const calls: Array<Parameters<StudioBtwSessionPort["runEphemeralTurn"]>[0]> = [];
	const port: StudioBtwSessionPort = {
		model: { api: "openai-responses", provider: "openai", id: "test" } as NonNullable<StudioBtwSessionPort["model"]>,
		isStreaming: false,
		sessionManager: {
			ensureOnDisk: async () => {},
			getSessionId: () => "parent",
			getLeafId: () => "leaf",
			getArtifactsDir: () => root,
		},
		runEphemeralTurn: async args => {
			calls.push(args);
			args.onTextDelta?.("answer");
			return { replyText: "answer " + calls.length, assistantMessage: answer("answer " + calls.length) };
		},
		branchFromBtw: async () => ({ cancelled: false }),
	};
	return { service: new StudioBtwService(port), port, calls };
}
function terminal(service: StudioBtwService): Promise<void> {
	const done = Promise.withResolvers<void>();
	const unsubscribe = service.onChange(snapshot => {
		if (snapshot.status !== "running") {
			unsubscribe();
			done.resolve();
		}
	});
	return done.promise;
}
describe("Studio 18.2 BTW history contract", () => {
	test("pasted quoted image paths load the same bytes without asking a model", async () => {
		const root = await directory();
		const file = path.join(root, "screen shot.png");
		const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
		await fs.writeFile(file, Buffer.from(data, "base64"));
		const { service: btw, calls } = setup(root);
		const service = new StudioUpgradeService({ sessionManager: { getCwd: () => root } } as AgentSession, btw);
		expect(await service.execute({ kind: "btw.images.resolve", text: '"' + file + '"' })).toMatchObject({
			images: [{ type: "image", mimeType: "image/png", data }],
		});
		expect(await service.execute({ kind: "btw.images.resolve", text: "ordinary paste" })).toEqual({ images: [] });
		expect(calls).toHaveLength(0);
	});
	for (const status of ["cancelled", "error", "interrupted"] as const) {
		test(`continues a ${status} topic with its images and a fresh native request lineage`, async () => {
			const root = await directory();
			const image = { type: "image" as const, mimeType: "image/png", data: "aW1hZ2U=" };
			const store = await BtwHistoryStore.open(root);
			const turn = {
				question: "look at this image",
				images: [image],
				answer: "partial",
				status,
				createdAt: 1,
				updatedAt: 2,
			};
			await store.upsert({
				...turn,
				id: "history-topic",
				leafId: "leaf",
				followUps: Array.from({ length: 33 }, () => ({ ...turn })),
			});
			const { service, calls } = setup(root);
			const completed = terminal(service);
			await service.followUp("history-topic", "continue", [image]);
			await completed;
			await service.settle();
			expect(calls[0]?.conversationKey).toBe("btw:history-topic:34");
			expect(calls[0]?.history?.[0]?.content).toContainEqual(image);
			expect(calls[0]?.promptImages).toEqual([image]);
			const history = await service.historyRead("history-topic");
			expect(history.turns).toHaveLength(35);
			expect(history.turns.at(-1)?.images).toEqual([image]);
		});
	}
	test("completed topics survive reopen, follow-ups carry separate roles, and multiround branches are blocked", async () => {
		const root = await directory(),
			first = setup(root);
		const done = terminal(first.service);
		const asked = first.service.ask("first");
		await done;
		await first.service.settle();
		const second = setup(root);
		const list = await second.service.historyList();
		expect(list.topics).toHaveLength(1);
		expect(list.topics[0]?.topicId).toBe(asked.ephemeralId);
		const completed = terminal(second.service);
		const follow = await second.service.followUp(asked.ephemeralId, "next");
		await completed;
		await second.service.settle();
		expect(second.calls[0]?.history?.map(message => message.role)).toEqual(["user", "assistant"]);
		const history = await second.service.historyRead(asked.ephemeralId);
		expect(history.turns.map(turn => turn.question)).toEqual(["first", "next"]);
		expect(JSON.stringify(history)).not.toContain("branchToken");
		await expect(second.service.branch(follow.ephemeralId, "invalid")).rejects.toBeDefined();
		const reopened = setup(root);
		expect((await reopened.service.historyRead(asked.ephemeralId)).turns).toHaveLength(2);
	});
	test("cancellation during startup persists an aborted topic without starting a model", async () => {
		const { service, calls } = setup(await directory());
		const asked = service.ask("cancel immediately");
		service.abort(asked.ephemeralId);
		await service.settle();
		expect(calls).toHaveLength(0);
		expect((await service.historyRead(asked.ephemeralId)).turns[0]?.status).toBe("cancelled");
	});
	test("refreshes external follow-ups before appending, preserving the other process's answer", async () => {
		const root = await directory(),
			owner = setup(root);
		const done = terminal(owner.service);
		const asked = owner.service.ask("first");
		await done;
		await owner.service.settle();
		const stale = setup(root);
		await stale.service.historyList();
		const next = terminal(owner.service);
		await owner.service.followUp(asked.ephemeralId, "owner next");
		await next;
		await owner.service.settle();
		const rejected = terminal(stale.service);
		await stale.service.followUp(asked.ephemeralId, "stale next");
		await rejected;
		await stale.service.settle();
		expect(stale.calls).toHaveLength(1);
		expect((await setup(root).service.historyRead(asked.ephemeralId)).turns.map(turn => turn.question)).toEqual([
			"first",
			"owner next",
			"stale next",
		]);
	});
	test("materializes a fresh session before asking and preserves questions longer than 64K", async () => {
		const root = await directory();
		const manager = SessionManager.create(root, root);
		const { port } = setup(root);
		const service = new StudioBtwService({ ...port, sessionManager: manager });
		try {
			const done = terminal(service);
			const question = "q".repeat(70000);
			const asked = service.ask(question);
			await done;
			await service.settle();
			expect(manager.isSessionOnDisk()).toBe(true);
			expect((await service.historyRead(asked.ephemeralId)).turns[0]?.question).toBe(question);
		} finally {
			service.dispose();
			await manager.close();
		}
	});
	test("refreshes new external topics without restarting the service", async () => {
		const root = await directory(),
			{ service } = setup(root);
		expect((await service.historyList()).topics).toHaveLength(0);
		const external = await BtwHistoryStore.open(root);
		await external.upsert({
			id: "external",
			question: "native topic",
			answer: "native answer",
			status: "complete",
			leafId: null,
			createdAt: 1,
			updatedAt: 2,
		});
		expect((await service.historyList()).topics.map(topic => topic.topicId)).toEqual(["external"]);
		expect((await service.historyRead("external")).turns[0]?.answer).toBe("native answer");
	});
	test("simultaneous history refreshes cannot split the next answer across stale stores", async () => {
		const { service } = setup(await directory());
		await service.historyList();
		const open = BtwHistoryStore.open.bind(BtwHistoryStore);
		let opens = 0;
		vi.spyOn(BtwHistoryStore, "open").mockImplementation(async (...args) => {
			const first = opens++ === 0;
			const store = await open(...args);
			if (first) await Bun.sleep(30);
			return store;
		});
		await Promise.all([service.historyList(), service.historyList()]);
		const done = terminal(service);
		const asked = service.ask("after concurrent refresh");
		await done;
		await service.settle();
		expect((await service.historyRead(asked.ephemeralId)).turns[0]?.status).toBe("complete");
	});
	test("failed history startup blocks session transitions and recovers after storage is repaired", async () => {
		const root = await directory(),
			bad = path.join(root, "blocked");
		await fs.writeFile(bad, "not a directory");
		const { service, calls } = setup(bad);
		const done = terminal(service);
		const asked = service.ask("retain me");
		await done;
		await expect(service.settle()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(calls).toHaveLength(0);
		await fs.unlink(bad);
		await fs.mkdir(bad);
		await service.settle();
		expect((await service.historyRead(asked.ephemeralId)).turns[0]?.question).toBe("retain me");
	});
});
test("upgrade wire rejects unknown authentication providers and credential-shaped result fields", () => {
	expect(() =>
		validateUpgradeOperation({ kind: "runtime.auth.set", provider: "unknown", apiKey: "secret" }),
	).toThrow();
	expect(() =>
		validateUpgradeResult("runtime.auth.get", { provider: "typesafe", configured: true, apiKey: "secret" }),
	).toThrow();
	expect(() =>
		validateUpgradeOperation({
			kind: "session.import.execute",
			source: "codex",
			sourceId: "id",
			fallbackCwd: "bad\0path",
		}),
	).toThrow();
});
