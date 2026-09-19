import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { StudioBtwService, type StudioBtwSessionPort } from "@oh-my-pi/pi-coding-agent/studio/services/btw-service";
import {
	validateUpgradeOperation,
	validateUpgradeResult,
} from "@oh-my-pi/pi-coding-agent/studio/runtime-upgrade-protocol";
const roots: string[] = [];
afterEach(async () => {
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
		isStreaming: false,
		sessionManager: { getSessionId: () => "parent", getLeafId: () => "leaf", getArtifactsDir: () => root },
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
	test("a stale writer cannot overwrite another process's follow-up", async () => {
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
		await expect(stale.service.settle()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(stale.calls).toHaveLength(0);
		expect((await setup(root).service.historyRead(asked.ephemeralId)).turns.at(-1)?.question).toBe("owner next");
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
