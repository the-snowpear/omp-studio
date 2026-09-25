import { isServiceTierInheritSettingValue } from "../../config/service-tier";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getEnumValues, type SettingPath, type SettingValue } from "../../config/settings-schema";
import type { AgentSession } from "../../session/agent-session";
import { type CompactionMethod, isCompactionMethod } from "../../session/compaction-methods";

/** Runtime settings intentionally exposed to the Studio Bridge. */
export const STUDIO_RUNTIME_SETTING_KEYS = [
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

export interface StudioRuntimeSettingsSnapshot {
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
			return typeof value === "string" && getEnumValues(key)?.includes(value) === true;
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
		this.#notesEffective = session.settings.get("compaction.experimentalContextManagement") === true;
		this.#notesConfigured = this.#notesEffective;
	}

	#syncSession(): void {
		if (this.#settings === this.session.settings) return;
		const pending = this.#notesConfigured !== this.#notesEffective;
		this.#settings = this.session.settings;
		this.#notesEffective = this.#settings.get("compaction.experimentalContextManagement") === true;
		if (!pending) this.#notesConfigured = this.#notesEffective;
	}

	activation(): StudioRuntimeSettingsActivation {
		this.#syncSession();
		return {
			configured: { "compaction.experimentalContextManagement": this.#notesConfigured },
			restartRequired:
				this.#notesConfigured === this.#notesEffective ? [] : ["compaction.experimentalContextManagement"],
		};
	}

	snapshot(): StudioRuntimeSettingsSnapshot {
		this.#syncSession();
		return {
			"modelRoles.judge": this.session.settings.getModelRoles().judge ?? "",
			"claudeResets.autoRedeem": this.session.settings.get("claudeResets.autoRedeem"),
			"claudeResets.minBlockedMinutes": this.session.settings.get("claudeResets.minBlockedMinutes"),
			"claudeResets.keepCredits": this.session.settings.get("claudeResets.keepCredits"),
			"claudeResets.salvageHorizonHours": this.session.settings.get("claudeResets.salvageHorizonHours"),
			"mcp.startupTimeoutMs": this.session.settings.get("mcp.startupTimeoutMs"),
			"ttsr.judge": this.session.settings.get("ttsr.judge"),
			"edit.autoRepair.enabled": this.session.settings.get("edit.autoRepair.enabled"),
			"features.unexpectedStopDetection": this.session.settings.get("features.unexpectedStopDetection"),
			extendedContext: this.session.settings.get("extendedContext"),
			"compaction.asyncEnabled": this.session.settings.get("compaction.asyncEnabled"),
			"compaction.methodOrder": [...this.session.settings.get("compaction.methodOrder")],
			"providers.openai-codex.codeMode": this.session.settings.get("providers.openai-codex.codeMode"),
			"plan.autosave": this.session.settings.get("plan.autosave"),
			"plan.autosaveDir": this.session.settings.get("plan.autosaveDir") ?? "",
			"retry.waitForUsageReset": this.session.settings.get("retry.waitForUsageReset"),
			"compaction.experimentalContextManagement": this.#notesEffective,
			"task.enableEffort": structuredClone(this.session.settings.get("task.enableEffort")),
			"task.maxEffort": structuredClone(this.session.settings.get("task.maxEffort")),
			"task.agentServiceTierOverrides": structuredClone(this.session.settings.get("task.agentServiceTierOverrides")),
			"providers.autoThinkingMaxEffort": structuredClone(
				this.session.settings.get("providers.autoThinkingMaxEffort"),
			),
			"images.describeForTextModels": structuredClone(this.session.settings.get("images.describeForTextModels")),
			"images.questionTimeoutMs": structuredClone(this.session.settings.get("images.questionTimeoutMs")),
			"tools.speculativeExecution.enabled": structuredClone(
				this.session.settings.get("tools.speculativeExecution.enabled"),
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
			...(selected.includes("compaction.experimentalContextManagement") ? { activation: this.activation() } : {}),
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
			this.#settings.override(key, this.#notesEffective);
			this.#settings.set(key, value as boolean);
			try {
				await this.#settings.flush();
			} catch (error) {
				this.#settings.set(key, previous);
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
		if (persist) settings.clearOverride(key as SettingPath);
		switch (key) {
			case "claudeResets.autoRedeem":
				return persist
					? settings.set(key, value as SettingValue<"claudeResets.autoRedeem">)
					: settings.override(key, value as SettingValue<"claudeResets.autoRedeem">);
			case "claudeResets.minBlockedMinutes":
				return persist
					? settings.set(key, value as SettingValue<"claudeResets.minBlockedMinutes">)
					: settings.override(key, value as SettingValue<"claudeResets.minBlockedMinutes">);
			case "claudeResets.keepCredits":
				return persist
					? settings.set(key, value as SettingValue<"claudeResets.keepCredits">)
					: settings.override(key, value as SettingValue<"claudeResets.keepCredits">);
			case "claudeResets.salvageHorizonHours":
				return persist
					? settings.set(key, value as SettingValue<"claudeResets.salvageHorizonHours">)
					: settings.override(key, value as SettingValue<"claudeResets.salvageHorizonHours">);
			case "mcp.startupTimeoutMs":
				return persist
					? settings.set(key, value as SettingValue<"mcp.startupTimeoutMs">)
					: settings.override(key, value as SettingValue<"mcp.startupTimeoutMs">);
			case "ttsr.judge":
				return persist
					? settings.set(key, value as SettingValue<"ttsr.judge">)
					: settings.override(key, value as SettingValue<"ttsr.judge">);
			case "task.enableEffort":
				return persist
					? settings.set(key, value as SettingValue<"task.enableEffort">)
					: settings.override(key, value as SettingValue<"task.enableEffort">);
			case "task.maxEffort":
				return persist
					? settings.set(key, value as SettingValue<"task.maxEffort">)
					: settings.override(key, value as SettingValue<"task.maxEffort">);
			case "task.agentServiceTierOverrides":
				return persist
					? settings.set(key, value as SettingValue<"task.agentServiceTierOverrides">)
					: settings.override(key, value as SettingValue<"task.agentServiceTierOverrides">);
			case "providers.autoThinkingMaxEffort":
				return persist
					? settings.set(key, value as SettingValue<"providers.autoThinkingMaxEffort">)
					: settings.override(key, value as SettingValue<"providers.autoThinkingMaxEffort">);
			case "images.describeForTextModels":
				return persist
					? settings.set(key, value as SettingValue<"images.describeForTextModels">)
					: settings.override(key, value as SettingValue<"images.describeForTextModels">);
			case "images.questionTimeoutMs":
				return persist
					? settings.set(key, value as SettingValue<"images.questionTimeoutMs">)
					: settings.override(key, value as SettingValue<"images.questionTimeoutMs">);
			case "tools.speculativeExecution.enabled":
				return persist
					? settings.set(key, value as SettingValue<"tools.speculativeExecution.enabled">)
					: settings.override(key, value as SettingValue<"tools.speculativeExecution.enabled">);
			case "plan.autosave":
			case "retry.waitForUsageReset":
				return persist ? settings.set(key, value as boolean) : settings.override(key, value as boolean);
			case "plan.autosaveDir":
				return persist ? settings.set(key, value as string) : settings.override(key, value as string);
			case "edit.autoRepair.enabled":
				return persist
					? settings.set(key, value as SettingValue<"edit.autoRepair.enabled">)
					: settings.override(key, value as SettingValue<"edit.autoRepair.enabled">);
			case "features.unexpectedStopDetection":
				return persist
					? settings.set(key, value as SettingValue<"features.unexpectedStopDetection">)
					: settings.override(key, value as SettingValue<"features.unexpectedStopDetection">);
			case "extendedContext":
				return persist
					? settings.set(key, value as SettingValue<"extendedContext">)
					: settings.override(key, value as SettingValue<"extendedContext">);
			case "compaction.asyncEnabled":
				return persist
					? settings.set(key, value as SettingValue<"compaction.asyncEnabled">)
					: settings.override(key, value as SettingValue<"compaction.asyncEnabled">);
			case "compaction.methodOrder":
				return persist
					? settings.set(key, value as SettingValue<"compaction.methodOrder">)
					: settings.override(key, value as SettingValue<"compaction.methodOrder">);
			case "providers.openai-codex.codeMode":
				return persist
					? settings.set(key, value as SettingValue<"providers.openai-codex.codeMode">)
					: settings.override(key, value as SettingValue<"providers.openai-codex.codeMode">);
		}
	}
}
