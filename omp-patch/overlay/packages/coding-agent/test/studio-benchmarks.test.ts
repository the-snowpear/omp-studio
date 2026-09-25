import { expect, it } from "bun:test";
import type { ApiKeyResolver, AssistantMessage, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioBenchmarkService } from "../src/studio/services/benchmark-service";
import type { BenchmarkRun, BenchmarkSnapshot } from "../src/studio/benchmarks-protocol";

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
	usage: {
		input: 30,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 50,
		cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
	},
	duration: 120,
	ttft: 30,
} as AssistantMessage;
function setup() {
	let changed = () => {};
	const session = {
		sessionId: "s",
		sessionManager: { getCwd: () => "." },
		settings: Settings.isolated(),
		modelRegistry: {
			getAll: () => [model],
			getApiKey: async () => "fake-test-key",
			resolver: () => (() => Promise.resolve("fake-test-key")) as unknown as ApiKeyResolver,
			hasConfiguredAuth: () => true,
		},
		registerSessionChangeCallback: (callback: () => void) => {
			changed = callback;
			return () => {};
		},
	};
	return { session, changed: () => changed() };
}
async function finished(service: StudioBenchmarkService, id: string) {
	for (let i = 0; i < 200; i++) {
		const result = (await service.execute({ kind: "benchmarks.read", sessionId: "s", id })) as BenchmarkSnapshot;
		if (!service.running) return result;
		await Bun.sleep(5);
	}
	throw new Error("Mock benchmark did not stop");
}
it("runs native mixed workloads with structured metrics and no terminal output parsing", async () => {
	const { session } = setup();
	let calls = 0;
	const service = new StudioBenchmarkService(session as unknown as AgentSession, {
		streamSimple: (_model, _context, options) => {
			calls++;
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			const iterator = (async function* () {
				yield { type: "text_delta", delta: "response" };
				yield { type: "done", message };
			})();
			return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
		},
	});
	try {
		const { run } = (await service.execute({
			kind: "benchmarks.start",
			sessionId: "s",
			spec: { models: ["mock/bench"], profile: "mix", runs: 3, concurrency: 1, maxTokens: 32, prefillBytes: 1024 },
		})) as { run: BenchmarkRun };
		const result = await finished(service, run.id);
		expect(calls).toBe(3);
		expect(result.run.state).toBe("completed");
		expect(Object.keys(result.models[0]!.byChallenge)).toEqual(["chat", "prefill", "generation"]);
		expect(result.models[0]!.stats?.ttftMs.p50).toBe(30);
		expect(result.models[0]!.measurements).toHaveLength(3);
		expect(JSON.stringify(result)).not.toContain("fake-test-key");
	} finally {
		service.dispose();
	}
});
it("session changes abort the in-flight stream and prevent queued requests", async () => {
	const { session, changed } = setup();
	let calls = 0;
	const started = Promise.withResolvers<AbortSignal>();
	const service = new StudioBenchmarkService(session as unknown as AgentSession, {
		streamSimple: (_model, _context, options) => {
			calls++;
			const signal = options!.signal!;
			started.resolve(signal);
			const iterator = (async function* () {
				await new Promise<void>(resolve => {
					if (signal.aborted) resolve();
					else signal.addEventListener("abort", () => resolve(), { once: true });
				});
				throw new Error("cancelled");
			})();
			return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
		},
	});
	try {
		await service.execute({
			kind: "benchmarks.start",
			sessionId: "s",
			spec: { models: ["mock/bench"], profile: "chat", runs: 20, concurrency: 1 },
		});
		const signal = await started.promise;
		session.sessionId = "next";
		changed();
		expect(signal.aborted).toBe(true);
		for (let i = 0; i < 200 && service.running; i++) await Bun.sleep(5);
		expect(service.running).toBe(false);
		expect(calls).toBe(1);
		expect(await service.execute({ kind: "benchmarks.list", sessionId: "next" })).toEqual({ runs: [] });
	} finally {
		service.dispose();
	}
});
