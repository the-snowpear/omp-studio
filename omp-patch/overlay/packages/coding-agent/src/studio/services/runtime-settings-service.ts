import { GUI_SETTING_KEYS, isGuiSettingKey, validateGuiSetting, type GuiSettingsSnapshot } from "../gui-settings-protocol";
import { cfgModelRoles } from "../../config/model-settings";
import { cfgProvidersCacheWarming } from "../../session/settings";
import { cfgTaskSpeculativeLaunch } from "../../task/settings";
import { cfgProvidersOpenaiLiveSteering } from "../../session/settings";
import { cfgTelemetryOtlpExportEnabled } from "../../telemetry-settings";
import { cfgAdvisorEvictStaleResults } from "../../advisor/settings";
import { cfgTaskAgentCompactionThresholdOverrides } from "../../task/settings";
import { cfgMnemopiScoping } from "../../mnemopi/settings";
import { cfgTierOpenai } from "../../session/settings";
import { cfgTierAnthropic } from "../../session/settings";
import { cfgTierGoogle } from "../../session/settings";
import { cfgTierSubagent } from "../../session/settings";
import { cfgTierAdvisor } from "../../session/settings";
import { cfgCodexResetsAutoRedeem } from "../../session/settings";
import { cfgCodexResetsMinBlockedMinutes } from "../../session/settings";
import { cfgCodexResetsKeepCredits } from "../../session/settings";
import { cfgCodexResetsSalvageHorizonHours } from "../../session/settings";
import { cfgIdaEnabled } from "../../ida/settings";
import { cfgIdaPython } from "../../ida/settings";
import { cfgIdaInstallDir } from "../../ida/settings";
import { cfgIdaMaxOpen } from "../../ida/settings";
import { cfgIdaIdleCloseSec } from "../../ida/settings";
import { cfgSpellingAutocomplete } from "../../modes/settings";
import { type SettingValueOf } from "../../config/registry";
import {
	cfgCompactionAsyncEnabled,
	cfgCompactionExperimentalContextManagement,
	cfgCompactionMethodOrder,
	cfgExtendedContext,
} from "../../session/context-settings";
import {
	cfgClaudeResetsAutoRedeem,
	cfgClaudeResetsKeepCredits,
	cfgClaudeResetsMinBlockedMinutes,
	cfgClaudeResetsSalvageHorizonHours,
	cfgFeaturesUnexpectedStopDetection,
	cfgImagesDescribeForTextModels,
	cfgProvidersAutoThinkingMaxEffort,
	cfgProvidersOpenaiCodexCodeMode,
	cfgRetryWaitForUsageReset,
} from "../../session/settings";
import { cfgMcpStartupTimeoutMs } from "../../mcp/settings";
import { cfgTtsrJudge } from "../../export/ttsr-settings";
import { cfgEditAutoRepairEnabled } from "../../edit/settings";
import { cfgPlanAutosave, cfgPlanAutosaveDir } from "../../plan-mode/settings";
import { cfgTaskAgentServiceTierOverrides, cfgTaskEnableEffort, cfgTaskMaxEffort } from "../../task/settings";
import { cfgImagesQuestionTimeoutMs, cfgToolsSpeculativeExecutionEnabled } from "../../tools/settings";
import { isServiceTierInheritSettingValue } from "../../config/service-tier";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type AgentSession } from "../../session/agent-session";
import { isCompactionMethod, type CompactionMethod } from "../../session/compaction-methods";
const SETTING_HANDLES = {
	"providers.cacheWarming": cfgProvidersCacheWarming,
	"task.speculativeLaunch": cfgTaskSpeculativeLaunch,
	"providers.openaiLiveSteering": cfgProvidersOpenaiLiveSteering,
	"telemetry.otlpExportEnabled": cfgTelemetryOtlpExportEnabled,
	"advisor.evictStaleResults": cfgAdvisorEvictStaleResults,
	"task.agentCompactionThresholdOverrides": cfgTaskAgentCompactionThresholdOverrides,
	"mnemopi.scoping": cfgMnemopiScoping,
	"tier.openai": cfgTierOpenai,
	"tier.anthropic": cfgTierAnthropic,
	"tier.google": cfgTierGoogle,
	"tier.subagent": cfgTierSubagent,
	"tier.advisor": cfgTierAdvisor,
	"codexResets.autoRedeem": cfgCodexResetsAutoRedeem,
	"codexResets.minBlockedMinutes": cfgCodexResetsMinBlockedMinutes,
	"codexResets.keepCredits": cfgCodexResetsKeepCredits,
	"codexResets.salvageHorizonHours": cfgCodexResetsSalvageHorizonHours,
	"ida.enabled": cfgIdaEnabled,
	"ida.python": cfgIdaPython,
	"ida.installDir": cfgIdaInstallDir,
	"ida.maxOpen": cfgIdaMaxOpen,
	"ida.idleCloseSec": cfgIdaIdleCloseSec,
	"spelling.autocomplete": cfgSpellingAutocomplete,

	"claudeResets.autoRedeem": cfgClaudeResetsAutoRedeem,
	"claudeResets.minBlockedMinutes": cfgClaudeResetsMinBlockedMinutes,
	"claudeResets.keepCredits": cfgClaudeResetsKeepCredits,
	"claudeResets.salvageHorizonHours": cfgClaudeResetsSalvageHorizonHours,
	"mcp.startupTimeoutMs": cfgMcpStartupTimeoutMs,
	"ttsr.judge": cfgTtsrJudge,
	"edit.autoRepair.enabled": cfgEditAutoRepairEnabled,
	"features.unexpectedStopDetection": cfgFeaturesUnexpectedStopDetection,
	extendedContext: cfgExtendedContext,
	"compaction.asyncEnabled": cfgCompactionAsyncEnabled,
	"compaction.methodOrder": cfgCompactionMethodOrder,
	"providers.openai-codex.codeMode": cfgProvidersOpenaiCodexCodeMode,
	"plan.autosave": cfgPlanAutosave,
	"plan.autosaveDir": cfgPlanAutosaveDir,
	"retry.waitForUsageReset": cfgRetryWaitForUsageReset,
	"compaction.experimentalContextManagement": cfgCompactionExperimentalContextManagement,
	"task.enableEffort": cfgTaskEnableEffort,
	"task.maxEffort": cfgTaskMaxEffort,
	"task.agentServiceTierOverrides": cfgTaskAgentServiceTierOverrides,
	"providers.autoThinkingMaxEffort": cfgProvidersAutoThinkingMaxEffort,
	"images.describeForTextModels": cfgImagesDescribeForTextModels,
	"images.questionTimeoutMs": cfgImagesQuestionTimeoutMs,
	"tools.speculativeExecution.enabled": cfgToolsSpeculativeExecutionEnabled,
} as const;
type SettingValue<K extends keyof typeof SETTING_HANDLES> = SettingValueOf<(typeof SETTING_HANDLES)[K]>;

/** Runtime settings intentionally exposed to the Studio Bridge. */
export const STUDIO_RUNTIME_SETTING_KEYS = [
	...GUI_SETTING_KEYS,
	"modelRoles.judge",
	"claudeResets.autoRedeem",
	"claudeResets.minBlockedMinutes",
	"claudeResets.keepCredits",
	"claudeResets.salvageHorizonHours",
	"mcp.startupTimeoutMs",
	"ttsr.judge",
	"edit.autoRepair.enabled",
	"features.unexpectedStopDetection",
	"extendedContext",
	"compaction.asyncEnabled",
	"compaction.methodOrder",
	"providers.openai-codex.codeMode",
	"plan.autosave",
	"plan.autosaveDir",
	"retry.waitForUsageReset",
	"compaction.experimentalContextManagement",
	"task.enableEffort",
	"task.maxEffort",
	"task.agentServiceTierOverrides",
	"providers.autoThinkingMaxEffort",
	"images.describeForTextModels",
	"images.questionTimeoutMs",
	"tools.speculativeExecution.enabled",
] as const;

export type StudioRuntimeSettingKey = (typeof STUDIO_RUNTIME_SETTING_KEYS)[number];

export interface StudioRuntimeSettingsSnapshot extends Required<GuiSettingsSnapshot> {
	"modelRoles.judge": string;
	"claudeResets.autoRedeem": SettingValue<"claudeResets.autoRedeem">;
	"claudeResets.minBlockedMinutes": SettingValue<"claudeResets.minBlockedMinutes">;
	"claudeResets.keepCredits": SettingValue<"claudeResets.keepCredits">;
	"claudeResets.salvageHorizonHours": SettingValue<"claudeResets.salvageHorizonHours">;
	"mcp.startupTimeoutMs": SettingValue<"mcp.startupTimeoutMs">;
	"ttsr.judge": SettingValue<"ttsr.judge">;
	"edit.autoRepair.enabled": boolean;
	"features.unexpectedStopDetection": "none" | "mechanical" | "smart";
	extendedContext: boolean;
	"compaction.asyncEnabled": boolean;
	"compaction.methodOrder": CompactionMethod[];
	"providers.openai-codex.codeMode": "off" | "on" | "auto";
	"plan.autosave": boolean;
	"plan.autosaveDir": string;
	"retry.waitForUsageReset": boolean;
	"compaction.experimentalContextManagement": boolean;
	"task.enableEffort": boolean;
	"task.maxEffort": SettingValue<"task.maxEffort">;
	"task.agentServiceTierOverrides": SettingValue<"task.agentServiceTierOverrides">;
	"providers.autoThinkingMaxEffort": SettingValue<"providers.autoThinkingMaxEffort">;
	"images.describeForTextModels": boolean;
	"images.questionTimeoutMs": number;
	"tools.speculativeExecution.enabled": boolean;
}

export interface StudioRuntimeSettingsActivation {
	sources?: Partial<Record<StudioRuntimeSettingKey, "env" | "runtime" | "overlay" | "project" | "global" | "default">>;
	configured: Partial<StudioRuntimeSettingsSnapshot>;
	restartRequired: StudioRuntimeSettingKey[];
}

export type StudioRuntimeSettingValue = StudioRuntimeSettingsSnapshot[StudioRuntimeSettingKey];

export class StudioRuntimeSettingsError extends Error {
	constructor(
		readonly code: "INVALID_ARGUMENT" | "COMMAND_BLOCKED",
		message: string,
	) {
		super(message);
		this.name = "StudioRuntimeSettingsError";
	}
}

export function isStudioRuntimeSettingKey(value: unknown): value is StudioRuntimeSettingKey {
	return typeof value === "string" && (STUDIO_RUNTIME_SETTING_KEYS as readonly string[]).includes(value);
}

/** Validate the exact schema-backed value before it reaches Settings. */
export function isStudioRuntimeSettingValue(
	key: StudioRuntimeSettingKey,
	value: unknown,
): value is StudioRuntimeSettingValue {
	if (isGuiSettingKey(key)) { try { validateGuiSetting(key,value); return true; } catch { return false; } }
	switch (key) {
		case "modelRoles.judge":
			return typeof value === "string" && value.length <= 4096 && !/[\u0000-\u001f]/u.test(value);
		case "edit.autoRepair.enabled":
		case "extendedContext":
		case "compaction.asyncEnabled":
		case "plan.autosave":
		case "retry.waitForUsageReset":
		case "task.enableEffort":
		case "images.describeForTextModels":
		case "tools.speculativeExecution.enabled":
		case "compaction.experimentalContextManagement":
			return typeof value === "boolean";
		case "claudeResets.minBlockedMinutes":
		case "claudeResets.keepCredits":
		case "claudeResets.salvageHorizonHours":
		case "mcp.startupTimeoutMs":
		case "images.questionTimeoutMs":
			return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
		case "task.agentServiceTierOverrides":
			return (
				isRecord(value) &&
				Object.keys(value).length <= 256 &&
				Object.entries(value).every(
					([name, tier]) =>
						name.trim().length > 0 &&
						name.length <= 256 &&
						!/[\u0000-\u001f]/u.test(name) &&
						!["__proto__", "constructor", "prototype"].includes(name) &&
						isServiceTierInheritSettingValue(tier),
				)
			);
		case "plan.autosaveDir":
			return typeof value === "string" && value.length <= 4096 && !value.includes("\0");
		case "claudeResets.autoRedeem":
		case "ttsr.judge":
		case "task.maxEffort":
		case "providers.autoThinkingMaxEffort":
		case "features.unexpectedStopDetection":
		case "providers.openai-codex.codeMode":
			return typeof value === "string" && SETTING_HANDLES[key].enumValues?.includes(value) === true;
		case "compaction.methodOrder":
			return (
				Array.isArray(value) &&
				value.length > 0 &&
				value.every(isCompactionMethod) &&
				new Set(value).size === value.length
			);
	}
}

function assertKey(key: string): asserts key is StudioRuntimeSettingKey {
	if (!isStudioRuntimeSettingKey(key))
		throw new StudioRuntimeSettingsError("INVALID_ARGUMENT", "Unsupported Runtime setting");
}

function assertValue(key: StudioRuntimeSettingKey, value: unknown): asserts value is StudioRuntimeSettingValue {
	if (!isStudioRuntimeSettingValue(key, value)) {
		throw new StudioRuntimeSettingsError("INVALID_ARGUMENT", `Invalid value for Runtime setting ${key}`);
	}
}

function cloneValue(value: StudioRuntimeSettingValue): StudioRuntimeSettingValue {
	return structuredClone(value);
}

/** Narrow bridge-facing access to the public Settings get/set/override API. */
export class StudioRuntimeSettingsService {
	#settings: AgentSession["settings"];
	#notesEffective: boolean;
	#notesConfigured: boolean;

	constructor(readonly session: AgentSession) {
		this.#settings = session.settings;
		this.#notesEffective = cfgCompactionExperimentalContextManagement.get(session.settings) === true;
		this.#notesConfigured = this.#notesEffective;
	}

	#syncSession(): void {
		if (this.#settings === this.session.settings) return;
		const pending = this.#notesConfigured !== this.#notesEffective;
		this.#settings = this.session.settings;
		this.#notesEffective = cfgCompactionExperimentalContextManagement.get(this.#settings) === true;
		if (!pending) this.#notesConfigured = this.#notesEffective;
	}

	activation(): StudioRuntimeSettingsActivation {
		this.#syncSession();
		return {
			configured: { "compaction.experimentalContextManagement": this.#notesConfigured },
			sources: Object.fromEntries(STUDIO_RUNTIME_SETTING_KEYS.map(key => [key, key === "modelRoles.judge" ? cfgModelRoles.provenance(this.session.settings) : SETTING_HANDLES[key].provenance(this.session.settings)])),
			restartRequired:
				this.#notesConfigured === this.#notesEffective ? [] : ["compaction.experimentalContextManagement"],
		};
	}

	snapshot(): StudioRuntimeSettingsSnapshot {
		this.#syncSession();
		return {
			...Object.fromEntries(GUI_SETTING_KEYS.map(key => [key, structuredClone(SETTING_HANDLES[key].get(this.session.settings))])) as Required<GuiSettingsSnapshot>,
			"modelRoles.judge": this.session.settings.getModelRoles().judge ?? "",
			"claudeResets.autoRedeem": cfgClaudeResetsAutoRedeem.get(this.session.settings),
			"claudeResets.minBlockedMinutes": cfgClaudeResetsMinBlockedMinutes.get(this.session.settings),
			"claudeResets.keepCredits": cfgClaudeResetsKeepCredits.get(this.session.settings),
			"claudeResets.salvageHorizonHours": cfgClaudeResetsSalvageHorizonHours.get(this.session.settings),
			"mcp.startupTimeoutMs": cfgMcpStartupTimeoutMs.get(this.session.settings),
			"ttsr.judge": cfgTtsrJudge.get(this.session.settings),
			"edit.autoRepair.enabled": cfgEditAutoRepairEnabled.get(this.session.settings),
			"features.unexpectedStopDetection": cfgFeaturesUnexpectedStopDetection.get(this.session.settings),
			extendedContext: cfgExtendedContext.get(this.session.settings),
			"compaction.asyncEnabled": cfgCompactionAsyncEnabled.get(this.session.settings),
			"compaction.methodOrder": [...cfgCompactionMethodOrder.get(this.session.settings)],
			"providers.openai-codex.codeMode": cfgProvidersOpenaiCodexCodeMode.get(this.session.settings),
			"plan.autosave": cfgPlanAutosave.get(this.session.settings),
			"plan.autosaveDir": cfgPlanAutosaveDir.get(this.session.settings) ?? "",
			"retry.waitForUsageReset": cfgRetryWaitForUsageReset.get(this.session.settings),
			"compaction.experimentalContextManagement": this.#notesEffective,
			"task.enableEffort": structuredClone(cfgTaskEnableEffort.get(this.session.settings)),
			"task.maxEffort": structuredClone(cfgTaskMaxEffort.get(this.session.settings)),
			"task.agentServiceTierOverrides": structuredClone(cfgTaskAgentServiceTierOverrides.get(this.session.settings)),
			"providers.autoThinkingMaxEffort": structuredClone(
				cfgProvidersAutoThinkingMaxEffort.get(this.session.settings),
			),
			"images.describeForTextModels": structuredClone(cfgImagesDescribeForTextModels.get(this.session.settings)),
			"images.questionTimeoutMs": structuredClone(cfgImagesQuestionTimeoutMs.get(this.session.settings)),
			"tools.speculativeExecution.enabled": structuredClone(
				cfgToolsSpeculativeExecutionEnabled.get(this.session.settings),
			),
		};
	}

	get(keys?: readonly string[]): {
		values: Partial<StudioRuntimeSettingsSnapshot>;
		activation?: StudioRuntimeSettingsActivation;
	} {
		const selected = keys === undefined ? STUDIO_RUNTIME_SETTING_KEYS : keys;
		const values: Partial<StudioRuntimeSettingsSnapshot> = {};
		const snapshot = this.snapshot();
		for (const key of selected) {
			assertKey(key);
			(values as Record<string, StudioRuntimeSettingValue>)[key] = cloneValue(snapshot[key]);
		}
		return {
			values,
			activation: this.activation(),
		};
	}

	async set(
		key: string,
		value: unknown,
		persist: boolean,
	): Promise<{
		key: StudioRuntimeSettingKey;
		value: StudioRuntimeSettingValue;
		persisted: boolean;
		effectiveValue?: StudioRuntimeSettingValue;
		restartRequired?: boolean;
	}> {
		assertKey(key);
		if (typeof persist !== "boolean") {
			throw new StudioRuntimeSettingsError("INVALID_ARGUMENT", "Runtime setting persistence flag must be boolean");
		}
		assertValue(key, value);
		if (key === "compaction.experimentalContextManagement") {
			if (!persist)
				throw new StudioRuntimeSettingsError(
					"COMMAND_BLOCKED",
					"This experimental setting must be saved and requires a Runtime restart",
				);
			this.#syncSession();
			const previous = this.#notesConfigured;
			cfgCompactionExperimentalContextManagement.override(this.#settings, this.#notesEffective);
			cfgCompactionExperimentalContextManagement.set(this.#settings, value as boolean);
			try {
				await this.#settings.flush();
			} catch (error) {
				cfgCompactionExperimentalContextManagement.set(this.#settings, previous);
				throw error;
			}
			this.#notesConfigured = value as boolean;
			return {
				key,
				value,
				persisted: true,
				effectiveValue: this.#notesEffective,
				restartRequired: this.#notesConfigured !== this.#notesEffective,
			};
		}
		this.#apply(key, value, persist);
		if (persist) await this.session.settings.flush();
		return { key, value: cloneValue(value), persisted: persist };
	}

	#apply(key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist: boolean): void {
		const settings = this.session.settings;
		if (key === "modelRoles.judge") {
			if (persist) settings.setModelRole("judge", (value as string).trim() || undefined);
			else settings.overrideModelRoles({ ...settings.getModelRoles(), judge: value as string });
			return;
		}
		// assertValue validated this exact key/value pair before the heterogeneous setter dispatch.
		const handle = SETTING_HANDLES[key];
		if (persist) {
			handle.clearOverride(settings);
			handle.set(settings, value as never);
		} else {
			handle.override(settings, value as never);
		}
	}
}
