import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { ModelProviderRoster } from "../model-services-protocol";
import { projectRuntimeModel } from "./workbench-service";
import { SessionControlError } from "./session-control-service";

/** Credential-authorized discovery is owned by ModelRegistry, including authoritative Otari rosters. */
export class StudioModelRosterService {
	constructor(readonly session: AgentSession) {}
	async refresh(sessionId: string, providerId: string): Promise<ModelProviderRoster> {
		if (sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The model session changed");
		const registry = this.session.modelRegistry;
		await registry.refreshProvider(providerId, "online");
		await this.session.refreshScopedModels();
		if (sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The model session changed");
		const state = registry.getProviderDiscoveryState(providerId);
		const available = registry.getAvailableForProviders(new Set([providerId]), "all");
		const models = available.slice(0, 200).map(model => ({
			...projectRuntimeModel(model, true),
			api: model.api,
			...(model.supportsTools === undefined ? {} : { tools: model.supportsTools }),
			...(model.cost ? { cost: model.cost } : {}),
		}));
		return {
			providerId,
			total: available.length,
			truncated: available.length > models.length,
			authenticated: registry.authStorage.keys.source(providerId) !== undefined,
			authoritative: providerEntry(providerId)?.dynamicModelsAuthoritative === true,
			status: state?.error ? "error" : models.length || state?.status === "empty" ? "ready" : "unavailable",
			...(state?.error ? { error: sanitizeText(state.error).slice(0, 1000) } : {}),
			models,
		};
	}
}
