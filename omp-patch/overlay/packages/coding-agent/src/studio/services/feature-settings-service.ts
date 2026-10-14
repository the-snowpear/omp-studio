import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai";
import type { AnySetting } from "../../config/registry";
import {
	cfgTaskAgentAccountPools,
	cfgTaskStructured,
	cfgWorktreeOnStart,
	cfgWorktreeOnExit,
} from "../../task/settings";
import { cfgCompactionModelThresholds, cfgContextFilesExtra } from "../../session/context-settings";
import { cfgRetryFallbackOn } from "../../session/settings";
import { cfgBashGitGuard } from "../../exec/settings";
import { cfgComposerPredictions } from "../../modes/settings";
import { cfgSpeechSpeed, cfgTtsLocalSpeed } from "../../tts/settings";
import { cfgGcCompress, cfgGcCompressAfterDays } from "../../cli/gc-settings";
import {
	planModelCompactionPoint,
	previewModelCompactionPoint,
	setModelCompactionPoint,
} from "../../session/model-compaction-threshold";
import type { AgentSession } from "../../session/agent-session";
import {
	FEATURE_SETTING_KEYS,
	validateFeatureSettingValue,
	type FeatureSettingKey,
	type FeatureSettingRow,
	type FeatureSettingsOperation,
	type PoolAccountOption,
} from "../feature-settings-protocol";
import { SessionControlError } from "./session-control-service";

const HANDLES: Record<FeatureSettingKey, AnySetting> = {
	"task.agentAccountPools": cfgTaskAgentAccountPools,
	"compaction.modelThresholds": cfgCompactionModelThresholds,
	"retry.fallbackOn": cfgRetryFallbackOn,
	"contextFiles.extra": cfgContextFilesExtra,
	"task.structured": cfgTaskStructured,
	"bash.gitGuard": cfgBashGitGuard,
	"worktree.onStart": cfgWorktreeOnStart,
	"worktree.onExit": cfgWorktreeOnExit,
	"composer.predictions": cfgComposerPredictions,
	"speech.speed": cfgSpeechSpeed,
	"tts.localSpeed": cfgTtsLocalSpeed,
	"gc.compress": cfgGcCompress,
	"gc.compressAfterDays": cfgGcCompressAfterDays,
};

export class StudioFeatureSettingsService {
	constructor(readonly session: AgentSession) {}
	#row(key: FeatureSettingKey): FeatureSettingRow {
		const setting = HANDLES[key],
			value: unknown = structuredClone(setting.get(this.session.settings));
		validateFeatureSettingValue(value);
		return { key, value, source: this.session.settings.getProvenance(setting) };
	}
	async execute(operation: FeatureSettingsOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Settings session changed");
		if (operation.kind === "preferences.features.get")
			return { settings: FEATURE_SETTING_KEYS.map(key => this.#row(key)) };
		if (operation.kind === "accounts.pool.options") {
			const accounts: PoolAccountOption[] = [];
			for (const { provider, credential } of this.session.modelRegistry.authStorage.credentials.list()) {
				if (credential.type !== "oauth") continue;
				const identityKey = resolveCredentialIdentityKey(provider, credential);
				if (!identityKey) continue;
				accounts.push({
					provider,
					identityKey,
					label: credential.orgName ? `${identityKey} · ${credential.orgName}` : identityKey,
				});
			}
			return { accounts: accounts.slice(0, 256), truncated: accounts.length > 256 };
		}
		if (operation.kind === "models.compaction.preview" || operation.kind === "models.compaction.set") {
			const slash = operation.selector.indexOf("/"),
				registry = this.session.modelRegistry;
			const model =
				slash > 0
					? registry.find(operation.selector.slice(0, slash), operation.selector.slice(slash + 1))
					: undefined;
			if (!model) throw new SessionControlError("INVALID_ARGUMENT", "Model is no longer available");
			const tiers = registry.contextWindowTiers(model);
			if (operation.kind === "models.compaction.set") {
				const update = setModelCompactionPoint(this.session.settings, model, operation.input, {
					tiers,
					confirmed: operation.confirmed,
				});
				if (update.kind === "confirm") return { saved: false, confirmationRequired: true, summary: update.message };
				await this.session.settings.flush();
				return { saved: true, confirmationRequired: false, summary: update.summary ?? update.described };
			}
			const plan = planModelCompactionPoint(this.session.settings, model, operation.input, tiers);
			const summary = previewModelCompactionPoint(this.session.settings, model, operation.input, tiers);
			return {
				valid: plan !== undefined,
				...(summary ? { summary } : {}),
				...(plan?.window === undefined ? {} : { window: plan.window }),
				...(plan?.trigger ? { trigger: plan.trigger.tokens } : {}),
				extended: !!(tiers && plan?.window && plan.window > tiers.standard),
			};
		}
		const setting = HANDLES[operation.key];
		if (operation.key === "compaction.modelThresholds")
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Use the model compaction editor to validate window and pricing changes",
			);
		if (operation.kind === "preferences.features.clearOverride") {
			setting.clearOverride(this.session.settings);
			return this.#row(operation.key);
		}
		setting.assertWritable(operation.value);
		if (operation.scope === "session") setting.override(this.session.settings, operation.value);
		else {
			setting.set(this.session.settings, operation.value);
			await this.session.settings.flush();
		}
		return this.#row(operation.key);
	}
}
