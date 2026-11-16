import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { loginRiskWarning, providerPauseReason, setUnpausedProviders } from "@oh-my-pi/pi-ai/oauth";
import { Settings } from "../src/config/settings";
import { cfgAuthUnpausedProviders } from "../src/config/model-settings";
import { applyUnpausedProviders } from "../src/session/auth-broker-config";
import type { AgentSession } from "../src/session/agent-session";
import type { ModelServicesOperation } from "../src/studio/model-services-protocol";
import type { StudioInteractionGateway } from "../src/studio/services/interaction-port";
import { StudioModelAuthService } from "../src/studio/services/model-auth-service";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
beforeEach(() => {
	settingsState = beginSettingsTest();
});
afterEach(() => {
	restoreSettingsTestState(settingsState);
});

describe("Studio native model authentication", () => {
	test("paused credentials stay stored; only an explicit global restore reaches the native login risk challenge", async () => {
		const provider = "google-antigravity";
		const auth = await AuthStorage.create(":memory:");
		setUnpausedProviders([provider]);
		await auth.credentials.upsert(provider, {
			type: "oauth",
			access: "saved-access",
			refresh: "saved-refresh",
			expires: Date.now() + 3_600_000,
			email: "saved@example.test",
		});
		const credentialId = auth.credentials.list(provider)[0]!.id;
		setUnpausedProviders([]);
		const settings = Settings.isolated();
		const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("No provider request is authorized by this test"),
		);
		const refreshes: string[] = [];
		const titles: string[] = [];
		const service = new StudioModelAuthService({
			sessionId: "owner",
			settings,
			modelRegistry: {
				authStorage: auth,
				refreshProvider: async (_id: string, strategy: string) => {
					refreshes.push(strategy);
				},
			},
			refreshScopedModels: async () => {},
		} as unknown as AgentSession);
		service.interaction = {
			input: async (request: { title: string }) => {
				titles.push(request.title);
				return "no";
			},
			pending: () => undefined,
			notify: () => {},
			cancel: () => {},
		} as unknown as StudioInteractionGateway;
		try {
			const paused = (await service.list("owner")).providers.find(row => row.id === provider)!;
			expect(paused).toMatchObject({ paused: true, available: false, pauseReason: providerPauseReason(provider) });
			expect(JSON.stringify(paused)).not.toContain("saved-access");
			await expect(service.login("owner", provider)).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
			expect(titles).toEqual([]);
			await expect(
				service.execute({
					kind: "models.auth.unpause",
					sessionId: "owner",
					providerId: provider,
					scope: "session",
					confirmed: true,
				} as unknown as Extract<ModelServicesOperation, { kind: "models.auth.unpause" }>),
			).rejects.toThrow();
			expect(cfgAuthUnpausedProviders.get(settings)).toEqual([]);
			await service.execute({
				kind: "models.auth.unpause",
				sessionId: "owner",
				providerId: provider,
				scope: "global",
				confirmed: true,
			});
			expect(settings.getGlobalSettings().auth).toMatchObject({ unpausedProviders: [provider] });
			expect(auth.credentials.list(provider)[0]?.id).toBe(credentialId);
			expect((await service.list("owner")).providers.find(row => row.id === provider)).toMatchObject({
				paused: false,
				available: true,
				authenticated: true,
			});
			expect((await service.login("owner", provider)).cancelled).toBe(true);
			expect(titles).toHaveLength(1);
			expect(titles[0]).toContain(loginRiskWarning(provider)!);
			expect(refreshes).toEqual(["offline"]);
			expect(auth.credentials.list(provider)[0]?.id).toBe(credentialId);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			service.dispose();
			auth.close();
		}
	});

	test("a repository unpause list never grants a paused provider or changes the operator list", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "studio-auth-project-"));
		const agentDir = path.join(directory, "agent");
		await Bun.write(
			path.join(directory, ".omp", "config.yml"),
			"auth:\n  unpausedProviders: [google-antigravity, project-only]\n",
		);
		await Bun.write(path.join(agentDir, "config.yml"), "auth:\n  unpausedProviders: [operator-only]\n");
		const auth = await AuthStorage.create(":memory:");
		let service: StudioModelAuthService | undefined;
		try {
			const settings = await Settings.loadReadOnly({ cwd: directory, agentDir });
			applyUnpausedProviders(settings);
			service = new StudioModelAuthService({
				sessionId: "owner",
				settings,
				modelRegistry: { authStorage: auth },
			} as unknown as AgentSession);
			expect(cfgAuthUnpausedProviders.get(settings)).toEqual(["google-antigravity", "project-only"]);
			expect((await service.list("owner")).providers.find(row => row.id === "google-antigravity")?.paused).toBe(
				true,
			);
			await expect(service.login("owner", "google-antigravity")).rejects.toMatchObject({ code: "COMMAND_BLOCKED" });
			expect(settings.getGlobalSettings().auth).toMatchObject({ unpausedProviders: ["operator-only"] });
		} finally {
			service?.dispose();
			auth.close();
			await fs.rm(directory, { recursive: true, force: true });
		}
	});

	test("cancellation wins over a late native login success without starting a roster refresh", async () => {
		const auth = await AuthStorage.create(":memory:");
		const cancelled = Promise.withResolvers<undefined>();
		let signal: AbortSignal | undefined;
		let refreshes = 0;
		spyOn(auth.oauth, "login").mockImplementation(async (_provider, control) => {
			signal = control.signal;
			control.signal?.addEventListener("abort", () => cancelled.resolve(undefined), { once: true });
			return cancelled.promise;
		});
		const service = new StudioModelAuthService({
			sessionId: "owner",
			modelRegistry: {
				authStorage: auth,
				refreshProvider: async () => {
					refreshes++;
				},
			},
			refreshScopedModels: async () => {},
		} as unknown as AgentSession);
		service.interaction = {
			pending: () => undefined,
			notify: () => {},
			cancel: () => {},
		} as unknown as StudioInteractionGateway;
		try {
			const running = service.login("owner", "typesafe");
			expect(service.isBusy()).toBe(true);
			expect(signal?.aborted).toBe(false);
			expect(service.cancel("owner", "typesafe")).toEqual({ cancelled: true });
			expect((await running).cancelled).toBe(true);
			expect(signal?.aborted).toBe(true);
			expect(service.isBusy()).toBe(false);
			expect(refreshes).toBe(0);
		} finally {
			service.dispose();
			auth.close();
		}
	});

	test("a provider-waiting login keeps its worker busy even without a pending Deck input", async () => {
		const auth = await AuthStorage.create(":memory:");
		const deferred = Promise.withResolvers<undefined>();
		spyOn(auth.oauth, "login").mockImplementation(async () => deferred.promise);
		const service = new StudioModelAuthService({
			sessionId: "owner",
			modelRegistry: { authStorage: auth, refreshProvider: async () => {} },
			refreshScopedModels: async () => {},
		} as unknown as AgentSession);
		service.interaction = {
			pending: () => undefined,
			notify: () => {},
			cancel: () => {},
		} as unknown as StudioInteractionGateway;
		try {
			expect(service.isBusy()).toBe(false);
			const running = service.login("owner", "typesafe");
			expect(service.isBusy()).toBe(true);
			expect(service.interaction.pending()).toBeUndefined();
			deferred.resolve(undefined);
			await running;
			expect(service.isBusy()).toBe(false);
		} finally {
			service.dispose();
			auth.close();
		}
	});

	test("native Judge API key updates refresh the roster without removing other credentials", async () => {
		const auth = await AuthStorage.create(":memory:");
		await auth.credentials.upsert("typesafe", { type: "api_key", key: "other-provider-key", source: "login" });
		const refreshes: string[] = [];
		let scoped = 0;
		const service = new StudioModelAuthService({
			sessionId: "owner",
			modelRegistry: {
				authStorage: auth,
				refreshProvider: async (id: string) => {
					refreshes.push(id);
				},
			},
			refreshScopedModels: async () => {
				scoped++;
			},
		} as unknown as AgentSession);
		try {
			const saved = await service.execute({
				kind: "models.auth.key.set",
				sessionId: "owner",
				providerId: "liquid",
				apiKey: "liquid-test-key",
			});
			expect(await auth.keys.get("liquid")).toBe("liquid-test-key");
			expect(JSON.stringify(saved)).not.toContain("liquid-test-key");
			const id = auth.credentials.list("liquid")[0]!.id;
			await service.execute({
				kind: "models.auth.key.remove",
				sessionId: "owner",
				providerId: "liquid",
				credentialId: id,
			});
			expect(auth.credentials.list("liquid")).toEqual([]);
			expect(await auth.keys.get("typesafe")).toBe("other-provider-key");
			expect(refreshes).toEqual(["liquid", "liquid"]);
			expect(scoped).toBe(2);
		} finally {
			service.dispose();
			auth.close();
		}
	});
});
