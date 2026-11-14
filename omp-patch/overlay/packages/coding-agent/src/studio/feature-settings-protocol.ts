import type { SessionCompactionState } from "./session-compaction-protocol";
/** Additive settings surface for Runtime 18.10; the published settings payload stays unchanged. */
export const FEATURE_SETTING_KEYS = [
	"magicKeywords.enabled",
	"magicKeywords.chillax",
	"out.enabled",
	"btw.inject",
	"composer.predictionAlternatives",
	"display.shellVisualization",
	"title.refreshAfterPrompts",
	"display.advisorCollapsedLines",
	"task.steps",
	"task.autoParallel",
	"task.perCallModel",
	"task.perCallModelAllow",
	"task.workerThreads",
	"ovnfs.path",
	"prewalk.from",
	"prewalk.into",
	"retry.rateLimitWalksChain",
	"providers.openaiResponsesWebsockets",
	"providers.openai-codex.daybreak",
	"judgment.attemptTimeoutMs",
	"skills.manualSkills",
	"hindsight.globalScope",
	"tools.xdevNotices",
	"spotlight.experiment.enabled",
	"spotlight.url",
	"spotlight.model",
	"spotlight.thinking",
	"spotlight.timeoutMs",
	"spotlight.experiment.holdout",
	"spotlight.experiment.scoreFree",
	"spotlight.experiment.tools",

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
	"computer.enabled",
	"computer.display",
	"computer.maxWidth",
	"computer.maxHeight",
	"computer.backgroundFallback",
	"tools.restrictedFolders",
	"extensionHandlers.modeControl",
	"recap.enabled",
	"recap.idleSeconds",
	"compaction.idleEnabled",
	"compaction.idleThresholdTokens",
	"compaction.idleTimeoutSeconds",
	"gc.autoCompress",
	"session.worktreeScope",
	"stt.enabled",
	"stt.language",
	"stt.submitTrigger",
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
export type ProviderAccountPools = Record<string, string[]>;
export type AgentAccountPools = Record<string, ProviderAccountPools | null>;
export interface AgentAccountPoolState {
	global: AgentAccountPools;
	effective: AgentAccountPools;
}
export interface CompactionPreview {
	valid: boolean;
	summary?: string;
	window?: number;
	trigger?: number;
	extended: boolean;
}
export type FeatureSettingsOperation =
	| { kind: "session.compaction.get"; sessionId: string }
	| { kind: "session.compaction.set"; sessionId: string; input: string }
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
	| { kind: "accounts.pool.get"; sessionId: string }
	| { kind: "accounts.pool.set"; sessionId: string; agent: string; pools: ProviderAccountPools | null }
	| { kind: "models.compaction.preview"; sessionId: string; selector: string; input: string }
	| { kind: "models.compaction.set"; sessionId: string; selector: string; input: string; confirmed?: boolean };
export interface FeatureSettingsResultMap {
	"session.compaction.get": SessionCompactionState;
	"session.compaction.set": SessionCompactionState;
	"preferences.features.get": { settings: FeatureSettingRow[] };
	"preferences.features.set": FeatureSettingRow;
	"preferences.features.clearOverride": FeatureSettingRow;
	"accounts.pool.options": { accounts: PoolAccountOption[]; truncated: boolean };
	"accounts.pool.get": AgentAccountPoolState;
	"accounts.pool.set": AgentAccountPoolState;
	"models.compaction.preview": CompactionPreview;
	"models.compaction.set": { saved: boolean; confirmationRequired: boolean; summary: string };
}
export const FEATURE_SETTINGS_KINDS = [
	"session.compaction.get",
	"session.compaction.set",
	"preferences.features.get",
	"preferences.features.set",
	"preferences.features.clearOverride",
	"accounts.pool.options",
	"accounts.pool.get",
	"accounts.pool.set",
	"models.compaction.preview",
	"models.compaction.set",
] as const;
export const FEATURE_SETTINGS_READ_KINDS = [
	"session.compaction.get",
	"preferences.features.get",
	"accounts.pool.options",
	"accounts.pool.get",
	"models.compaction.preview",
] as const;
export function isFeatureSettingsKind(kind: string): kind is FeatureSettingsOperation["kind"] {
	return (FEATURE_SETTINGS_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid feature settings payload");
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
	if (
		(value as FeatureSettingsOperation)?.kind === "accounts.pool.get" ||
		(value as FeatureSettingsOperation)?.kind === "accounts.pool.set"
	)
		return;
	if (
		(value as FeatureSettingsOperation)?.kind === "session.compaction.get" ||
		(value as FeatureSettingsOperation)?.kind === "session.compaction.set"
	)
		return;
	const row = record(value);
	if (typeof row.kind !== "string" || !isFeatureSettingsKind(row.kind))
		throw Error("Unknown feature settings operation");
	text(row.sessionId, 128);
	if (row.kind === "models.compaction.set") {
		text(row.selector);
		text(row.input, 64, true);
		if (row.confirmed !== undefined && typeof row.confirmed !== "boolean") throw Error("Invalid confirmation");
		return;
	}
	if (row.kind === "models.compaction.preview") {
		text(row.selector);
		text(row.input, 64, true);
		return;
	}
	if (row.kind === "preferences.features.get" || row.kind === "accounts.pool.options") {
		return;
	}
	if (!(FEATURE_SETTING_KEYS as readonly unknown[]).includes(row.key)) throw Error("Unknown feature setting");
	if (row.kind === "preferences.features.clearOverride") {
		return;
	}
	if (row.scope !== "session" && row.scope !== "global") throw Error("Invalid settings scope");
	validateFeatureSettingValue(row.value);
	if (JSON.stringify(row.value).length > 32768) throw Error("Setting exceeds limit");
}
