import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { StudioBtwService, type StudioBtwSessionPort } from "@oh-my-pi/pi-coding-agent/studio/services/btw-service";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as AssistantMessage;
}

function fixture() {
	let sessionId = "session-1";
	let leafId: string | null = "leaf-1";
	let runArgs: Parameters<StudioBtwSessionPort["runEphemeralTurn"]>[0] | undefined;
	const run = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
	const branchCalls: unknown[][] = [];
	const session: StudioBtwSessionPort = {
		isStreaming: false,
		sessionManager: { getSessionId: () => sessionId, getLeafId: () => leafId },
		runEphemeralTurn: args => {
			runArgs = args;
			return run.promise;
		},
		branchFromBtw: async (...args) => {
			branchCalls.push(args);
			sessionId = "session-2";
			leafId = "leaf-2";
			return { cancelled: false };
		},
	};
	const service = new StudioBtwService(session, {
		idGenerator: () => "ephemeral-1",
		tokenGenerator: () => "opaque-branch-token",
	});
	return { service, session, run, branchCalls, runArgs: () => runArgs, setLeaf: (value: string) => (leafId = value) };
}

describe("WP-041 StudioBtwService", () => {
	test("streams path-free state, completes, copies, and branches once", async () => {
		const { service, run, runArgs, branchCalls } = fixture();
		const started = service.ask("Why did this fail?");
		expect(started).toEqual({ ephemeralId: "ephemeral-1", branchToken: "opaque-branch-token", status: "running" });
		runArgs()?.onTextDelta?.("partial ");
		expect(service.get(started.ephemeralId)).toEqual({
			ephemeralId: "ephemeral-1",
			status: "running",
			text: "partial ",
		});
		run.resolve({ replyText: "final answer", assistantMessage: assistant("provider answer") });
		await Bun.sleep(0);
		expect(service.get(started.ephemeralId)).toEqual({
			ephemeralId: "ephemeral-1",
			status: "completed",
			text: "final answer",
			copy: "final answer",
		});
		await expect(service.branch(started.ephemeralId, started.branchToken)).resolves.toEqual({
			branched: true,
			newSessionId: "session-2",
			newLeafId: "leaf-2",
		});
		expect(branchCalls).toHaveLength(1);
		expect(JSON.stringify(service.get(started.ephemeralId))).not.toContain("opaque-branch-token");
		await expect(service.branch(started.ephemeralId, started.branchToken)).rejects.toMatchObject({
			code: "INTERACTION_STALE",
		});
	});

	test("wrong token, changed session, overlap, abort, failure, and output limits fail closed", async () => {
		const { service, run, runArgs } = fixture();
		const started = service.ask("question");
		expect(() => service.ask("overlap")).toThrow("already running");
		await expect(service.branch(started.ephemeralId, "wrong")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
		service.abort(started.ephemeralId);
		expect(runArgs()?.signal?.aborted).toBe(true);
		expect(service.get(started.ephemeralId).status).toBe("aborted");
		run.reject(new Error("C:/secret/session.jsonl"));
		await Bun.sleep(0);
		expect(JSON.stringify(service.get(started.ephemeralId))).not.toContain("secret");

		const second = fixture();
		const secondStarted = second.service.ask("question");
		second.run.resolve({ replyText: "answer", assistantMessage: assistant("answer") });
		await Bun.sleep(0);
		second.setLeaf("changed");
		await expect(second.service.branch(secondStarted.ephemeralId, secondStarted.branchToken)).rejects.toMatchObject({
			code: "INTERACTION_STALE",
		});

		const limited = fixture();
		const limitedService = new StudioBtwService(limited.session, {
			idGenerator: () => "limited",
			tokenGenerator: () => "token",
			maxTextBytes: 3,
		});
		const limitedStarted = limitedService.ask("question");
		limited.runArgs()?.onTextDelta?.("four");
		expect(limitedService.get(limitedStarted.ephemeralId)).toMatchObject({
			status: "failed",
			error: { code: "OUTPUT_LIMIT" },
		});
	});

	test("branch cancellation or failure restores the token so a retry is not stale", async () => {
		const cancelled = fixture();
		cancelled.session.branchFromBtw = async () => ({ cancelled: true });
		const cancelledStarted = cancelled.service.ask("question");
		cancelled.run.resolve({ replyText: "answer", assistantMessage: assistant("answer") });
		await Bun.sleep(0);
		await expect(
			cancelled.service.branch(cancelledStarted.ephemeralId, cancelledStarted.branchToken),
		).resolves.toEqual({
			branched: false,
			reason: "cancelled",
		});
		await expect(
			cancelled.service.branch(cancelledStarted.ephemeralId, cancelledStarted.branchToken),
		).resolves.toEqual({
			branched: false,
			reason: "cancelled",
		});

		const failing = fixture();
		let attempts = 0;
		failing.session.branchFromBtw = async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("disk full");
			return { cancelled: false };
		};
		const failingStarted = failing.service.ask("question");
		failing.run.resolve({ replyText: "answer", assistantMessage: assistant("answer") });
		await Bun.sleep(0);
		await expect(
			failing.service.branch(failingStarted.ephemeralId, failingStarted.branchToken),
		).rejects.toMatchObject({
			code: "COMMAND_BLOCKED",
		});
		await expect(failing.service.branch(failingStarted.ephemeralId, failingStarted.branchToken)).resolves.toEqual({
			branched: true,
			newSessionId: "session-1",
			newLeafId: "leaf-1",
		});
		expect(attempts).toBe(2);
	});
});
