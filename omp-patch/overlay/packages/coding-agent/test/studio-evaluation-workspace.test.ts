import { afterEach, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { ApiKeyResolver, AssistantMessage, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import { ModelRegistry } from "../src/config/model-registry";
import { releaseJudgmentBatches } from "../src/eval/judgment-batch-bridge";
import type { ToolSession } from "../src/tools";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import type { AgentSession } from "../src/session/agent-session";
import { StudioEvaluationWorkspaceService, evaluationPlan } from "../src/studio/services/evaluation-workspace-service";
import type { EvaluationNativeSnapshot, EvaluationResultPage } from "../src/studio/evaluation-workspace-protocol";
afterEach(() => {
	releaseJudgmentBatches("StudioWorkspaceTest");
	vi.restoreAllMocks();
	for (const auth of auths.splice(0)) auth.close();
});
const auths: Array<{ close(): void }> = [];

it("review counts all detailed phases, including the rounded parallel wave", () => {
	const plan = evaluationPlan({
		kind: "benchmark",
		models: ["mock/a", "mock/b"],
		profile: "detailed",
		runs: 3,
		concurrency: 2,
	});
	expect(plan.requests).toBe(20);
	expect(plan.phases.map(p => [p.requests, p.concurrency, p.maxTokens])).toEqual([
		[3, 1, 512],
		[4, 2, 512],
		[3, 1, 64],
	]);
	const cache = evaluationPlan({ kind: "benchmark", models: ["mock/a"], profile: "cache", runs: 3 });
	expect(cache.requests).toBe(6);
	expect(cache.phases[0]?.maxTokens).toBe(64);
	const generation = evaluationPlan({ kind: "benchmark", models: ["mock/a"], profile: "generation" });
	expect(generation.phases[0]?.maxTokens).toBe(2048);
});

const model = buildModel({
	provider: "mock",
	id: "bench",
	api: "openai-completions",
	name: "Bench",
	baseUrl: "https://example.test",
	input: ["text"],
	reasoning: false,
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
});
const message = {
	role: "assistant",
	content: [{ type: "text", text: "response" }],
	stopReason: "stop",
	duration: 120,
	ttft: 30,
	usage: {
		input: 30,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 50,
		cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
	},
} as AssistantMessage;
const makeSession = () => {
	const authStorage = createInMemoryAuthStorage();
	auths.push(authStorage);
	return {
		sessionId: "evaluation-owner",
		sessionManager: { getCwd: () => "." },
		settings: Settings.isolated(),
		modelRegistry: {
			authStorage,
			getAll: () => [model],
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => (() => Promise.resolve("test-key")) as unknown as ApiKeyResolver,
			hasConfiguredAuth: () => true,
		},
	} as unknown as AgentSession;
};
async function settle(service: StudioEvaluationWorkspaceService, id: string) {
	for (let i = 0; i < 100; i++) {
		const result = (await service.execute({ kind: "evaluation.runtime.read", id })) as EvaluationNativeSnapshot;
		if (["completed", "failed", "cancelled", "partial"].includes(result.state)) return result;
		await Bun.sleep(5);
	}
	throw new Error("Native evaluation did not settle");
}
it("evaluation planning and execution bind the native account position to a stable credential", async () => {
	const session = makeSession();
	const auth = session.modelRegistry.authStorage;
	for (const email of ["one@example.test", "two@example.test"])
		await auth.credentials.upsert("mock", {
			type: "oauth",
			access: email,
			refresh: email,
			expires: Date.now() + 3600000,
			email,
		});
	const selected = auth.oauth.accounts("mock")[1]!;
	const account = { account: 2, credentialIds: { mock: selected.credentialId } };
	const access = vi.spyOn(auth.oauth, "accessById").mockImplementation(async (_provider, credentialId) => ({
		ok: true,
		credentialId,
		accessToken: "selected",
		apiKey: "selected",
	}));
	const fallback = vi.spyOn(session.modelRegistry, "resolver");
	let requests = 0;
	const service = new StudioEvaluationWorkspaceService(session, {
		streamSimple: (_model, _context, options) => {
			const iterator = (async function* () {
				if (typeof options?.apiKey !== "function") throw new Error("Missing native selected resolver");
				expect(await options.apiKey({ error: undefined, lastChance: false })).toBe("selected");
				requests++;
				yield { type: "done", message };
			})();
			return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
		},
	});
	const id = "2ca83f12-a51e-4a29-9b28-9ec567045a91";
	const spec = { kind: "benchmark" as const, models: ["mock/bench"], profile: "chat" as const, runs: 1, account };
	try {
		await service.execute({ kind: "evaluation.runtime.plan", spec });
		expect(access).not.toHaveBeenCalled();
		await service.execute({ kind: "evaluation.runtime.start", id, title: "Account", spec });
		expect((await settle(service, id)).state).toBe("completed");
		expect(requests).toBe(1);
		expect(access.mock.calls.every(([, credentialId]) => credentialId === selected.credentialId)).toBe(true);
		expect(fallback).not.toHaveBeenCalled();
		await auth.credentials.removeById("mock", auth.oauth.accounts("mock")[0]!.credentialId);
		await expect(service.execute({ kind: "evaluation.runtime.plan", spec })).rejects.toThrow("account");
		expect(requests).toBe(1);
	} finally {
		service.dispose();
	}
});

it("runs native detailed workloads, publishes progress and retains every measured phase", async () => {
	const outputs: number[] = [];
	const service = new StudioEvaluationWorkspaceService(makeSession(), {
		streamSimple: (_model, _context, options) => {
			outputs.push(options!.maxTokens!);
			return Object.assign(
				(async function* () {
					yield { type: "text_delta", delta: "response" };
					yield { type: "done", message };
				})(),
				{ result: async () => message },
			) as unknown as AssistantMessageEventStream;
		},
	});
	const id = "2ca83f12-a51e-4a29-9b28-9ec567045a88";
	let revisions = 0;
	service.subscribe(() => revisions++);
	try {
		await service.execute({
			kind: "evaluation.runtime.start",
			id,
			title: "Parity",
			spec: { kind: "benchmark", models: ["mock/bench"], profile: "detailed", runs: 1, concurrency: 2 },
		});
		const result = await settle(service, id);
		expect(result.state).toBe("completed");
		expect(outputs).toEqual([512, 512, 512, 64]);
		expect(result.completed).toBe(4);
		expect(result.metrics[0]?.metrics["parallel.aggregateTps"]).toBeNumber();
		const page = (await service.execute({ kind: "evaluation.runtime.rows", id })) as EvaluationResultPage;
		expect(page.rows.map(r => r.phase)).toEqual(["single", "parallel", "parallel", "prefill"]);
		expect(revisions).toBeGreaterThan(1);
		const lateCancel = (await service.execute({
			kind: "evaluation.runtime.control",
			id,
			action: "cancel",
		})) as EvaluationNativeSnapshot;
		expect(lateCancel.state).toBe("completed");
	} finally {
		service.dispose();
	}
});
it("cancelling instruction work aborts the native request instead of scheduling another turn", async () => {
	let requestSignal: AbortSignal | undefined;
	const service = new StudioEvaluationWorkspaceService(makeSession(), {
		streamSimple: (_model, _context, options) => {
			requestSignal = options!.signal;
			return Object.assign(
				(async function* () {
					await new Promise<void>((_, reject) =>
						options!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
					);
					yield { type: "done", message };
				})(),
				{ result: async () => message },
			) as unknown as AssistantMessageEventStream;
		},
	});
	const id = "2ca83f12-a51e-4a29-9b28-9ec567045a89";
	try {
		await service.execute({
			kind: "evaluation.runtime.start",
			id,
			title: "Cancel",
			spec: { kind: "instruction", models: ["mock/bench"], turns: 5 },
		});
		for (let i = 0; !requestSignal && i < 50; i++) await Bun.sleep(5);
		await service.execute({ kind: "evaluation.runtime.control", id, action: "cancel" });
		expect(requestSignal?.aborted).toBe(true);
		expect((await settle(service, id)).state).toBe("cancelled");
	} finally {
		service.dispose();
	}
});

it("judgment observation handles zero results and more than one native page without consuming the batch cursor", async () => {
	const settings = Settings.isolated({ modelRoles: { judge: "mock/bench" } });
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const registry = new ModelRegistry(auth, "/nonexistent/evaluation.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([model]);
	vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
		const reply = {
			...message,
			model: "bench",
			provider: "mock",
			api: "openai-completions",
			content: [{ type: "text", text: "correct: yes" }],
		} as AssistantMessage;
		options?.onAttempt?.(reply);
		return reply;
	});
	const tools = {
		settings,
		modelRegistry: registry,
		getSessionId: () => "evaluation-owner",
		getAgentId: () => "StudioWorkspaceTest",
	} as unknown as ToolSession;
	const session = {
		...makeSession(),
		settings,
		modelRegistry: registry,
		studioToolSession: tools,
	} as unknown as AgentSession;
	const service = new StudioEvaluationWorkspaceService(session);
	const id = "2ca83f12-a51e-4a29-9b28-9ec567045a90";
	try {
		await service.execute({
			kind: "evaluation.runtime.start",
			id,
			title: "Bulk",
			spec: {
				kind: "judgment",
				items: Array.from({ length: 61 }, (_, key) => ({ key, state: `unique item ${key}` })),
				questions: { correct: { type: "bool", instructions: "Is it correct?" } },
				concurrency: 8,
				retries: 0,
			},
		});
		const result = await settle(service, id);
		expect(result.error).toBeUndefined();
		expect(result.completed).toBe(61);
		expect(result.metrics[0]?.metrics.answered).toBe(61);
		expect(result.metrics[0]?.metrics.mean).toBeGreaterThan(0.5);
		const rows = (await service.execute({
			kind: "evaluation.runtime.rows",
			id,
			offset: 50,
			limit: 50,
		})) as EvaluationResultPage;
		expect(rows.total).toBe(61);
		expect(rows.rows).toHaveLength(11);
	} finally {
		service.dispose();
	}
});
