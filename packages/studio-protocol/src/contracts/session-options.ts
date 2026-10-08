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
  usageLimit?: { stage: "wrap_up" | "low_priority"; resetsAtSec?: number; allowanceLeftPercent?: number; extraUsage?: boolean };
}
export interface SessionWarmingState {
  mode: "off" | "streaming" | "idle";
  source: StudioSettingScope;
  state: "unavailable" | "inactive" | "scheduled" | "refreshing";
  reason?: string;
  nextWarmAt?: number;
  decision?: { phase: "streaming" | "idle"; warmCost: number; missCost: number; expectedSavings: number; continuationProbability: number; economicsAvailable: boolean; action: "warm" | "stop" };
}
export interface ModelPresetRow {
  name: string; source: StudioSettingScope; active: boolean;
  roles: Record<string, string>; thinking?: string; error?: string;
}
export interface ModelPresetResult {
  outcome: "saved" | "deleted" | "missing" | "project" | "switched" | "invalid" | "unavailable" | "failed";
  reason?: string; model?: string; thinking?: string;
  shadowed?: Array<{ role: string; expected?: string; actual?: string; source: StudioSettingScope }>;
  shadowedThinking?: { expected: string; actual?: string; source: StudioSettingScope };
  shadowOwner?: StudioSettingScope;
}
export type SessionOptionsOperation =
  | { kind: "session.speed.get"; sessionId: string }
  | { kind: "session.speed.set"; sessionId: string; expectedModel: string; speed: StudioSpeed }
  | { kind: "session.warming.get"; sessionId: string }
  | { kind: "session.warming.set"; sessionId: string; mode: SessionWarmingState["mode"]; persist: boolean }
  | { kind: "models.presets.list"; sessionId: string }
  | { kind: "models.presets.save"; sessionId: string; name: string }
  | { kind: "models.presets.apply"; sessionId: string; name: string }
  | { kind: "models.presets.delete"; sessionId: string; name: string };
export interface SessionOptionsResultMap {
  "session.speed.get": SessionSpeedState;
  "session.speed.set": SessionSpeedState;
  "session.warming.get": SessionWarmingState;
  "session.warming.set": SessionWarmingState;
  "models.presets.list": { presets: ModelPresetRow[] };
  "models.presets.save": ModelPresetResult;
  "models.presets.apply": ModelPresetResult;
  "models.presets.delete": ModelPresetResult;
}
export const SESSION_OPTIONS_KINDS = ["session.speed.get", "session.speed.set", "session.warming.get", "session.warming.set", "models.presets.list", "models.presets.save", "models.presets.apply", "models.presets.delete"] as const;
export function isSessionOptionsKind(kind: string): kind is SessionOptionsOperation["kind"] { return (SESSION_OPTIONS_KINDS as readonly string[]).includes(kind); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid session options payload");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 4096): asserts value is string { if (typeof value !== "string" || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw new Error("Invalid session options text"); }
function choice(value: unknown, values: readonly string[]): void { if (typeof value !== "string" || !values.includes(value)) throw new Error("Invalid session options choice"); }
function bool(value: unknown): void { if (typeof value !== "boolean") throw new Error("Invalid session options boolean"); }
function number(value: unknown): void { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid session options number"); }
const scopes = ["default", "env", "global", "project", "overlay", "runtime"];
const speeds = ["normal", "fast", "ultrafast", "slow"];
export function validateSessionOptionsOperation(value: unknown): void {
  const input = record(value, ["kind", "sessionId", "expectedModel", "speed", "mode", "persist", "name"]);
  text(input.kind); if (!isSessionOptionsKind(input.kind)) throw new Error("Unknown session options operation");
  text(input.sessionId, 512); if (!input.sessionId) throw new Error("Session identity required");
  const extra = input.kind === "session.speed.set" ? ["expectedModel", "speed"] : input.kind === "session.warming.set" ? ["mode", "persist"] : input.kind.startsWith("models.presets.") && input.kind !== "models.presets.list" ? ["name"] : [];
  record(input, ["kind", "sessionId", ...extra]);
  if (input.kind === "session.speed.set") { text(input.expectedModel); if (!input.expectedModel) throw new Error("Model identity required"); choice(input.speed, speeds); }
  if (input.kind === "session.warming.set") { choice(input.mode, ["off", "streaming", "idle"]); bool(input.persist); }
  if (extra.includes("name")) { text(input.name, 128); if (!/^[a-zA-Z][\w-]*$/u.test(input.name as string)) throw new Error("Invalid preset name"); }
}
export function validateSessionOptionsResult(kind: SessionOptionsOperation["kind"], value: unknown): void {
  if (kind.startsWith("session.speed.")) {
    const row = record(value, ["model", "selected", "supported", "effectiveTier", "fastActive", "slowEnabled", "slowScope", "usageLimit"]);
    if (row.model !== null) text(row.model); choice(row.selected, speeds);
    if (!Array.isArray(row.supported) || row.supported.length > 4) throw new Error("Invalid supported speeds"); row.supported.forEach(item => choice(item, speeds));
    bool(row.fastActive); bool(row.slowEnabled); if (row.effectiveTier !== undefined) text(row.effectiveTier, 64); if (row.slowScope !== undefined) choice(row.slowScope, ["session", "global"]);
    if (row.usageLimit !== undefined) { const usage = record(row.usageLimit, ["stage", "resetsAtSec", "allowanceLeftPercent", "extraUsage"]); choice(usage.stage, ["wrap_up", "low_priority"]); for (const key of ["resetsAtSec", "allowanceLeftPercent"]) if (usage[key] !== undefined) number(usage[key]); if (usage.extraUsage !== undefined) bool(usage.extraUsage); }
    return;
  }
  if (kind.startsWith("session.warming.")) {
    const row = record(value, ["mode", "source", "state", "reason", "nextWarmAt", "decision"]); choice(row.mode, ["off", "streaming", "idle"]); choice(row.source, scopes); choice(row.state, ["unavailable", "inactive", "scheduled", "refreshing"]);
    if (row.reason !== undefined) text(row.reason); if (row.nextWarmAt !== undefined) number(row.nextWarmAt);
    if (row.decision !== undefined) { const decision = record(row.decision, ["phase", "warmCost", "missCost", "expectedSavings", "continuationProbability", "economicsAvailable", "action"]); choice(decision.phase, ["streaming", "idle"]); choice(decision.action, ["warm", "stop"]); bool(decision.economicsAvailable); for (const key of ["warmCost", "missCost", "expectedSavings", "continuationProbability"]) number(decision[key]); }
    return;
  }
  if (kind === "models.presets.list") {
    const row = record(value, ["presets"]); if (!Array.isArray(row.presets) || row.presets.length > 200) throw new Error("Too many presets");
    for (const item of row.presets) { const preset = record(item, ["name", "source", "active", "roles", "thinking", "error"]); text(preset.name, 128); choice(preset.source, scopes); bool(preset.active); if (!preset.roles || typeof preset.roles !== "object" || Array.isArray(preset.roles) || Object.keys(preset.roles).length > 256) throw new Error("Invalid preset roles"); for (const [role, selector] of Object.entries(preset.roles)) { text(role, 128); text(selector); } if (preset.thinking !== undefined) text(preset.thinking, 64); if (preset.error !== undefined) text(preset.error); }
    return;
  }
  const row = record(value, ["outcome", "reason", "model", "thinking", "shadowed", "shadowedThinking", "shadowOwner"]);
  choice(row.outcome, ["saved", "deleted", "missing", "project", "switched", "invalid", "unavailable", "failed"]);
  for (const key of ["reason", "model", "thinking"]) if (row[key] !== undefined) text(row[key]); if (row.shadowOwner !== undefined) choice(row.shadowOwner, scopes);
  if (row.shadowed !== undefined) { if (!Array.isArray(row.shadowed) || row.shadowed.length > 256) throw new Error("Invalid preset conflicts"); for (const item of row.shadowed) { const conflict = record(item, ["role", "expected", "actual", "source"]); text(conflict.role, 128); choice(conflict.source, scopes); for (const key of ["expected", "actual"]) if (conflict[key] !== undefined) text(conflict[key]); } }
  if (row.shadowedThinking !== undefined) { const conflict = record(row.shadowedThinking, ["expected", "actual", "source"]); text(conflict.expected); if (conflict.actual !== undefined) text(conflict.actual); choice(conflict.source, scopes); }
}
