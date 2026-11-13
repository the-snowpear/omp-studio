import { LoginCancelledError } from "@oh-my-pi/pi-ai/error";
import { getOAuthCredentialProvider, getOAuthProviders, loginRiskWarning } from "@oh-my-pi/pi-ai/oauth";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import { logoutCredential, toLogoutAccounts } from "../../slash-commands/helpers/logout";
import { openPath } from "../../utils/open";
import type {
	ModelAuthLoginResult,
	ModelAuthProvidersResult,
	ModelServicesOperation,
} from "../model-services-protocol";
import type { StudioInteractionGateway } from "./interaction-port";
import { SessionControlError } from "./session-control-service";

/** Native AuthStorage login, including prompt-first warnings, through the existing secret/challenge Deck. */
export class StudioModelAuthService {
	interaction?: StudioInteractionGateway;
	#inFlight = new Map<string, { abort: AbortController; commandId: string }>();
	constructor(readonly session: AgentSession) {}

	/** A device/browser login can wait on the provider without a pending Deck input; its worker must stay resident. */
	isBusy(): boolean {
		return this.#inFlight.size > 0;
	}

	#check(sessionId: string): void {
		if (sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The login session changed");
	}
	async list(sessionId: string): Promise<ModelAuthProvidersResult> {
		this.#check(sessionId);
		const auth = this.session.modelRegistry.authStorage;
		await auth.credentials.revalidate();
		return {
			sessionId,
			providers: getOAuthProviders().map(provider => {
				const storageProvider = getOAuthCredentialProvider(provider.id);
				const warning = loginRiskWarning(provider.id);
				return {
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: auth.keys.source(storageProvider) !== undefined,
					kind: authPolicyFor(provider.id)?.login?.kind === "api-key" ? ("api-key" as const) : ("oauth" as const),
					credentials: toLogoutAccounts(storageProvider, auth.credentials.list(storageProvider)).map(row => ({
						id: row.credentialId,
						label: sanitizeText(row.label),
						type: row.type,
					})),
					...(warning ? { warning } : {}),
				};
			}),
		};
	}

	cancel(sessionId: string, providerId: string): { cancelled: boolean } {
		this.#check(sessionId);
		const pending = this.#inFlight.get(providerId);
		if (!pending) return { cancelled: false };
		pending.abort.abort("Login cancelled");
		if (this.interaction?.pending()?.request.commandId === pending.commandId)
			this.interaction.cancel("Login cancelled");
		return { cancelled: true };
	}
	dispose(): void {
		for (const pending of this.#inFlight.values()) {
			pending.abort.abort("Session disposed");
			if (this.interaction?.pending()?.request.commandId === pending.commandId)
				this.interaction.cancel("Session disposed");
		}
		this.#inFlight.clear();
	}

	async login(sessionId: string, providerId: string): Promise<ModelAuthLoginResult> {
		this.#check(sessionId);
		const provider = getOAuthProviders().find(row => row.id === providerId && row.available);
		if (!provider) throw new SessionControlError("INVALID_ARGUMENT", "This native login provider is unavailable");
		if (!this.interaction)
			throw new SessionControlError("CAPABILITY_UNAVAILABLE", "The native GUI challenge channel is unavailable");
		if (this.#inFlight.has(providerId))
			throw new SessionControlError("COMMAND_BLOCKED", "A login is already running for this provider");
		const interaction = this.interaction;
		const abort = new AbortController();
		const commandId = `model-login:${sessionId}:${crypto.randomUUID()}`;
		this.#inFlight.set(providerId, { abort, commandId });
		try {
			await this.session.modelRegistry.authStorage.oauth.login(providerId, {
				signal: abort.signal,
				onAuth: info => {
					openPath(info.url);
					if (info.instructions) interaction.notify(info.instructions);
				},
				onProgress: message => interaction.notify(message),
				onPrompt: async prompt => {
					this.#check(sessionId);
					abort.signal.throwIfAborted();
					// Pass the actual native warning/key/code question through. Never synthesize an accepted "yes".
					const value = await interaction.input({
						commandId,
						title: prompt.message,
						...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
						secret: prompt.secret === true,
					});
					if (value === undefined || (!prompt.allowEmpty && !value.trim())) throw new LoginCancelledError();
					return value;
				},
			});
			this.#check(sessionId);
			await this.session.modelRegistry.refreshProvider(getOAuthCredentialProvider(providerId), "online");
			await this.session.refreshScopedModels();
			return {
				providerId,
				authenticated:
					this.session.modelRegistry.authStorage.keys.source(getOAuthCredentialProvider(providerId)) !== undefined,
				cancelled: false,
			};
		} catch (error) {
			if (error instanceof LoginCancelledError || abort.signal.aborted)
				return {
					providerId,
					authenticated:
						this.session.modelRegistry.authStorage.keys.source(getOAuthCredentialProvider(providerId)) !==
						undefined,
					cancelled: true,
				};
			throw error;
		} finally {
			if (interaction.pending()?.request.commandId === commandId) interaction.cancel("Login completed");
			this.#inFlight.delete(providerId);
		}
	}

	async execute(
		operation: Extract<ModelServicesOperation, { kind: `models.auth.${string}` }>,
	): Promise<ModelAuthProvidersResult | ModelAuthLoginResult | { cancelled: boolean }> {
		this.#check(operation.sessionId);
		if (operation.kind === "models.auth.providers.read") return this.list(operation.sessionId);
		if (operation.kind === "models.auth.login") return this.login(operation.sessionId, operation.providerId);
		if (operation.kind === "models.auth.cancel") return this.cancel(operation.sessionId, operation.providerId);
		const policy = authPolicyFor(operation.providerId);
		if (policy?.disabled || policy?.login?.kind !== "api-key")
			throw new SessionControlError("INVALID_ARGUMENT", "Select a native API-key provider");
		const provider = getOAuthCredentialProvider(operation.providerId);
		const auth = this.session.modelRegistry.authStorage;
		if (operation.kind === "models.auth.key.set") {
			const key = operation.apiKey.trim();
			if (!key) throw new SessionControlError("INVALID_ARGUMENT", "API key is required");
			await auth.credentials.upsert(provider, { type: "api_key", key, source: "login" });
			await this.session.modelRegistry.refreshProvider(provider, "online");
			await this.session.refreshScopedModels();
		} else {
			await auth.credentials.revalidate();
			if (
				!auth.credentials
					.list(provider)
					.some(row => row.id === operation.credentialId && row.credential.type === "api_key")
			)
				throw new SessionControlError("COMMAND_BLOCKED", "The selected API key changed; reload the list");
			await logoutCredential(this.session, provider, operation.credentialId);
		}
		return this.list(operation.sessionId);
	}
}
