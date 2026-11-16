import { expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import * as path from "node:path";
import { AuthStorage, type Model } from "@oh-my-pi/pi-ai";
import { closeModelCache, readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { providerEntries } from "@oh-my-pi/pi-catalog/compat/providers";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import {
	modelsDevCatalogFallback,
	openrouterModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import { getBundledModel, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { cfgDisabledProviders } from "../src/config/model-settings";
import { Settings } from "../src/config/settings";
import type { AgentSession } from "../src/session/agent-session";
import type { ModelAvailablePage, RuntimeAvailableModel } from "../src/studio/model-services-protocol";
import { StudioModelAvailableSnapshots } from "../src/studio/services/model-available-snapshots";
import { projectAvailableRuntimeModel, StudioModelRosterService } from "../src/studio/services/model-roster-service";

const provider = "studio-roster-test";
const nativeRows = ["alpha", "beta"].map(id => ({
	id,
	name: id,
	reasoning: true,
	input: ["text", "image"],
	contextWindow: 32000,
	maxTokens: 4000,
	thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" },
	cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0.5 },
}));

async function fixture(keyless = false) {
	const directory = TempDir.createSync("studio-model-available-");
	const modelsPath = path.join(directory.path(), "models.yml");
	const config = {
		providers: {
			[provider]: {
				api: "openai-completions",
				baseUrl: "https://models.invalid/v1",
				auth: keyless ? "none" : "oauth",
				models: nativeRows,
			},
		},
	};
	await Bun.write(modelsPath, JSON.stringify(config));
	const auth = await AuthStorage.create(":memory:");
	// Disable bundled providers so the test never consumes inherited provider credentials or routes.
	const settings = Settings.isolated({ disabledProviders: getBundledProviders() });
	let fetches = 0;
	const registry = new ModelRegistry(auth, modelsPath, {
		settings,
		cacheDbPath: path.join(directory.path(), "models.db"),
		fetch: async () => {
			fetches++;
			throw new Error("Provider network requests are forbidden in this test");
		},
	});
	const session = { sessionId: "session-a", settings, modelRegistry: registry, refreshScopedModels: async () => {} };
	const service = new StudioModelRosterService(session as unknown as AgentSession);
	const read = async (cursor?: string) =>
		(await service.available({
			kind: "models.available.read",
			sessionId: session.sessionId,
			...(cursor ? { cursor } : { providers: [provider], limit: 1 }),
		})) as ModelAvailablePage;
	return {
		auth,
		registry,
		settings,
		session,
		service,
		read,
		config,
		modelsPath,
		async close() {
			service.dispose();
			settings.cancelPendingSaves();
			auth.close();
			closeModelCache();
			await directory.remove();
			expect(fetches).toBe(0);
		},
	};
}

test("OpenRouter reads native policy/freshness and credential/endpoint namespaces instead of other cache rows", async () => {
	const directory = TempDir.createSync("studio-openrouter-snapshot-");
	const modelsPath = path.join(directory.path(), "models.yml"),
		cacheDbPath = path.join(directory.path(), "models.db");
	const firstEndpoint = "https://first.invalid/api/v1",
		nextEndpoint = "https://second.invalid/api/v1";
	const firstKey = "sk-test-account-a",
		nextKey = "sk-test-account-b";
	const model = (id: string, input: number, baseUrl: string) =>
		buildModel({
			id,
			name: id,
			provider: "openrouter",
			api: "openrouter",
			baseUrl,
			reasoning: false,
			input: ["text"],
			supportsTools: true,
			contextWindow: 32000,
			maxTokens: 4000,
			cost: { input, output: 2, cacheRead: 0, cacheWrite: 0 },
		});
	const firstModel = model("test/account-a", 1, firstEndpoint);
	const manager = openrouterModelManagerOptions({ apiKey: firstKey, baseUrl: firstEndpoint });
	const fingerprint = fingerprintStaticModels(getBundledModels("openrouter"), {
		authoritative: manager.dynamicModelsAuthoritative === true,
		additive: modelsDevCatalogFallback("openrouter")?.additiveOnly === true,
	});
	const firstScope = resolveModelCacheProviderId("openrouter", { apiKey: firstKey, baseUrl: firstEndpoint });
	// Identical payload, later authority: native freshness owns the effective authority, not m.authoritative.
	writeModelCache(firstScope, Date.now() - 1000, [firstModel], false, fingerprint, cacheDbPath);
	writeModelCache(firstScope, Date.now(), [firstModel], true, fingerprint, cacheDbPath);
	writeModelCache(
		resolveModelCacheProviderId("openrouter", { apiKey: nextKey, baseUrl: firstEndpoint }),
		Date.now(),
		[model("test/account-b", 7, firstEndpoint)],
		true,
		fingerprint,
		cacheDbPath,
	);
	writeModelCache(
		resolveModelCacheProviderId("openrouter", { apiKey: nextKey, baseUrl: nextEndpoint }),
		Date.now(),
		[model("test/new-endpoint", 9, nextEndpoint)],
		true,
		fingerprint,
		cacheDbPath,
	);
	const db = new Database(cacheDbPath);
	try {
		db.query(
			"INSERT INTO model_cache (provider_id, version, materialization_policy, updated_at, authoritative, models) SELECT provider_id, version, 'previous-build-policy', updated_at, 1, ? FROM model_cache WHERE provider_id = ? LIMIT 1",
		).run(JSON.stringify([model("test/forbidden-old-policy", 99, firstEndpoint)]), firstScope);
	} finally {
		db.close();
	}
	await Bun.write(modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: firstEndpoint } } }));
	const auth = await AuthStorage.create(":memory:");
	await auth.credentials.set("openrouter", { type: "api_key", key: firstKey, source: "login" });
	const settings = Settings.isolated({ disabledProviders: getBundledProviders().filter(id => id !== "openrouter") });
	let fetches = 0;
	const registry = new ModelRegistry(auth, modelsPath, {
		settings,
		cacheDbPath,
		fetch: async () => {
			fetches++;
			throw new Error("Provider network requests are forbidden");
		},
	});
	const service = new StudioModelRosterService({
		sessionId: "openrouter-session",
		modelRegistry: registry,
		settings,
	} as unknown as AgentSession);
	const read = async (cursor?: string) =>
		(await service.available({
			kind: "models.available.read",
			sessionId: "openrouter-session",
			...(cursor ? { cursor } : { providers: ["openrouter"] }),
		})) as ModelAvailablePage;
	const collect = async (page: ModelAvailablePage) => {
		const models = [...page.models];
		while (page.nextCursor) {
			page = await read(page.nextCursor);
			models.push(...page.models);
		}
		return models;
	};
	try {
		const cached = readModelCache(firstScope, 60_000, Date.now, cacheDbPath);
		expect(cached?.models.map(model => model.id)).toEqual(["test/account-a"]);
		expect(cached?.authoritative).toBe(true);
		const first = await read();
		const discovery = registry.getProviderDiscoveryState("openrouter");
		expect([discovery?.source, discovery?.stale]).toEqual(["cache", false]);
		expect((await collect(first)).filter(row => row.kind === "chat").map(row => [row.id, row.cost?.input])).toEqual([
			["test/account-a", 1],
		]);
		await auth.credentials.set("openrouter", { type: "api_key", key: nextKey, source: "login" });
		await expect(read(first.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const second = await read();
		expect((await collect(second)).filter(row => row.kind === "chat").map(row => [row.id, row.cost?.input])).toEqual([
			["test/account-b", 7],
		]);
		await Bun.write(modelsPath, JSON.stringify({ providers: { openrouter: { baseUrl: nextEndpoint } } }));
		await registry.refresh("offline");
		await expect(read(second.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const third = await read();
		expect((await collect(third)).filter(row => row.kind === "chat").map(row => [row.id, row.cost?.input])).toEqual([
			["test/new-endpoint", 9],
		]);
		expect(JSON.stringify(third)).not.toContain("sk-test");
		expect(JSON.stringify(third)).not.toContain(".invalid");
		expect(fetches).toBe(0);
	} finally {
		service.dispose();
		settings.cancelPendingSaves();
		auth.close();
		closeModelCache();
		await directory.remove();
	}
});

test("full refresh updates the live authorized catalog, renews command credentials and waits for scoped models", async () => {
	const directory = TempDir.createSync("studio-model-refresh-");
	const modelsPath = path.join(directory.path(), "models.yml");
	const tokenPath = path.join(directory.path(), "test-token.txt");
	const helperPath = path.join(directory.path(), "test-credential.ts");
	await Bun.write(tokenPath, "first-test-token");
	await Bun.write(helperPath, "process.stdout.write(await Bun.file(process.argv[2]).text());");
	const discovery = (endpoint: string) => ({
		api: "openai-completions",
		baseUrl: endpoint,
		auth: "none",
		discovery: { type: "openai-models-list" },
	});
	await Bun.write(
		modelsPath,
		JSON.stringify({
			providers: {
				"studio-key": {
					...discovery("https://key.invalid/v1"),
					auth: "apiKey",
					apiKey: `!${JSON.stringify(process.execPath)} ${JSON.stringify(helperPath)} ${JSON.stringify(tokenPath)}`,
				},
				"studio-public": discovery("https://public.invalid/v1"),
				"studio-hidden": discovery("https://hidden.invalid/v1"),
				"studio-judge": {
					api: "google-decisions",
					baseUrl: "https://judge.invalid",
					auth: "none",
					models: [{ ...nativeRows[0], id: "decision", kind: "judge" }],
				},
			},
		}),
	);
	const auth = await AuthStorage.create(":memory:");
	const settings = Settings.isolated({
		disabledProviders: [
			...getBundledProviders(),
			...Object.keys(providerEntries()),
			"ollama",
			"llama.cpp",
			"lm-studio",
			"apple",
			"studio-hidden",
		],
	});
	const calls: Array<{ url: string; authorization: string | null }> = [];
	let revision = 1;
	const registry = new ModelRegistry(auth, modelsPath, {
		settings,
		cacheDbPath: path.join(directory.path(), "models.db"),
		fetch: async (input, init) => {
			const url = String(input);
			const authorization = new Headers(init?.headers).get("authorization");
			calls.push({ url, authorization });
			if (url === "https://key.invalid/v1/models")
				return Response.json({ data: [{ id: `key-${revision}`, context_length: revision * 32_000 }] });
			if (url === "https://public.invalid/v1/models")
				return Response.json({ data: [{ id: `public-${revision}`, context_length: revision * 32_000 }] });
			throw new Error(`Unexpected provider request: ${url}`);
		},
	});
	const scopedStarted = Promise.withResolvers<void>();
	const scopedFinish = Promise.withResolvers<void>();
	const scopedModels: string[][] = [];
	const session = {
		sessionId: "refresh-owner",
		settings,
		modelRegistry: registry,
		refreshScopedModels: async () => {
			scopedModels.push(
				registry
					.getAvailable("all")
					.map(model => model.id)
					.sort(),
			);
			if (revision === 2) {
				scopedStarted.resolve();
				await scopedFinish.promise;
			}
		},
	};
	const service = new StudioModelRosterService(session as unknown as AgentSession);
	const read = async (cursor?: string) =>
		(await service.available({
			kind: "models.available.read",
			sessionId: session.sessionId,
			...(cursor ? { cursor } : {}),
		})) as ModelAvailablePage;
	try {
		const initial = await read();
		expect(calls).toEqual([]);
		expect(initial.models.map(model => [model.id, model.kind])).toEqual([["decision", "judge"]]);
		await service.refreshAll(session.sessionId);
		await expect(read(initial.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const first = await read();
		expect(first.models.map(model => model.id).sort()).toEqual(["decision", "key-1", "public-1"]);
		expect(
			calls.filter(call => call.url === "https://key.invalid/v1/models").map(call => call.authorization),
		).toEqual(["Bearer first-test-token"]);
		await Bun.write(tokenPath, "renewed-test-token");
		revision = 2;
		let completed = false;
		const refreshing = service.refreshAll(session.sessionId).then(result => {
			completed = true;
			return result;
		});
		await scopedStarted.promise;
		expect(completed).toBe(false);
		await expect(read(first.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const duringRefresh = await read();
		scopedFinish.resolve();
		expect(await refreshing).toEqual({ sessionId: session.sessionId, refreshed: true });
		await expect(read(duringRefresh.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const current = await read();
		expect(current.models.map(model => model.id).sort()).toEqual(["decision", "key-2", "public-2"]);
		expect(current.models.find(model => model.id === "key-2")?.contextWindow).toBe(64_000);
		expect(scopedModels).toEqual([
			["decision", "key-1", "public-1"],
			["decision", "key-2", "public-2"],
		]);
		expect(
			calls.filter(call => call.url === "https://key.invalid/v1/models").map(call => call.authorization),
		).toEqual(["Bearer first-test-token", "Bearer renewed-test-token"]);
		expect(
			calls.filter(call => call.url === "https://public.invalid/v1/models").map(call => call.authorization),
		).toEqual([null, null]);
		expect(JSON.stringify(current)).not.toContain("test-token");
	} finally {
		scopedFinish.resolve();
		service.dispose();
		settings.cancelPendingSaves();
		auth.close();
		closeModelCache();
		await directory.remove();
	}
});

test("a failed full refresh expires old pages without pretending the unchanged catalog was refreshed", async () => {
	const f = await fixture(true);
	const refresh = spyOn(f.registry, "refresh").mockRejectedValue(new Error("native refresh failed"));
	try {
		const before = await f.read();
		await expect(f.service.refreshAll(f.session.sessionId)).rejects.toThrow("native refresh failed");
		await expect(f.read(before.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const after = await f.read();
		expect(after.version).not.toBe(before.version);
		expect(after.models.map(model => model.id)).toEqual(["alpha"]);
	} finally {
		refresh.mockRestore();
		await f.close();
	}
});

test("a full refresh cannot update another session's scoped selection or report success after a target switch", async () => {
	const f = await fixture(true);
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const refresh = spyOn(f.registry, "refresh").mockImplementation(async () => {
		started.resolve();
		await finish.promise;
	});
	let scoped = 0;
	f.session.refreshScopedModels = async () => {
		scoped++;
	};
	try {
		const refreshing = f.service.refreshAll(f.session.sessionId);
		await started.promise;
		f.session.sessionId = "session-b";
		finish.resolve();
		await expect(refreshing).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect(scoped).toBe(0);
	} finally {
		finish.resolve();
		refresh.mockRestore();
		await f.close();
	}
});

test("credential changes expire every page, including replacement keys with an unchanged public roster", async () => {
	const f = await fixture();
	try {
		expect((await f.read()).models).toEqual([]);
		await f.auth.credentials.upsert(provider, { type: "api_key", key: "first-test-key", source: "login" });
		const first = await f.read();
		expect(first.models.map(model => model.id)).toEqual(["alpha"]);
		expect((await f.read(first.nextCursor)).models.map(model => model.id)).toEqual(["beta"]);
		await f.auth.credentials.upsert(provider, { type: "api_key", key: "replacement-test-key", source: "login" });
		await expect(f.read(first.nextCursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED", retryable: true });
		const replaced = await f.read();
		expect(replaced.version).not.toBe(first.version);
		expect(JSON.stringify(replaced)).not.toContain("test-key");
		await f.auth.credentials.remove(provider);
		await expect(f.read(replaced.nextCursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect((await f.read()).models).toEqual([]);
	} finally {
		await f.close();
	}
});

test("keyless native models remain selectable and frozen pages cannot be changed by their reader", async () => {
	const f = await fixture(true);
	try {
		const complete = (await f.service.available({
			kind: "models.available.read",
			sessionId: f.session.sessionId,
		})) as ModelAvailablePage;
		expect(complete.models.map(model => model.id)).toEqual(["alpha", "beta"]);
		const first = await f.read();
		first.models[0]!.cost!.input = 999;
		first.models[0]!.thinkingConfig!.efforts = ["max"];
		const replay = await f.read(first.cursor);
		expect(replay.models[0]!.cost!.input).toBe(1);
		expect(replay.models[0]!.thinkingConfig!.efforts).toEqual(["low", "high"]);
		expect(
			await f.service.available({
				kind: "models.available.release",
				sessionId: f.session.sessionId,
				snapshotId: first.snapshotId,
			}),
		).toEqual({ released: true });
		await expect(f.read(first.nextCursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		await f.close();
	}
});

test("configuration and disabled-provider changes expire a lease instead of mixing catalogs", async () => {
	const f = await fixture(true);
	try {
		const before = await f.read();
		await Bun.write(
			f.modelsPath,
			JSON.stringify({
				providers: {
					[provider]: {
						...f.config.providers[provider],
						models: [
							{ ...nativeRows[0], id: "new-model", cost: { input: 7, output: 8, cacheRead: 0, cacheWrite: 0 } },
						],
					},
				},
			}),
		);
		await f.registry.refresh("offline");
		await expect(f.read(before.nextCursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const changed = await f.read();
		expect(changed.models.map(model => model.id)).toEqual(["new-model"]);
		expect(changed.models[0]!.cost!.input).toBe(7);
		cfgDisabledProviders.override(f.settings, [...getBundledProviders(), provider]);
		await expect(f.read(changed.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect((await f.read()).models).toEqual([]);
	} finally {
		await f.close();
	}
});

test("session and registry replacements cannot reuse another target's cursor", async () => {
	const f = await fixture(true);
	try {
		const first = await f.read();
		f.session.sessionId = "session-b";
		await expect(f.read(first.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		const second = await f.read();
		f.session.modelRegistry = new ModelRegistry(f.auth, f.modelsPath, {
			settings: f.settings,
			cacheDbPath: path.join(path.dirname(f.modelsPath), "models.db"),
			fetch: async () => {
				throw new Error("offline");
			},
		});
		await expect(f.read(second.cursor)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
		expect((await f.read()).sessionId).toBe("session-b");
		f.service.dispose();
		await expect(f.read()).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
	} finally {
		await f.close();
	}
});

test("native Judge kinds, complete rates and thinking survive projection without request credentials", () => {
	const model: Model = {
		...getBundledModel("google", "gemini-decision-1")!,
		baseUrl: "https://private.invalid?key=endpoint-secret",
		headers: { Authorization: "header-secret" },
		resolveHeaders: async () => {
			throw new Error("Inspection must not materialize headers");
		},
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.High],
			defaultLevel: Effort.High,
			prefixBinding: true,
			effortRouting: { high: "upstream-high" },
			effortBudgets: { low: 512 },
			requiresEffort: true,
		},
		cost: {
			input: 1,
			output: 2,
			cacheRead: 0.1,
			cacheWrite: 0.2,
			longContext: { inputThreshold: 1000, input: 3, output: 4, cacheRead: 0.3, cacheWrite: 0.4 },
			timeBased: {
				offPeakMultiplier: 0.5,
				peakWindows: [{ weekdays: [1], startMinute: 60, endMinute: 120 }],
				effectiveRates: [{ effectiveFrom: 123, input: 2, output: 3, cacheRead: 0.2, cacheWrite: 0.3 }],
			},
		},
	};
	const result = projectAvailableRuntimeModel(model, {
		provider: "google",
		status: "cached",
		optional: false,
		stale: true,
		source: "cache",
		fetchedAt: 123,
		models: [model.id],
	});
	expect(result.kind).toBe("judge");
	expect(result.api).toBe("google-decisions");
	expect(result.thinkingConfig?.effortRouting?.high).toBe("upstream-high");
	expect(result.pricing?.longContext?.inputThreshold).toBe(1000);
	expect(result.pricing?.timeBased?.effectiveRates?.[0]?.input).toBe(2);
	expect(result.discovery).toMatchObject({ source: "cache", stale: true });
	expect(JSON.stringify(result)).not.toContain("secret");
	expect(result).not.toHaveProperty("headers");
	expect(result).not.toHaveProperty("resolveHeaders");
	expect(projectAvailableRuntimeModel(getBundledModel("nace", "drex-max-v1.1")!).kind).toBe("judge");
	expect(projectAvailableRuntimeModel(getBundledModel("antigravity-cli", "gemini-4-carbon")!).pricingStatus).not.toBe(
		"free",
	);
});

test("large catalogs are bounded, old leases are evicted and expired cursors require a new snapshot", () => {
	const store = new StudioModelAvailableSnapshots();
	const model: RuntimeAvailableModel = {
		id: "model",
		selector: "test/model",
		provider: "test",
		name: "model",
		api: "openai-completions",
		kind: "chat",
		source: "registry",
		image: false,
		reasoning: false,
	};
	const first = store.create(
		"owner",
		"generation",
		Array.from({ length: 10001 }, (_, id) => ({ ...model, id: String(id), selector: `test/${id}` })),
		200,
	);
	try {
		expect(first.total).toBe(10001);
		expect(first.truncated).toBe(true);
		let current = first,
			count = current.models.length;
		while (current.nextCursor) {
			current = store.read("owner", "generation", current.nextCursor);
			count += current.models.length;
		}
		expect(count).toBe(10000);
		for (let i = 0; i < 8; i++) store.create("owner", "generation", [model], 200);
		expect(() => store.read("owner", "generation", first.cursor)).toThrow("expired");
		const last = store.create("owner", "generation", [model], 200);
		const clock = spyOn(Date, "now").mockReturnValue(last.expiresAt + 1);
		try {
			expect(() => store.read("owner", "generation", last.cursor)).toThrow("expired");
		} finally {
			clock.mockRestore();
		}
	} finally {
		store.clear();
	}
});
