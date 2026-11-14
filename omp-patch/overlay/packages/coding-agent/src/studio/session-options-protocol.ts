export type StudioSpeed = "normal" | "fast" | "ultrafast" | "slow";
export type StudioSettingScope = "default" | "env" | "global" | "project" | "overlay" | "runtime";
export interface SessionSpeedState {
	model: string | null;
	selected: StudioSpeed;
	supported: StudioSpeed[];
	effectiveTier?: string;
	fastActive: boolean;
	slowEnabled: boolean;
	slowScope?: "session" | "global";
	usageLimit?: {
		stage: "wrap_up" | "low_priority";
		resetsAtSec?: number;
		allowanceLeftPercent?: number;
		extraUsage?: boolean;
	};
}
export interface SessionWarmingState {
	mode: "off" | "streaming" | "idle";
	source: StudioSettingScope;
	state: "unavailable" | "inactive" | "scheduled" | "refreshing";
	reason?: string;
	nextWarmAt?: number;
	decision?: {
		phase: "streaming" | "idle";
		warmCost: number;
		missCost: number;
		expectedSavings: number;
		continuationProbability: number;
		economicsAvailable: boolean;
		action: "warm" | "stop";
	};
}
export interface ModelPresetRow {
	name: string;
	source: StudioSettingScope;
	active: boolean;
	roles: Record<string, string>;
	thinking?: string;
	error?: string;
}
export interface ModelPresetResult {
	outcome: "saved" | "deleted" | "missing" | "project" | "switched" | "invalid" | "unavailable" | "failed";
	reason?: string;
	model?: string;
	thinking?: string;
	shadowed?: Array<{ role: string; expected?: string; actual?: string; source: StudioSettingScope }>;
	shadowedThinking?: { expected: string; actual?: string; source: StudioSettingScope };
	shadowOwner?: StudioSettingScope;
}
export interface SessionBudgetState {
	treeSpent: number;
	warnCost: number | null;
	maxCost: number | null;
	limitReached: boolean;
	warnSource: StudioSettingScope;
	maxSource: StudioSettingScope;
}
export type SessionBudgetOperation =
	| { kind: "session.budget.get"; sessionId: string }
	| {
			kind: "session.budget.set";
			sessionId: string;
			warnCost: number | null;
			maxCost: number | null;
			scope: "session" | "global";
	  }
	| { kind: "session.budget.clearOverride"; sessionId: string };
export type SessionOptionsOperation =
	| SessionBudgetOperation
	| { kind: "session.speed.get"; sessionId: string }
	| { kind: "session.speed.set"; sessionId: string; expectedModel: string; speed: StudioSpeed }
	| { kind: "session.warming.get"; sessionId: string }
	| { kind: "session.warming.set"; sessionId: string; mode: SessionWarmingState["mode"]; persist: boolean }
	| { kind: "models.presets.list"; sessionId: string }
	| { kind: "models.presets.save"; sessionId: string; name: string }
	| { kind: "models.presets.apply"; sessionId: string; name: string }
	| { kind: "models.presets.delete"; sessionId: string; name: string };
export interface SessionOptionsResultMap {
	"session.budget.get": SessionBudgetState;
	"session.budget.set": SessionBudgetState;
	"session.budget.clearOverride": SessionBudgetState;
	"session.speed.get": SessionSpeedState;
	"session.speed.set": SessionSpeedState;
	"session.warming.get": SessionWarmingState;
	"session.warming.set": SessionWarmingState;
	"models.presets.list": { presets: ModelPresetRow[] };
	"models.presets.save": ModelPresetResult;
	"models.presets.apply": ModelPresetResult;
	"models.presets.delete": ModelPresetResult;
}
export const SESSION_OPTIONS_KINDS = [
	"session.budget.get",
	"session.budget.set",
	"session.budget.clearOverride",
	"session.speed.get",
	"session.speed.set",
	"session.warming.get",
	"session.warming.set",
	"models.presets.list",
	"models.presets.save",
	"models.presets.apply",
	"models.presets.delete",
] as const;
export function isSessionOptionsKind(kind: string): kind is SessionOptionsOperation["kind"] {
	return (SESSION_OPTIONS_KINDS as readonly string[]).includes(kind);
}
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid session options payload");
	return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): asserts value is string {
	if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
		throw new Error("Invalid session options text");
}
function choice(value: unknown, values: readonly string[]): void {
	if (typeof value !== "string" || !values.includes(value)) throw new Error("Invalid session options choice");
}
function bool(value: unknown): void {
	if (typeof value !== "boolean") throw new Error("Invalid session options boolean");
}
const speeds = ["normal", "fast", "ultrafast", "slow"];
export function validateSessionOptionsOperation(value: unknown): void {
	if (value && typeof value === "object" && "kind" in value && String(value.kind).startsWith("session.budget."))
		return;
	const input = record(value);
	text(input.kind);
	if (!isSessionOptionsKind(input.kind)) throw new Error("Unknown session options operation");
	text(input.sessionId, 512);
	if (!input.sessionId) throw new Error("Session identity required");
	const extra =
		input.kind === "session.speed.set"
			? ["expectedModel", "speed"]
			: input.kind === "session.warming.set"
				? ["mode", "persist"]
				: input.kind.startsWith("models.presets.") && input.kind !== "models.presets.list"
					? ["name"]
					: [];
	if (input.kind === "session.speed.set") {
		text(input.expectedModel);
		if (!input.expectedModel) throw new Error("Model identity required");
		choice(input.speed, speeds);
	}
	if (input.kind === "session.warming.set") {
		choice(input.mode, ["off", "streaming", "idle"]);
		bool(input.persist);
	}
	if (extra.includes("name")) {
		text(input.name, 128);
		if (!/^[a-zA-Z][\w-]*$/u.test(input.name as string)) throw new Error("Invalid preset name");
	}
}
