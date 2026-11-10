import { afterEach, describe, expect, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../src/session/agent-session";
import { StudioSearchCredentialsService } from "../src/studio/services/search-credentials-service";
import type { SearchCredentialStatus } from "../src/studio/search-credentials-protocol";

const stores: AuthStorage[] = [];
const env = { EXA_API_KEY: process.env.EXA_API_KEY, OLLAMA_CLOUD_API_KEY: process.env.OLLAMA_CLOUD_API_KEY };
afterEach(() => {
	for (const auth of stores.splice(0)) auth.close();
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});
async function setup() {
	const auth = await AuthStorage.create(":memory:");
	stores.push(auth);
	const refreshes: string[] = [];
	const session = {
		sessionId: "chat",
		modelRegistry: {
			authStorage: auth,
			refreshProvider: async (provider: string) => {
				refreshes.push(provider);
			},
		},
	} as unknown as AgentSession;
	return { auth, refreshes, service: new StudioSearchCredentialsService(session) };
}
describe("search credentials match native CLI auth", () => {
	for (const [provider, envKey] of [
		["exa", "EXA_API_KEY"],
		["ollama-cloud", "OLLAMA_CLOUD_API_KEY"],
	] as const) {
		test(
			provider + " saves with CLI priority, deduplicates the same key and falls back to env after selected deletion",
			async () => {
				const { auth, service, refreshes } = await setup();
				process.env[envKey] = "environment-test-key";
				await auth.oauth.login(provider, { onAuth() {}, onPrompt: async () => "studio-test-key" });
				const id = auth.credentials.list(provider)[0]!.id;
				const saved = (await service.execute({
					kind: "search.credentials.set",
					sessionId: "chat",
					provider,
					apiKey: "  studio-test-key  ",
				})) as SearchCredentialStatus;
				expect(saved.source).toBe("api_key");
				expect(saved.apiKeyLogin).toBe(true);
				expect(saved.credentials.map(row => row.id)).toEqual([id]);
				expect(await auth.keys.get(provider)).toBe("studio-test-key");
				expect(auth.credentials.list(provider)[0]!.credential).toMatchObject({ source: "login" });
				expect(JSON.stringify(saved)).not.toContain("studio-test-key");
				const removed = (await service.execute({
					kind: "search.credentials.remove",
					sessionId: "chat",
					provider,
					credentialId: id,
				})) as SearchCredentialStatus;
				expect(removed.credentials).toEqual([]);
				expect(removed.source).toBe("env");
				expect(removed.configured).toBe(true);
				expect(await auth.keys.get(provider)).toBe("environment-test-key");
				expect(refreshes).toEqual([provider, provider]);
			},
		);
	}
	test("saving and deleting a key preserve sibling OAuth accounts and other providers", async () => {
		const { auth, service } = await setup();
		await auth.credentials.upsert("exa", {
			type: "oauth",
			access: "oauth-test-secret",
			refresh: "",
			expires: Date.now() + 86400000,
			email: "account@example.test",
		});
		await auth.credentials.upsert("ollama-cloud", { type: "api_key", key: "other-test-key", source: "login" });
		const saved = (await service.execute({
			kind: "search.credentials.set",
			sessionId: "chat",
			provider: "exa",
			apiKey: "new-key",
		})) as SearchCredentialStatus;
		expect(saved.credentials.map(row => row.type).sort()).toEqual(["api_key", "oauth"]);
		const key = saved.credentials.find(row => row.type === "api_key")!;
		await service.execute({
			kind: "search.credentials.remove",
			sessionId: "chat",
			provider: "exa",
			credentialId: key.id,
		});
		expect(auth.credentials.list("exa").map(row => row.credential.type)).toEqual(["oauth"]);
		expect(await auth.keys.get("ollama-cloud")).toBe("other-test-key");
		const result = await service.execute({
			kind: "search.credentials.list",
			sessionId: "chat",
			providers: ["exa", "ollama-cloud"],
		});
		expect(JSON.stringify(result)).not.toContain("oauth-test-secret");
		expect(JSON.stringify(result)).not.toContain("other-test-key");
	});
});
