/**
 * Role-selector thinking levels (`modelRoles` suffix) and how they interact
 * with a model's catalog capability surface.
 *
 * `auto` is session-only and is never a `provider/model:auto` suffix.
 */

export const ROLE_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type RoleThinkingLevel = (typeof ROLE_THINKING_LEVELS)[number];

/** Efforts a custom/override model may advertise in `models.yml` `thinking.efforts`. */
export const MODEL_CONFIG_THINKING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ModelConfigThinkingEffort = (typeof MODEL_CONFIG_THINKING_EFFORTS)[number];

const ROLE_THINKING_SET = new Set<string>(ROLE_THINKING_LEVELS);
const MODEL_CONFIG_THINKING_SET = new Set<string>(MODEL_CONFIG_THINKING_EFFORTS);
const EFFORT_ORDER = ROLE_THINKING_LEVELS.filter((level) => level !== "off");

function thinkingEffortList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as { efforts?: unknown }).efforts)) {
    return (value as { efforts: unknown[] }).efforts;
  }
  return [];
}

export interface RoleThinkingModel {
  readonly reasoning: boolean;
  readonly thinking?: ReadonlyArray<string>;
}

export interface RoleThinkingControl {
  readonly ids: ReadonlyArray<RoleThinkingLevel>;
  readonly disabled: boolean;
}

function asEffort(value: string): Exclude<RoleThinkingLevel, "off"> | undefined {
  return EFFORT_ORDER.includes(value as Exclude<RoleThinkingLevel, "off">)
    ? (value as Exclude<RoleThinkingLevel, "off">)
    : undefined;
}

function modelEfforts(model: RoleThinkingModel): ReadonlyArray<Exclude<RoleThinkingLevel, "off">> {
  const raw = model.thinking ?? [];
  const allowed = new Set<Exclude<RoleThinkingLevel, "off">>();
  for (const item of raw) {
    const effort = asEffort(item);
    if (effort) allowed.add(effort);
  }
  return EFFORT_ORDER.filter((level) => allowed.has(level));
}

/**
 * Extract user-facing effort ids from an OMP catalog `thinking` field.
 * Catalog stores `{ efforts: string[] }`; a string array is accepted as a
 * fallback. Unknown ids are dropped.
 */
export function parseCacheThinkingEfforts(value: unknown): string[] {
  const allowed = new Set<string>();
  for (const item of thinkingEffortList(value)) {
    if (typeof item === "string" && ROLE_THINKING_SET.has(item) && item !== "off") allowed.add(item);
  }
  return EFFORT_ORDER.filter((level) => allowed.has(level));
}

/**
 * Parse `models.yml` `thinking` / `thinking.efforts` for the model editor.
 * Drops unknown ids (and ignores 'off' which is a role/session control level, not a model effort).
 */
export function parseModelThinkingEfforts(value: unknown): ModelConfigThinkingEffort[] {
  const allowed = new Set<ModelConfigThinkingEffort>();
  for (const item of thinkingEffortList(value)) {
    if (typeof item === "string" && MODEL_CONFIG_THINKING_SET.has(item)) {
      allowed.add(item as ModelConfigThinkingEffort);
    }
  }
  return MODEL_CONFIG_THINKING_EFFORTS.filter((level) => allowed.has(level));
}

/**
 * Options for the role thinking control:
 * - unknown model: full ladder, enabled
 * - `reasoning: false`: Off only, disabled
 * - reasoning but no controllable efforts: full ladder, enabled (write as-is)
 * - has efforts: Off + that ladder
 */
export function roleThinkingControl(model: RoleThinkingModel | undefined): RoleThinkingControl {
  if (!model) return { ids: ROLE_THINKING_LEVELS, disabled: false };
  if (!model.reasoning) return { ids: ["off"], disabled: true };
  const efforts = modelEfforts(model);
  if (efforts.length === 0) return { ids: ROLE_THINKING_LEVELS, disabled: false };
  return { ids: ["off", ...efforts], disabled: false };
}

/**
 * Snap a requested role thinking suffix onto the model's legal ladder.
 * Off stays Off. Models without a controllable surface keep the request as-is.
 * Unsupported efforts snap down to the highest supported tier at or below the
 * request, else the model's lowest tier.
 */
export function clampRoleThinking(
  thinking: string | undefined,
  model: RoleThinkingModel | undefined,
): string | undefined {
  const current = thinking && thinking !== "off" ? thinking : undefined;
  if (!model) return current;
  if (!model.reasoning) return undefined;
  const efforts = modelEfforts(model);
  if (efforts.length === 0) return current;
  if (!current) return undefined;
  if (efforts.includes(current as Exclude<RoleThinkingLevel, "off">)) return current;
  const requestedIndex = EFFORT_ORDER.indexOf(current as Exclude<RoleThinkingLevel, "off">);
  if (requestedIndex === -1) return efforts[0];
  let clamped: string | undefined;
  for (const effort of efforts) {
    if (EFFORT_ORDER.indexOf(effort) > requestedIndex) break;
    clamped = effort;
  }
  return clamped ?? efforts[0];
}
