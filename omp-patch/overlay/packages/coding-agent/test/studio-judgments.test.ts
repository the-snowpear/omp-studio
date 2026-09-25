import { afterEach, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { getJudgmentBatch, releaseJudgmentBatches, runEvalJudgmentBatch } from "../src/eval/judgment-batch-bridge";
import type { AgentSession } from "../src/session/agent-session";
import type { ToolSession } from "../src/tools";
import { StudioJudgmentService } from "../src/studio/services/judgment-service";
import type { JudgmentBatchPage, JudgmentBatchRow, JudgmentBatchSpec } from "../src/studio/judgments-protocol";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const model = {
	id: "judge",
	name: "Judge",
	api: "openai-responses",
	provider: "mock",
	baseUrl: "https://example.test",
	reasoning: false,
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 1 },
	contextWindow: 128000,
	maxTokens: 4096,
} as Model<Api>;
const spec: JudgmentBatchSpec = {
	intent: "Check descriptions",
	items: [
		{ key: "ok", state: "PASS" },
		{ key: "fail", state: "FAIL" },
	],
	questions: { clear: { type: "bool", instructions: "Is it clear?" } },
	concurrency: 1,
	retries: 0,
	minOk: 1,
};
function session() {
	const settings = Settings.isolated({ modelRoles: { judge: "mock/judge" } });
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "fake-key");
	const registry = new ModelRegistry(auth, "/nonexistent/studio-judgments.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	const native = {
		settings,
		modelRegistry: registry,
		getSessionId: () => "session",
		getAgentId: () => "StudioTest",
	} as unknown as ToolSession;
	return {
		native,
		service: new StudioJudgmentService({ sessionId: "session", studioToolSession: native } as AgentSession),
	};
}
function reply(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "clear: yes" }],
		api: "openai-responses",
		provider: "mock",
		model: "judge",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
	};
}
async function finish(native: ToolSession, id: string) {
	for (let i = 0; i < 300; i++) {
		if (!getJudgmentBatch(id, native)!.status().running) return;
		await Bun.sleep(5);
	}
	throw new Error("Mock batch did not settle");
}
afterEach(() => {
	releaseJudgmentBatches("StudioTest");
	vi.restoreAllMocks();
});
it("observes without draining, isolates sessions, and retries only failed inputs as a separate native job", async () => {
	const attempted: string[] = [];
	let fail = true;
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
		const prompt = JSON.stringify(context.messages);
		const state = prompt.includes("FAIL") ? "FAIL" : "PASS";
		attempted.push(state);
		if (state === "FAIL" && fail) throw new Error("Mock provider unavailable");
		const message = reply();
		options?.onAttempt?.(message);
		return message;
	});
	const { service, native } = session();
	const created = (await service.execute({ kind: "judgments.create", sessionId: "session", spec })) as {
		batch: JudgmentBatchRow;
	};
	await finish(native, created.batch.id);
	const page = (await service.execute({
		kind: "judgments.read",
		sessionId: "session",
		id: created.batch.id,
		offset: 0,
		limit: 1,
	})) as JudgmentBatchPage;
	expect(page.items).toHaveLength(1);
	expect(page.nextOffset).toBe(1);
	expect(page.batch.failed).toBe(1);
	const nativeDrain = (await runEvalJudgmentBatch({ op: "drain", id: created.batch.id }, { session: native })) as {
		items: unknown[];
	};
	expect(nativeDrain.items).toHaveLength(2);
	const wrongSession = await service
		.execute({ kind: "judgments.cancel", sessionId: "different", id: created.batch.id })
		.catch(error => error);
	expect(wrongSession).toMatchObject({ code: "COMMAND_BLOCKED" });
	fail = false;
	attempted.length = 0;
	const retried = (await service.execute({ kind: "judgments.retry", sessionId: "session", id: created.batch.id })) as {
		batch: JudgmentBatchRow;
		sourceId: string;
	};
	await finish(native, retried.batch.id);
	expect(retried.sourceId).toBe(created.batch.id);
	expect(retried.batch.id).not.toBe(created.batch.id);
	expect(attempted).toEqual(["FAIL"]);
	expect(getJudgmentBatch(created.batch.id, native)!.status().failed).toBe(1);
	expect(getJudgmentBatch(retried.batch.id, native)!.status().failed).toBe(0);
	await service.execute({ kind: "judgments.close", sessionId: "session", id: created.batch.id });
	expect(getJudgmentBatch(created.batch.id, native)).toBeUndefined();
	expect(getJudgmentBatch(retried.batch.id, native)).toBeDefined();
});
it("cancels through the native abort signal and never starts work for list/read requests", async () => {
	const started = Promise.withResolvers<void>();
	const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
		started.resolve();
		return new Promise((_resolve, reject) => {
			const abort = () => reject(new Error("cancelled"));
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
		});
	});
	const { service, native } = session();
	await service.execute({ kind: "judgments.list", sessionId: "session" });
	expect(complete).not.toHaveBeenCalled();
	const { batch } = (await service.execute({ kind: "judgments.create", sessionId: "session", spec })) as {
		batch: JudgmentBatchRow;
	};
	await started.promise;
	await service.execute({ kind: "judgments.cancel", sessionId: "session", id: batch.id });
	await finish(native, batch.id);
	const result = (await service.execute({
		kind: "judgments.read",
		sessionId: "session",
		id: batch.id,
	})) as JudgmentBatchPage;
	expect(result.batch.running).toBe(false);
	expect(result.batch.failed).toBe(2);
	expect(complete).toHaveBeenCalledTimes(1);
});
