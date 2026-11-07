import { outRepliesActive } from "../../internal-urls/out-protocol";
import { cfgMagicKeyword, cfgMagicKeywordsEnabled } from "../../modes/settings";
import { cfgOutEnabled, cfgToolsXdevNotices } from "../../tools/settings";
import {
	cfgBtwInject,
	cfgComposerPredictionAlternatives,
	cfgDisplayShellVisualization,
	cfgDisplayAdvisorCollapsedLines,
} from "../../modes/settings";
import { cfgTitleRefreshAfterPrompts } from "../../utils/title-settings";
import {
	cfgTaskFile,
	cfgTaskPerCallModel,
	cfgTaskPerCallModelAllow,
	cfgTaskWorkerThreads,
	cfgOvnfsPath,
} from "../../task/settings";
import {
	cfgPrewalkFrom,
	cfgPrewalkInto,
	cfgRetryRateLimitWalksChain,
	cfgProvidersOpenaiResponsesWebsockets,
	cfgProvidersOpenaiCodexDaybreak,
} from "../../session/settings";
import { cfgJudgmentAttemptTimeoutMs } from "../../config/model-settings";
import { cfgSkillsManualSkills } from "../../extensibility/settings";
import { cfgHindsightGlobalScope } from "../../hindsight/settings";
import {
	cfgSpotlightExperimentEnabled,
	cfgSpotlightUrl,
	cfgSpotlightModel,
	cfgSpotlightThinking,
	cfgSpotlightTimeoutMs,
	cfgSpotlightExperimentHoldout,
	cfgSpotlightExperimentScoreFree,
	cfgSpotlightExperimentTools,
} from "../../spotlight/settings";
import { resolveCredentialIdentityKey } from "@oh-my-pi/pi-ai";
import type { AnySetting } from "../../config/registry";
import {
	cfgTaskAgentAccountPools,
	cfgTaskStructured,
	cfgWorktreeOnStart,
	cfgWorktreeOnExit,
} from "../../task/settings";
import {
	cfgCompactionModelThresholds,
	cfgContextFilesExtra,
	cfgCompactionIdleEnabled,
	cfgCompactionIdleThresholdTokens,
	cfgCompactionIdleTimeoutSeconds,
} from "../../session/context-settings";
import {
	cfgPrewalkAuto,
	cfgPrewalkAutoTarget,
	cfgRetryFallbackOn,
	cfgSessionWorktreeScope,
} from "../../session/settings";
import {
	cfgAsyncWidgets,
	cfgComputerBackgroundFallback,
	cfgComputerEnabled,
	cfgComputerDisplay,
	cfgComputerMaxWidth,
	cfgComputerMaxHeight,
	cfgToolsRestrictedFolders,
} from "../../tools/settings";
import type { StudioComputerWorkspaceService } from "./computer-workspace-service";
import { cfgExtensionHandlersModeControl } from "../../extensibility/settings";
import { cfgSttEnabled, cfgSttLanguage, cfgSttSubmitTrigger } from "../../stt/settings";
import { cfgBashGitGuard } from "../../exec/settings";
import { cfgComposerPredictions, cfgRecapEnabled, cfgRecapIdleSeconds } from "../../modes/settings";
import { cfgSpeechSpeed, cfgTtsLocalSpeed } from "../../tts/settings";
import { cfgGcCompress, cfgGcCompressAfterDays, cfgGcAutoCompress } from "../../cli/gc-settings";
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
import { StudioSessionCompactionService } from "./session-compaction-service";

const HANDLES: Record<FeatureSettingKey, AnySetting> = {
	"magicKeywords.enabled": cfgMagicKeywordsEnabled,
	"magicKeywords.chillax": cfgMagicKeyword.chillax,
	"out.enabled": cfgOutEnabled,
	"btw.inject": cfgBtwInject,
	"composer.predictionAlternatives": cfgComposerPredictionAlternatives,
	"display.shellVisualization": cfgDisplayShellVisualization,
	"title.refreshAfterPrompts": cfgTitleRefreshAfterPrompts,
	"display.advisorCollapsedLines": cfgDisplayAdvisorCollapsedLines,
	"task.file": cfgTaskFile,
	"task.perCallModel": cfgTaskPerCallModel,
	"task.perCallModelAllow": cfgTaskPerCallModelAllow,
	"task.workerThreads": cfgTaskWorkerThreads,
	"ovnfs.path": cfgOvnfsPath,
	"prewalk.from": cfgPrewalkFrom,
	"prewalk.into": cfgPrewalkInto,
	"retry.rateLimitWalksChain": cfgRetryRateLimitWalksChain,
	"providers.openaiResponsesWebsockets": cfgProvidersOpenaiResponsesWebsockets,
	"providers.openai-codex.daybreak": cfgProvidersOpenaiCodexDaybreak,
	"judgment.attemptTimeoutMs": cfgJudgmentAttemptTimeoutMs,
	"skills.manualSkills": cfgSkillsManualSkills,
	"hindsight.globalScope": cfgHindsightGlobalScope,
	"tools.xdevNotices": cfgToolsXdevNotices,
	"spotlight.experiment.enabled": cfgSpotlightExperimentEnabled,
	"spotlight.url": cfgSpotlightUrl,
	"spotlight.model": cfgSpotlightModel,
	"spotlight.thinking": cfgSpotlightThinking,
	"spotlight.timeoutMs": cfgSpotlightTimeoutMs,
	"spotlight.experiment.holdout": cfgSpotlightExperimentHoldout,
	"spotlight.experiment.scoreFree": cfgSpotlightExperimentScoreFree,
	"spotlight.experiment.tools": cfgSpotlightExperimentTools,

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
	"prewalk.auto": cfgPrewalkAuto,
	"prewalk.autoTarget": cfgPrewalkAutoTarget,
	"async.widgets": cfgAsyncWidgets,
	"computer.enabled": cfgComputerEnabled,
	"computer.display": cfgComputerDisplay,
	"computer.maxWidth": cfgComputerMaxWidth,
	"computer.maxHeight": cfgComputerMaxHeight,
	"computer.backgroundFallback": cfgComputerBackgroundFallback,
	"tools.restrictedFolders": cfgToolsRestrictedFolders,
	"extensionHandlers.modeControl": cfgExtensionHandlersModeControl,
	"recap.enabled": cfgRecapEnabled,
	"recap.idleSeconds": cfgRecapIdleSeconds,
	"compaction.idleEnabled": cfgCompactionIdleEnabled,
	"compaction.idleThresholdTokens": cfgCompactionIdleThresholdTokens,
	"compaction.idleTimeoutSeconds": cfgCompactionIdleTimeoutSeconds,
	"gc.autoCompress": cfgGcAutoCompress,
	"session.worktreeScope": cfgSessionWorktreeScope,
	"stt.enabled": cfgSttEnabled,
	"stt.language": cfgSttLanguage,
	"stt.submitTrigger": cfgSttSubmitTrigger,
};

export class StudioFeatureSettingsService {
	constructor(
		readonly session: AgentSession,
		readonly computer?: StudioComputerWorkspaceService,
	) {}
	#row(key: FeatureSettingKey): FeatureSettingRow {
		const setting = HANDLES[key],
			value: unknown =
				key === "out.enabled"
					? outRepliesActive(this.session.settings, this.session.studioToolSession?.replyTranscript === true)
					: structuredClone(setting.get(this.session.settings) ?? null);
		validateFeatureSettingValue(value);
		return { key, value, source: this.session.settings.getProvenance(setting) };
	}
	async execute(operation: FeatureSettingsOperation): Promise<unknown> {
		if (operation.sessionId !== this.session.sessionId)
			throw new SessionControlError("COMMAND_BLOCKED", "Settings session changed");
		if (operation.kind === "session.compaction.get") return new StudioSessionCompactionService(this.session).get();
		if (operation.kind === "session.compaction.set")
			return new StudioSessionCompactionService(this.session).set(operation.input);
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
			if (operation.key === "computer.enabled" && !cfgComputerEnabled.get(this.session.settings))
				await this.computer?.stop("disable");
			this.session.refreshIdleMaintenance?.();
			return this.#row(operation.key);
		}
		setting.assertWritable(operation.value);
		if (operation.key === "computer.enabled") {
			if (operation.value === true && this.computer && !this.computer.preludeAvailable())
				throw new SessionControlError("CAPABILITY_UNAVAILABLE", "Native Computer Eval prelude is unavailable");
			if (operation.scope === "session" && operation.value === false) await this.computer?.stop("disable");
		}
		if (
			(operation.key === "computer.maxWidth" || operation.key === "computer.maxHeight") &&
			(!Number.isInteger(operation.value) || (operation.value as number) < 1 || (operation.value as number) > 16384)
		)
			throw new SessionControlError(
				"INVALID_ARGUMENT",
				"Computer image dimensions must be integers from 1 to 16384",
			);
		if (
			operation.key === "computer.display" &&
			(typeof operation.value !== "string" || !operation.value.trim() || operation.value.length > 512)
		)
			throw new SessionControlError("INVALID_ARGUMENT", "A native display id, active, or all is required");
		if (operation.scope === "session") setting.override(this.session.settings, operation.value);
		else {
			setting.set(this.session.settings, operation.value);
			await this.session.settings.flush();
		}
		this.session.refreshIdleMaintenance?.();
		return this.#row(operation.key);
	}
}
