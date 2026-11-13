import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import type { AgentSession } from "../../session/agent-session";
import { logoutCredential, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import type { SearchCredentialsOperation, SearchCredentialStatus } from "../search-credentials-protocol";
import { SessionControlError } from "./session-control-service";

/** The credential identities used by the built-in search engines/groundings. */
const SEARCH_AUTH_PROVIDERS = new Set([
	"parallel",
	"perplexity",
	"google",
	"google-gemini-cli",
	"google-antigravity",
	"anthropic",
	"openai",
	"openai-codex",
	"xai",
	"xai-oauth",
	"zai",
	"exa",
	"keenable",
	"tinyfish",
	"sofya",
	"jina",
	"kagi",
	"tavily",
	"firecrawl",
	"brave",
	"deepseek",
	"kimi-code",
	"synthetic",
	"ollama-cloud",
]);
const OAUTH_ONLY = new Set(["google-gemini-cli", "google-antigravity", "openai-codex", "xai-oauth"]);

export class StudioSearchCredentialsService {
	constructor(readonly session: AgentSession) {}

	async execute(operation: SearchCredentialsOperation) {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The credential target session changed");
		const providers = operation.kind === "search.credentials.list" ? operation.providers : [operation.provider];
		if (!Array.isArray(providers) || providers.some(provider => !SEARCH_AUTH_PROVIDERS.has(provider)))
			throw new SessionControlError("INVALID_ARGUMENT", "Unknown search credential provider");
		const auth = this.session.modelRegistry.authStorage;
		await auth.credentials.revalidate();
		if (operation.kind === "search.credentials.list")
			return { providers: [...new Set(providers)].map(provider => this.#status(provider)) };
		if (operation.kind === "search.credentials.set") {
			if (OAUTH_ONLY.has(operation.provider))
				throw new SessionControlError("INVALID_ARGUMENT", "This provider requires its native login flow");
			const key = operation.apiKey?.trim();
			if (!key) throw new SessionControlError("INVALID_ARGUMENT", "API key is required");
			// Same upsert and provenance as CLI storeLoginApiKey; preserve other accounts.
			// Discard upsert's internal snapshot: it contains credential bytes.
			await auth.credentials.upsert(operation.provider, { type: "api_key", key, source: "login" });
			await this.session.modelRegistry.refreshProvider(operation.provider, "online");
		} else {
			if (!Number.isSafeInteger(operation.credentialId))
				throw new SessionControlError("INVALID_ARGUMENT", "Select a stored credential to remove");
			const result = await logoutCredential(this.session, operation.provider, operation.credentialId);
			if (!result.removed)
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"The selected credential is no longer stored; refresh the list",
				);
		}
		return this.#status(operation.provider);
	}

	#status(provider: string): SearchCredentialStatus {
		const auth = this.session.modelRegistry.authStorage;
		const source = auth.keys.source(provider);
		const login = authPolicyFor(provider)?.login;
		return {
			provider,
			configured: source !== undefined,
			source: source?.kind ?? null,
			...(source?.kind === "env" && source.envVar ? { envVar: source.envVar } : {}),
			apiKeyLogin: login?.kind === "api-key",
			...(login?.kind === "api-key" && login.authUrl ? { keyUrl: login.authUrl } : {}),
			credentials: toLogoutAccounts(provider, auth.credentials.list(provider)).map(row => ({
				id: row.credentialId,
				label: row.label,
				type: row.type,
			})),
		};
	}
}
