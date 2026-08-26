import { getEnumValues, type SettingPath, type SettingValue } from "../../config/settings-schema";
import type { AgentSession } from "../../session/agent-session";
import { type CompactionMethod, isCompactionMethod } from "../../session/compaction-methods";

/** Runtime settings intentionally exposed to the Studio Bridge. */
export const STUDIO_RUNTIME_SETTING_KEYS = [
	"edit.autoRepair.enabled",
	"features.unexpectedStopDetection",
	"providers.unexpectedStopModel",
	"extendedContext",
	"compaction.asyncEnabled",
	"compaction.methodOrder",
	"providers.openai-codex.codeMode",
] as const;

export type StudioRuntimeSettingKey = (typeof STUDIO_RUNTIME_SETTING_KEYS)[number];

export interface StudioRuntimeSettingsSnapshot {
	"edit.autoRepair.enabled": boolean;
	"features.unexpectedStopDetection": "none" | "mechanical" | "smart";
	"providers.unexpectedStopModel": string;
	extendedContext: boolean;
	"compaction.asyncEnabled": boolean;
	"compaction.methodOrder": CompactionMethod[];
	"providers.openai-codex.codeMode": "off" | "on" | "auto";
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
		case "edit.autoRepair.enabled":
		case "extendedContext":
		case "compaction.asyncEnabled":
			return typeof value === "boolean";
		case "features.unexpectedStopDetection":
		case "providers.unexpectedStopModel":
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
	return Array.isArray(value) ? [...value] : value;
}

/** Narrow bridge-facing access to the public Settings get/set/override API. */
export class StudioRuntimeSettingsService {
	constructor(readonly session: AgentSession) {}

	snapshot(): StudioRuntimeSettingsSnapshot {
		return {
			"edit.autoRepair.enabled": this.session.settings.get("edit.autoRepair.enabled"),
			"features.unexpectedStopDetection": this.session.settings.get("features.unexpectedStopDetection"),
			"providers.unexpectedStopModel": this.session.settings.get("providers.unexpectedStopModel"),
			extendedContext: this.session.settings.get("extendedContext"),
			"compaction.asyncEnabled": this.session.settings.get("compaction.asyncEnabled"),
			"compaction.methodOrder": [...this.session.settings.get("compaction.methodOrder")],
			"providers.openai-codex.codeMode": this.session.settings.get("providers.openai-codex.codeMode"),
		};
	}

	get(keys?: readonly string[]): { values: Partial<StudioRuntimeSettingsSnapshot> } {
		const selected = keys === undefined ? STUDIO_RUNTIME_SETTING_KEYS : keys;
		const values: Partial<StudioRuntimeSettingsSnapshot> = {};
		const snapshot = this.snapshot();
		for (const key of selected) {
			assertKey(key);
			(values as Record<string, StudioRuntimeSettingValue>)[key] = cloneValue(snapshot[key]);
		}
		return { values };
	}

	async set(
		key: string,
		value: unknown,
		persist: boolean,
	): Promise<{
		key: StudioRuntimeSettingKey;
		value: StudioRuntimeSettingValue;
		persisted: boolean;
	}> {
		assertKey(key);
		if (typeof persist !== "boolean") {
			throw new StudioRuntimeSettingsError("INVALID_ARGUMENT", "Runtime setting persistence flag must be boolean");
		}
		assertValue(key, value);
		this.#apply(key, value, persist);
		if (persist) await this.session.settings.flush();
		return { key, value: cloneValue(value), persisted: persist };
	}

	#apply(key: StudioRuntimeSettingKey, value: StudioRuntimeSettingValue, persist: boolean): void {
		const settings = this.session.settings;
		if (persist) settings.clearOverride(key as SettingPath);
		switch (key) {
			case "edit.autoRepair.enabled":
				return persist
					? settings.set(key, value as SettingValue<"edit.autoRepair.enabled">)
					: settings.override(key, value as SettingValue<"edit.autoRepair.enabled">);
			case "features.unexpectedStopDetection":
				return persist
					? settings.set(key, value as SettingValue<"features.unexpectedStopDetection">)
					: settings.override(key, value as SettingValue<"features.unexpectedStopDetection">);
			case "providers.unexpectedStopModel":
				return persist
					? settings.set(key, value as SettingValue<"providers.unexpectedStopModel">)
					: settings.override(key, value as SettingValue<"providers.unexpectedStopModel">);
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
