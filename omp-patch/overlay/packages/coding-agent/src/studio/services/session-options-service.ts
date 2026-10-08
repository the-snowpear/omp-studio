import { realizesPriorityServiceTier, serviceTierFamily, shouldSendServiceTier } from "@oh-my-pi/pi-ai/types";
import {
	applyModelPreset,
	deleteModelPreset,
	findActiveModelPreset,
	getModelPreset,
	getModelPresetNames,
	modelPresetShadowOwner,
	saveModelPreset,
} from "../../config/model-presets";
import type { AgentSession } from "../../session/agent-session";
import { cfgProvidersCacheWarming } from "../../session/settings";
import type {
	ModelPresetResult,
	ModelPresetRow,
	SessionOptionsOperation,
	SessionSpeedState,
	SessionWarmingState,
	StudioSpeed,
} from "../session-options-protocol";
import { validateSessionOptionsOperation } from "../session-options-protocol";
import { SessionControlError } from "./session-control-service";

/** Thin adapters over native session controls and settings; no provider execution here. */
export class StudioSessionOptionsService {
	constructor(readonly session: AgentSession) {}

	speed(): SessionSpeedState {
		const session = this.session;
		const model = session.model;
		const supported: StudioSpeed[] = ["normal"];
		if (model && serviceTierFamily(model) && realizesPriorityServiceTier("priority", model)) supported.push("fast");
		if (model && serviceTierFamily(model) === "openai" && shouldSendServiceTier("ultrafast", model))
			supported.push("ultrafast");
		if (
			session.isSlowModeSupported() &&
			model &&
			(serviceTierFamily(model) === "anthropic" || shouldSendServiceTier("flex", model))
		)
			supported.push("slow");
		const effectiveTier = model ? session.effectiveServiceTier(model) : undefined;
		const slowEnabled = session.isSlowModeEnabled();
		const slowScope = session.getSlowModeScope();
		const usageLimit = session.getUsageLimitState();
		return {
			model: model ? model.provider + "/" + model.id : null,
			selected: session.isUltrafastModeEnabled()
				? "ultrafast"
				: session.isFastModeEnabled()
					? "fast"
					: slowEnabled
						? "slow"
						: "normal",
			supported,
			fastActive: session.isFastModeActive(),
			slowEnabled,
			...(effectiveTier ? { effectiveTier } : {}),
			...(slowScope ? { slowScope } : {}),
			...(usageLimit ? { usageLimit: { ...usageLimit } } : {}),
		};
	}

	warming(): SessionWarmingState {
		const status = this.session.cacheWarmingStatus;
		return {
			mode: cfgProvidersCacheWarming.get(this.session.settings),
			source: this.session.settings.getProvenance(cfgProvidersCacheWarming),
			state: status?.state ?? "unavailable",
			...(status?.reason ? { reason: status.reason } : {}),
			...(status?.nextWarmAt === undefined ? {} : { nextWarmAt: status.nextWarmAt }),
			...(status?.decision ? { decision: { ...status.decision } } : {}),
		};
	}

	async execute(operation: SessionOptionsOperation): Promise<unknown> {
		validateSessionOptionsOperation(operation);
		const session = this.session;
		const settings = session.settings;
		if (operation.sessionId !== session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "The active session changed; reload its controls");
		if (operation.kind === "session.speed.get") return this.speed();
		if (operation.kind === "session.warming.get") return this.warming();
		if (operation.kind === "session.speed.set") {
			const state = this.speed();
			if (operation.expectedModel !== state.model)
				throw new SessionControlError("COMMAND_BLOCKED", "The model changed; reload its speed options");
			if (!state.supported.includes(operation.speed))
				throw new SessionControlError("COMMAND_BLOCKED", "This model does not offer the selected speed");
			if (operation.speed === "slow") {
				if (state.supported.includes("fast")) session.setFastMode(false);
				session.setSlowMode(true);
			} else {
				if (state.slowEnabled) session.setSlowMode(false);
				if (operation.speed === "ultrafast") session.setUltrafastMode(true);
				else if (operation.speed === "fast") session.setFastMode(true);
				else {
					const family = session.model ? serviceTierFamily(session.model) : undefined;
					if (family) session.setServiceTierFamily(family, undefined);
				}
			}
			if (state.slowScope === "global" && (operation.speed === "slow" || state.slowEnabled)) await settings.flush();
			return this.speed();
		}
		if (operation.kind === "session.warming.set") {
			if (operation.persist) {
				cfgProvidersCacheWarming.clearOverride(settings);
				cfgProvidersCacheWarming.set(settings, operation.mode);
				await settings.flush();
			} else cfgProvidersCacheWarming.override(settings, operation.mode);
			return this.warming();
		}
		if (operation.kind === "models.presets.list") {
			const active = findActiveModelPreset(settings);
			const presets: ModelPresetRow[] = getModelPresetNames(settings)
				.slice(0, 200)
				.map(name => {
					const lookup = getModelPreset(settings, name);
					return {
						name,
						source: settings.getOwnedModelPreset(name)?.source ?? "default",
						active: name === active,
						roles: lookup.kind === "found" ? lookup.preset.modelRoles : {},
						...(lookup.kind === "found" && lookup.preset.defaultThinkingLevel
							? { thinking: lookup.preset.defaultThinkingLevel }
							: {}),
						...(lookup.kind === "invalid" ? { error: lookup.reason } : {}),
					};
				});
			return { presets };
		}
		if (session.isStreaming || session.isCompacting)
			throw new SessionControlError("COMMAND_BLOCKED", "Wait for the current turn before changing model presets");
		if (operation.kind === "models.presets.save") {
			saveModelPreset(settings, operation.name);
			await settings.flush();
			const shadowOwner = modelPresetShadowOwner(settings, operation.name);
			return { outcome: "saved", ...(shadowOwner ? { shadowOwner } : {}) } satisfies ModelPresetResult;
		}
		if (operation.kind === "models.presets.delete") {
			const outcome = deleteModelPreset(settings, operation.name);
			await settings.flush();
			return { outcome } satisfies ModelPresetResult;
		}
		const result = await applyModelPreset(settings, session, operation.name);
		await settings.flush();
		if (result.kind === "switched")
			return {
				outcome: result.kind,
				model: result.model.provider + "/" + result.model.id,
				...(result.thinkingLevel ? { thinking: result.thinkingLevel } : {}),
				shadowed: result.shadowed,
				...(result.shadowedThinking ? { shadowedThinking: result.shadowedThinking } : {}),
			} satisfies ModelPresetResult;
		return {
			outcome: result.kind,
			...("reason" in result ? { reason: result.reason } : {}),
			...("shadowed" in result ? { shadowed: result.shadowed } : {}),
		} satisfies ModelPresetResult;
	}
}
