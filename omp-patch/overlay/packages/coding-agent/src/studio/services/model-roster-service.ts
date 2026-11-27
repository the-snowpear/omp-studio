import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthCredentialProvider } from "@oh-my-pi/pi-ai/oauth";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { getModelPricingStatus } from "@oh-my-pi/pi-catalog/models";
import type { LongContextTokenCost, TokenCost } from "@oh-my-pi/pi-catalog/types";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { ModelRegistry, ProviderDiscoveryState } from "../../config/model-registry";
import type { AgentSession } from "../../session/agent-session";
import {
	validateModelAvailableOperation,
	type ModelAvailableOperation,
	type ModelAvailablePage,
	type ModelAvailableRefreshResult,
	type ModelProviderRoster,
	type RuntimeAvailableModel,
	type RuntimeModelLongContextCost,
} from "../model-services-protocol";
import { runtimeText } from "../locale";
import { MODEL_AVAILABLE_MAX_ROWS, StudioModelAvailableSnapshots } from "./model-available-snapshots";
import { projectRuntimeModel } from "./workbench-service";
import { SessionControlError } from "./session-control-service";

const tokenCost = (cost: TokenCost): TokenCost => ({
	input: cost.input,
	output: cost.output,
	cacheRead: cost.cacheRead,
	cacheWrite: cost.cacheWrite,
});
const longContextCost = (cost: LongContextTokenCost): RuntimeModelLongContextCost => ({
	...tokenCost(cost),
	inputThreshold: cost.inputThreshold,
	...(cost.inputThresholdInclusive === undefined ? {} : { inputThresholdInclusive: cost.inputThresholdInclusive }),
});

/** Reuse the native model projection and expose only public capabilities, never endpoints, keys or headers. */
export function projectAvailableRuntimeModel(model: Model, discovery?: ProviderDiscoveryState): RuntimeAvailableModel {
	const thinking = model.thinking;
	const cost = model.cost;
	return {
		...projectRuntimeModel(model, true),
		id: model.id,
		api: model.api,
		source: "registry",
		image:
			model.input.includes("image") &&
			!(model.compat && "stripImageInput" in model.compat && model.compat.stripImageInput === true),
		input: [...model.input],
		tools: model.supportsTools !== false,
		...(model.providerType === undefined ? {} : { providerType: model.providerType }),
		...(model.transport === undefined ? {} : { transport: model.transport }),
		...(model.supportsComputerUse === undefined ? {} : { supportsComputerUse: model.supportsComputerUse }),
		...(model.hostedImage === undefined ? {} : { hostedImage: model.hostedImage }),
		...(model.maxContextWindow === undefined ? {} : { maxContextWindow: model.maxContextWindow }),
		...(model.imageCountBudget === undefined ? {} : { imageCountBudget: model.imageCountBudget }),
		...(thinking
			? {
					thinking: [...thinking.efforts],
					thinkingConfig: {
						mode: thinking.mode,
						efforts: [...thinking.efforts],
						...(thinking.defaultLevel === undefined ? {} : { defaultLevel: thinking.defaultLevel }),
						...(thinking.effortMap === undefined ? {} : { effortMap: { ...thinking.effortMap } }),
						...(thinking.supportsDisplay === undefined ? {} : { supportsDisplay: thinking.supportsDisplay }),
						...(thinking.prefixBinding === undefined ? {} : { prefixBinding: thinking.prefixBinding }),
						...(thinking.effortRouting === undefined ? {} : { effortRouting: { ...thinking.effortRouting } }),
						...(thinking.effortBudgets === undefined ? {} : { effortBudgets: { ...thinking.effortBudgets } }),
						...(thinking.suppressWhenOff === undefined ? {} : { suppressWhenOff: thinking.suppressWhenOff }),
						...(thinking.requiresEffort === undefined ? {} : { requiresEffort: thinking.requiresEffort }),
						...(thinking.unverified === undefined ? {} : { unverified: thinking.unverified }),
					},
				}
			: {}),
		cost: tokenCost(cost),
		pricingStatus: getModelPricingStatus(model),
		...(cost.longContext || cost.timeBased
			? {
					pricing: {
						...(cost.longContext ? { longContext: longContextCost(cost.longContext) } : {}),
						...(cost.timeBased
							? {
									timeBased: {
										offPeakMultiplier: cost.timeBased.offPeakMultiplier,
										peakWindows: cost.timeBased.peakWindows.map(window => ({
											weekdays: [...window.weekdays],
											startMinute: window.startMinute,
											endMinute: window.endMinute,
										})),
										...(cost.timeBased.effectiveRates
											? {
													effectiveRates: cost.timeBased.effectiveRates.map(rate => ({
														...tokenCost(rate),
														effectiveFrom: rate.effectiveFrom,
														...(rate.longContext
															? { longContext: longContextCost(rate.longContext) }
															: {}),
													})),
												}
											: {}),
									},
								}
							: {}),
					},
				}
			: {}),
		...(model.serviceTierCost ? { serviceTierCost: { ...model.serviceTierCost } } : {}),
		...(discovery
			? {
					discovery: {
						status: discovery.status,
						stale: discovery.stale,
						optional: discovery.optional,
						...(discovery.source === undefined ? {} : { source: discovery.source }),
						...(discovery.fetchedAt === undefined ? {} : { fetchedAt: discovery.fetchedAt }),
					},
				}
			: {}),
		...(model.description === undefined ? {} : { description: model.description }),
		...(model.isNew === undefined ? {} : { isNew: model.isNew }),
		...(model.isBeta === undefined ? {} : { isBeta: model.isBeta }),
		...(model.isProviderDefault === undefined ? {} : { isProviderDefault: model.isProviderDefault }),
		...(model.isRecommended === undefined ? {} : { isRecommended: model.isRecommended }),
	};
}

/** Credential-authorized discovery and materialization remain exclusively owned by ModelRegistry. */
export class StudioModelRosterService {
	readonly #snapshots = new StudioModelAvailableSnapshots();
	#registry: ModelRegistry | undefined;
	#unsubscribeRegistry: (() => void) | undefined;
	#unsubscribeCredentials: (() => void) | undefined;
	#preparedAuthGeneration: number | undefined;
	#scope = "";
	#version = crypto.randomUUID();
	#disposed = false;

	constructor(readonly session: AgentSession) {}

	/** Also usable by a host that installs a direct native runtime-key override. */
	invalidate(): void {
		this.#snapshots.clear();
		this.#version = crypto.randomUUID();
		this.#preparedAuthGeneration = undefined;
	}

	dispose(): void {
		this.#disposed = true;
		this.invalidate();
		this.#unsubscribeRegistry?.();
		this.#unsubscribeCredentials?.();
		this.#unsubscribeRegistry = undefined;
		this.#unsubscribeCredentials = undefined;
		this.#registry = undefined;
	}

	#current(sessionId: string): ModelRegistry {
		if (this.#disposed || sessionId !== this.session.sessionId) {
			this.invalidate();
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				runtimeText("模型所属会话已变更", "The model session changed"),
			);
		}
		const registry = this.session.modelRegistry;
		if (registry !== this.#registry) {
			this.#unsubscribeRegistry?.();
			this.#unsubscribeCredentials?.();
			this.invalidate();
			this.#scope = "";
			this.#registry = registry;
			this.#unsubscribeRegistry = registry.subscribeMirror(() => this.invalidate()).unsubscribe;
			this.#unsubscribeCredentials = registry.authStorage.credentials.onGeneration(() => this.invalidate());
		}
		return registry;
	}

	async available(operation: ModelAvailableOperation): Promise<ModelAvailablePage | { released: boolean }> {
		validateModelAvailableOperation(operation);
		const registry = this.#current(operation.sessionId);
		if (operation.kind === "models.available.release")
			return { released: this.#snapshots.release(operation.sessionId, operation.snapshotId) };

		// Native local-only refresh follows external credentials/config without issuing a model request.
		await registry.authStorage.credentials.poll();
		await registry.refreshIfStale();
		const authGeneration = registry.authStorage.credentials.generation;
		if (this.#preparedAuthGeneration !== authGeneration) {
			await registry.hydrateCredentialScopedModelCaches();
			this.#preparedAuthGeneration = authGeneration;
		}
		if (
			registry !== this.#current(operation.sessionId) ||
			authGeneration !== registry.authStorage.credentials.generation
		)
			throw new SessionControlError("COMMAND_BLOCKED", "Model credentials changed; read the catalog again", true);
		const scope = JSON.stringify([
			operation.sessionId,
			authGeneration,
			this.session.settings.revision,
			registry.mirrorInputs().settings?.revision,
		]);
		if (scope !== this.#scope) {
			this.#snapshots.clear();
			this.#version = crypto.randomUUID();
			this.#scope = scope;
		}
		if (operation.cursor) return this.#snapshots.read(operation.sessionId, this.#version, operation.cursor);
		const available = operation.providers
			? registry.getAvailableForProviders(new Set(operation.providers), "all")
			: registry.getAvailable("all");
		return this.#snapshots.create(
			operation.sessionId,
			this.#version,
			available
				.slice(0, MODEL_AVAILABLE_MAX_ROWS)
				.map(model => projectAvailableRuntimeModel(model, registry.getProviderDiscoveryState(model.provider))),
			operation.limit ?? 200,
			available.length,
		);
	}

	/** Explicit operator refresh, including native command-backed credentials and every provider kind. */
	async refreshAll(sessionId: string): Promise<ModelAvailableRefreshResult> {
		validateModelAvailableOperation({ kind: "models.available.refresh", sessionId });
		const registry = this.#current(sessionId);
		const checkCurrent = () => {
			if (registry !== this.#current(sessionId))
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					runtimeText("模型目录所属 Runtime 已变更", "The model registry changed"),
				);
		};
		this.invalidate();
		try {
			await registry.authStorage.credentials.poll();
			checkCurrent();
			await registry.refresh("online", { refreshCommandCredentials: true });
			checkCurrent();
			await this.session.refreshScopedModels();
			checkCurrent();
			return { sessionId, refreshed: true };
		} finally {
			// Even an unchanged or failed refresh ends leases opened before/during it.
			this.invalidate();
		}
	}

	async refresh(sessionId: string, providerId: string): Promise<ModelProviderRoster> {
		const registry = this.#current(sessionId);
		providerId = getOAuthCredentialProvider(providerId);
		this.invalidate();
		await registry.refreshProvider(providerId, "online", { refreshCommandCredentials: true });
		await this.session.refreshScopedModels();
		if (registry !== this.#current(sessionId))
			throw new SessionControlError("COMMAND_BLOCKED", "The model registry changed");
		const state = registry.getProviderDiscoveryState(providerId);
		const available = registry.getAvailableForProviders(new Set([providerId]), "all");
		const models = available.slice(0, 200).map(model => projectAvailableRuntimeModel(model, state));
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
