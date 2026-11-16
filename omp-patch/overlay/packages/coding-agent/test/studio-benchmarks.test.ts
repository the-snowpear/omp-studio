import { afterEach, expect, it, vi } from "bun:test";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import type { ApiKeyResolver, AssistantMessage, AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import { StudioBenchmarkService } from "../src/studio/services/benchmark-service";
import type { BenchmarkAccounts, BenchmarkRun, BenchmarkSnapshot } from "../src/studio/benchmarks-protocol";

const auths: Array<{ close(): void }> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const auth of auths.splice(0)) auth.close();
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
	const authStorage = createInMemoryAuthStorage();
	auths.push(authStorage);
	const session = {
		sessionId: "s",
		sessionManager: { getCwd: () => "." },
		settings: Settings.isolated(),
		modelRegistry: {
			authStorage,
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
it.each(["detailed", "cache"] as const)(
	"native %s work uses the confirmed credential ID for every request and reports measured progress",
	async profile => {
		const { session } = setup();
		const auth = session.modelRegistry.authStorage;
		await auth.credentials.upsert("mock", { type: "api_key", key: "unselected-static-key" });
		for (const email of ["first@example.test", "second@example.test"])
			await auth.credentials.upsert("mock", {
				type: "oauth",
				access: `access-${email}`,
				refresh: `refresh-${email}`,
				expires: Date.now() + 3600000,
				email,
			});
		const selected = auth.oauth.accounts("mock")[1]!;
		const access = vi.spyOn(auth.oauth, "accessById").mockImplementation(async (_provider, id) => ({
			ok: true,
			credentialId: id,
			accessToken: "isolated-oauth",
			apiKey: "selected-test-key",
		}));
		const fallback = vi.spyOn(session.modelRegistry, "resolver");
		const preflight = vi.spyOn(session.modelRegistry, "getApiKey");
		let calls = 0;
		const service = new StudioBenchmarkService(session as unknown as AgentSession, {
			streamSimple: (_model, _context, options) => {
				const iterator = (async function* () {
					if (typeof options?.apiKey !== "function") throw new Error("The native selected resolver is missing");
					expect(await options.apiKey({ error: undefined, lastChance: false })).toBe("selected-test-key");
					calls++;
					yield { type: "text_delta", delta: "response" };
					yield { type: "done", message };
				})();
				return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
			},
		});
		try {
			const choices = (await service.execute({
				kind: "benchmarks.accounts.read",
				sessionId: "s",
				providerId: "mock",
			})) as BenchmarkAccounts;
			expect(choices.accounts.map(row => [row.account, row.credentialId])).toEqual(
				auth.oauth.accounts("mock").map((row, index) => [index + 1, row.credentialId]),
			);
			expect(JSON.stringify(choices)).not.toContain("access-");
			const { run } = (await service.execute({
				kind: "benchmarks.start",
				sessionId: "s",
				spec: {
					models: ["mock/bench"],
					profile,
					runs: 1,
					concurrency: 2,
					account: { account: 2, credentialIds: { mock: selected.credentialId } },
				},
			})) as { run: BenchmarkRun };
			const result = await finished(service, run.id);
			expect(result.run.state).toBe("completed");
			expect(calls).toBe(profile === "cache" ? 2 : 4);
			expect(result.models[0]?.completed).toBe(profile === "cache" ? 1 : 4);
			expect(result.models[0]?.measurements).toHaveLength(calls);
			expect(access.mock.calls.every(([provider, id]) => provider === "mock" && id === selected.credentialId)).toBe(
				true,
			);
			expect(fallback).not.toHaveBeenCalled();
			expect(preflight).not.toHaveBeenCalled();
		} finally {
			service.dispose();
		}
	},
);

it("a changed native account position refuses a saved selection before any request instead of using another row", async () => {
	const { session } = setup();
	const auth = session.modelRegistry.authStorage;
	for (const email of ["first@example.test", "second@example.test"])
		await auth.credentials.upsert("mock", {
			type: "oauth",
			access: email,
			refresh: email,
			expires: Date.now() + 3600000,
			email,
		});
	const first = auth.oauth.accounts("mock")[0]!;
	await auth.credentials.removeById("mock", first.credentialId);
	const stream = vi.fn(() => {
		throw new Error("No paid request is authorized");
	});
	const access = vi.spyOn(auth.oauth, "accessById");
	const service = new StudioBenchmarkService(session as unknown as AgentSession, { streamSimple: stream });
	try {
		const { run } = (await service.execute({
			kind: "benchmarks.start",
			sessionId: "s",
			spec: {
				models: ["mock/bench"],
				profile: "chat",
				runs: 1,
				concurrency: 1,
				account: { account: 1, credentialIds: { mock: first.credentialId } },
			},
		})) as { run: BenchmarkRun };
		const result = await finished(service, run.id);
		expect(result.run.state).toBe("failed");
		expect(result.run.error).toContain("changed");
		expect(stream).not.toHaveBeenCalled();
		expect(access).not.toHaveBeenCalled();
	} finally {
		service.dispose();
	}
});

it("removing a selected native OAuth row during a run never switches later requests to the surviving account", async () => {
	const { session } = setup();
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
	const keys: string[] = [];
	const fallback = vi.spyOn(session.modelRegistry, "resolver");
	const service = new StudioBenchmarkService(session as unknown as AgentSession, {
		streamSimple: (_model, _context, options) => {
			const iterator = (async function* () {
				if (typeof options?.apiKey !== "function") throw new Error("Missing selected resolver");
				const key = await options.apiKey({ error: undefined, lastChance: false });
				keys.push(String(key));
				await auth.credentials.removeById("mock", selected.credentialId);
				yield { type: "done", message };
			})();
			return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
		},
	});
	try {
		const { run } = (await service.execute({
			kind: "benchmarks.start",
			sessionId: "s",
			spec: {
				models: ["mock/bench"],
				profile: "chat",
				runs: 2,
				concurrency: 1,
				account: { account: 2, credentialIds: { mock: selected.credentialId } },
			},
		})) as { run: BenchmarkRun };
		const result = await finished(service, run.id);
		expect(keys).toEqual(["two@example.test"]);
		expect(result.models[0]?.failed).toBe(1);
		expect(result.models[0]?.measurements[1]?.error).toContain("Could not get token for account");
		expect(auth.oauth.accounts("mock")).toHaveLength(1);
		expect(fallback).not.toHaveBeenCalled();
	} finally {
		service.dispose();
	}
});

it("cancelling cache work stops unscheduled pairs while keeping the completed native report", async () => {
	const { session } = setup();
	const started = Promise.withResolvers<void>();
	let requests = 0;
	const service = new StudioBenchmarkService(session as unknown as AgentSession, {
		streamSimple: (_model, _context, options) => {
			requests++;
			const iterator = (async function* () {
				if (requests === 3) {
					const cancelled = Promise.withResolvers<void>();
					options!.signal!.addEventListener("abort", () => cancelled.resolve(), { once: true });
					started.resolve();
					await cancelled.promise;
					throw new Error("cancelled");
				}
				yield { type: "done", message };
			})();
			return Object.assign(iterator, { result: async () => message }) as unknown as AssistantMessageEventStream;
		},
	});
	try {
		const { run } = (await service.execute({
			kind: "benchmarks.start",
			sessionId: "s",
			spec: { models: ["mock/bench"], profile: "cache", runs: 4, concurrency: 1 },
		})) as { run: BenchmarkRun };
		await started.promise;
		await service.execute({ kind: "benchmarks.cancel", sessionId: "s", id: run.id });
		const result = await finished(service, run.id);
		expect(result.run.state).toBe("cancelled");
		expect(requests).toBe(3);
		expect(result.models[0]?.completed).toBe(2);
		expect(result.models[0]?.measurements.slice(0, 2).map(row => row.ok)).toEqual([true, true]);
	} finally {
		service.dispose();
	}
});

it("cancellation aborts a selected account refresh before any benchmark request", async () => {
	const { session } = setup();
	const auth = session.modelRegistry.authStorage;
	await auth.credentials.upsert("mock", {
		type: "oauth",
		access: "test",
		refresh: "test",
		expires: Date.now() + 3600000,
		email: "test@example.test",
	});
	const selected = auth.oauth.accounts("mock")[0]!;
	const started = Promise.withResolvers<AbortSignal>();
	vi.spyOn(auth.oauth, "accessById").mockImplementation(async (_provider, _id, options) => {
		const pending = Promise.withResolvers<never>();
		started.resolve(options!.signal!);
		options!.signal!.addEventListener("abort", () => pending.reject(new Error("cancelled")), { once: true });
		return pending.promise;
	});
	const stream = vi.fn(() => {
		throw new Error("No paid request is authorized");
	});
	const service = new StudioBenchmarkService(session as unknown as AgentSession, { streamSimple: stream });
	try {
		const { run } = (await service.execute({
			kind: "benchmarks.start",
			sessionId: "s",
			spec: {
				models: ["mock/bench"],
				profile: "chat",
				runs: 1,
				concurrency: 1,
				account: { account: 1, credentialIds: { mock: selected.credentialId } },
			},
		})) as { run: BenchmarkRun };
		const signal = await started.promise;
		await service.execute({ kind: "benchmarks.cancel", sessionId: "s", id: run.id });
		expect(signal.aborted).toBe(true);
		expect((await finished(service, run.id)).run.state).toBe("cancelled");
		expect(stream).not.toHaveBeenCalled();
	} finally {
		service.dispose();
	}
});

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
it("detailed workloads retain native phases independently from cache phases", async () => {
	const { session } = setup();
	let calls = 0;
	const service = new StudioBenchmarkService(session as unknown as AgentSession, {
		streamSimple: () => {
			calls++;
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
			spec: { models: ["mock/bench"], profile: "detailed", runs: 1, concurrency: 2, maxTokens: 32 },
		})) as { run: BenchmarkRun };
		const result = await finished(service, run.id);
		expect(result.run.state).toBe("completed");
		expect(calls).toBe(4);
		expect(Object.keys(result.models[0]!.phases!)).toEqual(["single", "parallel", "prefill"]);
		expect(result.models[0]!.measurements.map(row => row.workloadPhase)).toEqual([
			"single",
			"parallel",
			"parallel",
			"prefill",
		]);
		expect(result.models[0]!.measurements.every(row => row.phase === undefined)).toBe(true);
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
