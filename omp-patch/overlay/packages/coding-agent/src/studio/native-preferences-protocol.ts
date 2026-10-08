export const NATIVE_PREFERENCE_KEYS = [
	"advisor.enabled",
	"advisor.reviewMode",
	"advisor.reviewInterval",
	"advisor.syncBacklog",
	"advisor.immuneTurns",
	"advisor.maxNotesPerUpdate",
	"advisor.evictStaleResults",
	"title.icons",
	"title.generator",
	"title.refreshOnReplan",
	"telemetry.otlpExportEnabled",
] as const;
export type NativePreferenceKey = (typeof NATIVE_PREFERENCE_KEYS)[number];
export type NativePreferenceValue = string | number | boolean;
export interface NativePreference {
	key: NativePreferenceKey;
	group: "advisor" | "titles" | "diagnostics";
	label: string;
	description: string;
	value: NativePreferenceValue;
	effective: NativePreferenceValue;
	source: "env" | "default" | "runtime" | "overlay" | "project" | "global";
	type: "boolean" | "number" | "enum";
	choices?: NativePreferenceValue[];
	restartRequired: boolean;
}
export type NativePreferenceOperation =
	| { kind: "preferences.native.get"; sessionId: string }
	| {
			kind: "preferences.native.set";
			sessionId: string;
			key: NativePreferenceKey;
			value: NativePreferenceValue;
			scope: "session" | "global";
	  }
	| { kind: "preferences.native.clearOverride"; sessionId: string; key: NativePreferenceKey };
export interface NativePreferenceResultMap {
	"preferences.native.get": { preferences: NativePreference[] };
	"preferences.native.set": NativePreference;
	"preferences.native.clearOverride": NativePreference;
}
export const NATIVE_PREFERENCE_KINDS = [
	"preferences.native.get",
	"preferences.native.set",
	"preferences.native.clearOverride",
] as const;
export function isNativePreferenceKind(kind: string): kind is NativePreferenceOperation["kind"] {
	return (NATIVE_PREFERENCE_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(key => !keys.includes(key))
	)
		throw new Error("Invalid native preference object");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): void {
	if (typeof value !== "string" || value.length > max || value.includes("\0"))
		throw new Error("Invalid preference text");
}
function primitive(value: unknown): void {
	if (typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000) return;
	if (typeof value === "string" && value.length <= 1024 && !value.includes("\0")) return;
	throw new Error("Invalid preference value");
}
export function validateNativePreferenceOperation(value: unknown): void {
	const row = record(value, ["kind", "sessionId", "key", "value", "scope"]);
	if (typeof row.kind !== "string" || !isNativePreferenceKind(row.kind))
		throw new Error("Unknown preference operation");
	text(row.sessionId, 512);
	if (!row.sessionId) throw new Error("Session required");
	if (row.kind === "preferences.native.get") {
		record(value, ["kind", "sessionId"]);
		return;
	}
	if (!(NATIVE_PREFERENCE_KEYS as readonly unknown[]).includes(row.key)) throw new Error("Unknown preference");
	if (row.kind === "preferences.native.clearOverride") {
		record(value, ["kind", "sessionId", "key"]);
		return;
	}
	primitive(row.value);
	if (row.scope !== "session" && row.scope !== "global") throw new Error("Invalid preference scope");
}
export function validateNativePreferenceResult(kind: NativePreferenceOperation["kind"], value: unknown): void {
	if (kind === "preferences.native.get") {
		const row = record(value, ["preferences"]);
		if (!Array.isArray(row.preferences) || row.preferences.length > NATIVE_PREFERENCE_KEYS.length)
			throw new Error("Too many preferences");
		for (const pref of row.preferences) validateNativePreferenceResult("preferences.native.set", pref);
		return;
	}
	const row = record(value, [
		"key",
		"group",
		"label",
		"description",
		"value",
		"effective",
		"source",
		"type",
		"choices",
		"restartRequired",
	]);
	if (
		!(NATIVE_PREFERENCE_KEYS as readonly unknown[]).includes(row.key) ||
		!["advisor", "titles", "diagnostics"].includes(String(row.group))
	)
		throw new Error("Invalid preference identity");
	text(row.label);
	text(row.description);
	primitive(row.value);
	primitive(row.effective);
	if (
		!["env", "default", "runtime", "overlay", "project", "global"].includes(String(row.source)) ||
		!["boolean", "number", "enum"].includes(String(row.type)) ||
		typeof row.restartRequired !== "boolean"
	)
		throw new Error("Invalid preference metadata");
	if (row.choices !== undefined) {
		if (!Array.isArray(row.choices) || row.choices.length > 32) throw new Error("Invalid preference choices");
		row.choices.forEach(primitive);
	}
}
