/** Additive settings surface for Runtime 18.10; the published settings payload stays unchanged. */
export const FEATURE_SETTING_KEYS = [
	"task.agentAccountPools",
	"compaction.modelThresholds",
	"retry.fallbackOn",
	"contextFiles.extra",
	"task.structured",
	"bash.gitGuard",
	"worktree.onStart",
	"worktree.onExit",
	"composer.predictions",
	"speech.speed",
	"tts.localSpeed",
	"gc.compress",
	"gc.compressAfterDays",
	"prewalk.auto",
	"prewalk.autoTarget",
	"async.widgets",
	"computer.backgroundFallback",
] as const;
export type FeatureSettingKey = (typeof FEATURE_SETTING_KEYS)[number];
export type FeatureSettingValue =
	| null
	| boolean
	| number
	| string
	| FeatureSettingValue[]
	| { [key: string]: FeatureSettingValue };
export interface FeatureSettingRow {
	key: FeatureSettingKey;
	value: FeatureSettingValue;
	source: "env" | "runtime" | "overlay" | "project" | "global" | "default";
}
export interface PoolAccountOption {
	provider: string;
	identityKey: string;
	label: string;
}
export interface CompactionPreview {
	valid: boolean;
	summary?: string;
	window?: number;
	trigger?: number;
	extended: boolean;
}
export type FeatureSettingsOperation =
	| { kind: "preferences.features.get"; sessionId: string }
	| {
			kind: "preferences.features.set";
			sessionId: string;
			key: FeatureSettingKey;
			value: FeatureSettingValue;
			scope: "session" | "global";
	  }
	| { kind: "preferences.features.clearOverride"; sessionId: string; key: FeatureSettingKey }
	| { kind: "accounts.pool.options"; sessionId: string }
	| { kind: "models.compaction.preview"; sessionId: string; selector: string; input: string }
	| { kind: "models.compaction.set"; sessionId: string; selector: string; input: string; confirmed?: boolean };
export interface FeatureSettingsResultMap {
	"preferences.features.get": { settings: FeatureSettingRow[] };
	"preferences.features.set": FeatureSettingRow;
	"preferences.features.clearOverride": FeatureSettingRow;
	"accounts.pool.options": { accounts: PoolAccountOption[]; truncated: boolean };
	"models.compaction.preview": CompactionPreview;
	"models.compaction.set": { saved: boolean; confirmationRequired: boolean; summary: string };
}
export const FEATURE_SETTINGS_KINDS = [
	"preferences.features.get",
	"preferences.features.set",
	"preferences.features.clearOverride",
	"accounts.pool.options",
	"models.compaction.preview",
	"models.compaction.set",
] as const;
export const FEATURE_SETTINGS_READ_KINDS = [
	"preferences.features.get",
	"accounts.pool.options",
	"models.compaction.preview",
] as const;
export function isFeatureSettingsKind(kind: string): kind is FeatureSettingsOperation["kind"] {
	return (FEATURE_SETTINGS_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw Error("Invalid feature settings payload");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 1024, empty = false): void {
	if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max || /[\u0000-\u001f]/u.test(value))
		throw Error("Invalid feature settings text");
}
export function validateFeatureSettingValue(value: unknown, depth = 0): asserts value is FeatureSettingValue {
	if (depth > 4) throw Error("Setting nesting exceeds limit");
	if (value === null || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100_000_000) return;
	if (typeof value === "string") {
		text(value, 4096, true);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > 256) throw Error("Too many setting entries");
		value.forEach(item => validateFeatureSettingValue(item, depth + 1));
		return;
	}
	if (value && typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length > 256) throw Error("Too many setting entries");
		for (const [key, item] of entries) {
			text(key);
			if (["__proto__", "constructor", "prototype"].includes(key)) throw Error("Invalid setting key");
			validateFeatureSettingValue(item, depth + 1);
		}
		return;
	}
	throw Error("Invalid setting value");
}
export function validateFeatureSettingsOperation(value: unknown): void {
	const row = record(value, ["kind", "sessionId", "key", "value", "scope", "selector", "input", "confirmed"]);
	if (typeof row.kind !== "string" || !isFeatureSettingsKind(row.kind))
		throw Error("Unknown feature settings operation");
	text(row.sessionId, 128);
	if (row.kind === "models.compaction.set") {
		record(value, ["kind", "sessionId", "selector", "input", "confirmed"]);
		text(row.selector);
		text(row.input, 64, true);
		if (row.confirmed !== undefined && typeof row.confirmed !== "boolean") throw Error("Invalid confirmation");
		return;
	}
	if (row.kind === "models.compaction.preview") {
		record(value, ["kind", "sessionId", "selector", "input"]);
		text(row.selector);
		text(row.input, 64, true);
		return;
	}
	if (row.kind === "preferences.features.get" || row.kind === "accounts.pool.options") {
		record(value, ["kind", "sessionId"]);
		return;
	}
	if (!(FEATURE_SETTING_KEYS as readonly unknown[]).includes(row.key)) throw Error("Unknown feature setting");
	if (row.kind === "preferences.features.clearOverride") {
		record(value, ["kind", "sessionId", "key"]);
		return;
	}
	record(value, ["kind", "sessionId", "key", "value", "scope"]);
	if (row.scope !== "session" && row.scope !== "global") throw Error("Invalid settings scope");
	validateFeatureSettingValue(row.value);
	if (JSON.stringify(row.value).length > 32768) throw Error("Setting exceeds limit");
}
function setting(value: unknown): void {
	const row = record(value, ["key", "value", "source"]);
	if (!(FEATURE_SETTING_KEYS as readonly unknown[]).includes(row.key)) throw Error("Unknown feature setting");
	if (!["env", "runtime", "overlay", "project", "global", "default"].includes(row.source as string))
		throw Error("Invalid setting source");
	validateFeatureSettingValue(row.value);
}
export function validateFeatureSettingsResult(kind: FeatureSettingsOperation["kind"], value: unknown): void {
	if (JSON.stringify(value).length > 131072) throw Error("Feature settings result exceeds limit");
	if (kind === "models.compaction.set") {
		const row = record(value, ["saved", "confirmationRequired", "summary"]);
		if (
			typeof row.saved !== "boolean" ||
			typeof row.confirmationRequired !== "boolean" ||
			row.saved === row.confirmationRequired
		)
			throw Error("Invalid compaction result");
		text(row.summary);
		return;
	}
	if (kind === "preferences.features.get") {
		const row = record(value, ["settings"]);
		if (!Array.isArray(row.settings) || row.settings.length > FEATURE_SETTING_KEYS.length)
			throw Error("Invalid settings list");
		row.settings.forEach(setting);
		return;
	}
	if (kind === "accounts.pool.options") {
		const row = record(value, ["accounts", "truncated"]);
		if (!Array.isArray(row.accounts) || row.accounts.length > 256 || typeof row.truncated !== "boolean")
			throw Error("Invalid account list");
		for (const item of row.accounts) {
			const account = record(item, ["provider", "identityKey", "label"]);
			text(account.provider);
			text(account.identityKey);
			text(account.label);
		}
		return;
	}
	if (kind === "models.compaction.preview") {
		const row = record(value, ["valid", "summary", "window", "trigger", "extended"]);
		if (typeof row.valid !== "boolean" || typeof row.extended !== "boolean")
			throw Error("Invalid compaction preview");
		if (row.summary !== undefined) text(row.summary);
		for (const key of ["window", "trigger"])
			if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || (row[key] as number) < 0))
				throw Error("Invalid compaction count");
		return;
	}
	setting(value);
}
