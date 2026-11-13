import { describe, expect, test, spyOn } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { loginRiskWarning } from "@oh-my-pi/pi-ai/oauth";
import type { AgentSession } from "../src/session/agent-session";
import type { StudioInteractionGateway } from "../src/studio/services/interaction-port";
import { StudioModelAuthService } from "../src/studio/services/model-auth-service";

/** A refusal must stop the actual native login before any provider request/browser launch. */
describe("Studio native model authentication", () => {
	test("Antigravity presents the native risk challenge and never answers yes on the operator's behalf", async () => {
		const auth = await AuthStorage.create(":memory:");
		const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
			new Error("No provider request is authorized by this test"),
		);
		const titles: string[] = [];
		const service = new StudioModelAuthService({
			sessionId: "owner",
			modelRegistry: { authStorage: auth },
		} as unknown as AgentSession);
		service.interaction = {
			input: async (request: { title: string; secret?: boolean }) => {
				titles.push(request.title);
				return "no";
			},
			pending: () => undefined,
			notify: () => {},
			cancel: () => {},
		} as unknown as StudioInteractionGateway;
		try {
			const result = await service.login("owner", "google-antigravity");
			expect(result.cancelled).toBe(true);
			expect(titles).toHaveLength(1);
			expect(titles[0]).toContain(loginRiskWarning("google-antigravity")!);
			expect(fetch).not.toHaveBeenCalled();
			expect(auth.credentials.list("google-antigravity")).toEqual([]);
		} finally {
			service.dispose();
			fetch.mockRestore();
			auth.close();
		}
	});

	test("a provider-waiting login keeps its worker busy even without a pending Deck input", async () => {
		const auth = await AuthStorage.create(":memory:");
		const deferred = Promise.withResolvers<undefined>();
		const login = spyOn(auth.oauth, "login").mockImplementation(async () => deferred.promise);
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
			login.mockRestore();
			auth.close();
		}
	});

	test("Liquid key updates use native auth, refresh the scoped roster, and retain other credentials", async () => {
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
