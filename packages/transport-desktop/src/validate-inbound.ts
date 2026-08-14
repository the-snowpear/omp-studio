/**
 * Strict P1 inbound validators for the Desktop IPC boundary
 * (FRONTEND_INTEGRATION.md §9).
 *
 * Every payload arriving from the preload is `unknown` and hostile until
 * proven otherwise. These parsers fail closed: unknown fields, prototype
 * pollution, invalid names, wrong per-name input shapes, empty or oversized
 * opaque ids and invalid limits all throw {@link ValidationError} before the
 * request ever reaches Host dispatch.
 *
 * Purity: browser/Node-neutral ECMAScript only — no Node, Electron, DOM or
 * schema-library imports. Client identity is never part of a payload: Main
 * binds identity from the sender WebContents, and any payload field that
 * could smuggle one is rejected as unknown.
 */

import type {
  ClientCommandRequest,
  ClientQueryRequest,
  CommandName,
  CommandRequestId,
  QueryName,
  RuntimeChannel,
  SubscriptionScope,
  ThreadId,
} from "@omp-studio/client-contract";

/** Thrown when an IPC payload fails strict P1 boundary validation. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Conservative P1 boundary limits. These are defense-in-depth caps against
 * hostile payloads, not product features: legitimate renderer traffic sits
 * far below every bound.
 */

/** Max characters of any single string inside an `interaction.respond` value. */
export const MAX_TEXT_LENGTH = 100_000;

/** Max elements of the top-level string-array `interaction.respond` value. */
export const MAX_LIST_ITEMS = 1_000;

/** Max object/array nesting depth inside an `interaction.respond` value. */
export const MAX_VALUE_DEPTH = 32;

/**
 * Conservative serialized-size proxy (code units, counted during the walk)
 * for an `interaction.respond` value. Approximate, not byte-exact; it fails
 * closed with margin.
 */
export const MAX_SERIALIZED_SIZE = 1_000_000;

/** Upper bound for the optional `history.list` limit. */
export const MAX_HISTORY_LIMIT = 1_000;

/** Max length of any opaque public identity token (request/thread/interaction ids). */
export const MAX_ID_LENGTH = 256;

/** True for plain objects with an `Object.prototype` or null prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Assert `value` is a plain object, rejecting arrays and exotic prototypes. */
export function assertPlainObject(
  value: unknown,
  what: string,
): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${what}: expected a plain object`);
  }
}

/**
 * Reject every own enumerable key not in `allowed`. This is what makes
 * identity smuggling (window id, authority, sender fields) and prototype
 * pollution keys (`__proto__` as an own JSON key) fail closed.
 */
export function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  what: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(`${what}: unknown field "${key}"`);
    }
  }
}

/**
 * True for opaque identity tokens: non-empty strings that are not
 * whitespace-only and fit within {@link MAX_ID_LENGTH}.
 */
export function isOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim().length > 0
  );
}

/** Assert `value` is a well-formed opaque identity token. */
export function assertOpaqueToken(value: unknown, field: string): asserts value is string {
  if (!isOpaqueToken(value)) {
    throw new ValidationError(
      `${field}: expected a non-empty opaque token of at most ${MAX_ID_LENGTH} characters`,
    );
  }
}

/** Assert a non-empty string (free text such as timestamps or reasons). */
export function assertNonEmptyText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`${field}: expected a non-empty string`);
  }
}

/** Reject objects with no allowed keys (the EmptyInput query shape). */
function validateEmptyInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, [], what);
}

function validateHistoryListInput(input: unknown): void {
  assertPlainObject(input, "history.list input");
  assertNoUnknownKeys(input, ["limit"], "history.list input");
  if ("limit" in input) {
    const limit = input.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new ValidationError("history.list input: limit must be a positive integer");
    }
    if (limit > MAX_HISTORY_LIMIT) {
      throw new ValidationError(
        `history.list input: limit exceeds the max of ${MAX_HISTORY_LIMIT}`,
      );
    }
  }
}

const RUNTIME_CHANNELS: readonly RuntimeChannel[] = ["stable", "canary"];

function validateRuntimeInstallInput(input: unknown): void {
  assertPlainObject(input, "runtime.install input");
  assertNoUnknownKeys(input, ["channel"], "runtime.install input");
  if ("channel" in input) {
    const channel = input.channel;
    if (typeof channel !== "string" || (channel !== "stable" && channel !== "canary")) {
      throw new ValidationError('runtime.install input: channel must be "stable" or "canary"');
    }
  }
}

function validateThreadInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["threadId"], what);
  assertOpaqueToken(input.threadId, `${what}: threadId`);
}

function validateTextInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["text"], what);
  assertNonEmptyText(input.text, `${what}: text`);
  if (input.text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${what}: text exceeds the max length of ${MAX_TEXT_LENGTH}`);
  }
}

function validateEmptyCommandInput(input: unknown, what: string): void {
  validateEmptyInput(input, what);
}

function validateOptionalTextFields(input: unknown, what: string, fields: readonly string[]): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, fields, what);
  for (const field of fields) if (field !== "kind" && field in input && input[field] !== undefined) assertNonEmptyText(input[field], `${what}: ${field}`);
}

function validateGoalInput(input: unknown, what: string, required: boolean): void {
  assertPlainObject(input, what); assertNoUnknownKeys(input, required ? ["objective", "tokenBudget"] : ["tokenBudget"], what);
  if (required) assertNonEmptyText(input.objective, `${what}: objective`);
  if ("tokenBudget" in input && input.tokenBudget !== undefined && (typeof input.tokenBudget !== "number" || !Number.isSafeInteger(input.tokenBudget) || input.tokenBudget <= 0)) throw new ValidationError(`${what}: tokenBudget must be a positive integer`);
}

function validateLoopEnableInput(input: unknown): void {
  assertPlainObject(input, "loop.enable input"); assertNoUnknownKeys(input, ["prompt", "limit"], "loop.enable input");
  if (input.prompt !== undefined) assertNonEmptyText(input.prompt, "loop.enable input: prompt");
  if (input.limit !== undefined) {
    assertPlainObject(input.limit, "loop.enable input: limit"); assertNoUnknownKeys(input.limit, ["turns", "minutes", "tokens"], "loop.enable input: limit");
    const values = [input.limit.turns, input.limit.minutes, input.limit.tokens].filter((value) => value !== undefined);
    if (values.length > 1 || values.some((value) => typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) throw new ValidationError("loop.enable input: limit must contain at most one positive integer");
  }
}

function validatePlanReviewInput(input: unknown): void {
  assertPlainObject(input, "mode.plan.review.respond input"); assertNoUnknownKeys(input, ["decision", "feedback"], "mode.plan.review.respond input");
  if (input.decision !== "approve" && input.decision !== "refine" && input.decision !== "dismiss") throw new ValidationError("mode.plan.review.respond input: invalid decision");
  if (input.feedback !== undefined) assertNonEmptyText(input.feedback, "mode.plan.review.respond input: feedback");
}

function validateOperatorInvokeInput(input: unknown): void {
  assertPlainObject(input, "operator.invoke input"); assertNoUnknownKeys(input, ["commandId", "arguments"], "operator.invoke input"); assertNonEmptyText(input.commandId, "operator.invoke input: commandId");
}

function validateTreeNavigateInput(input: unknown): void {
  assertPlainObject(input, "session.tree.navigate input"); assertNoUnknownKeys(input, ["targetId", "summarize", "customInstructions", "reanswer"], "session.tree.navigate input"); assertOpaqueToken(input.targetId, "session.tree.navigate input: targetId");
  if (input.summarize !== undefined && typeof input.summarize !== "boolean") throw new ValidationError("session.tree.navigate input: summarize must be boolean");
  if (input.customInstructions !== undefined) assertNonEmptyText(input.customInstructions, "session.tree.navigate input: customInstructions");
}

function validatePauseResumeInput(input: unknown): void {
  assertPlainObject(input, "runtime.resume input");
  assertNoUnknownKeys(input, ["expectedPauseEpoch"], "runtime.resume input");
  if (typeof input.expectedPauseEpoch !== "number" || !Number.isSafeInteger(input.expectedPauseEpoch) || input.expectedPauseEpoch < 0) {
    throw new ValidationError("runtime.resume input: expectedPauseEpoch must be a non-negative safe integer");
  }
}

/**
 * JSON-safety + size walk for nested values inside an `interaction.respond`
 * value object. Rejects undefined/function/symbol/bigint, NaN/Infinity,
 * exotic objects (Date, Map, typed arrays...), reserved keys and every
 * depth/text/serialized-size bound. Budget is consumed during the walk so
 * an oversized payload aborts as soon as it exceeds the cap.
 */
interface SizeBudget {
  remaining: number;
}

function spend(budget: SizeBudget, units: number): void {
  budget.remaining -= units;
  if (budget.remaining < 0) {
    throw new ValidationError(
      `interaction.respond value: exceeds the max serialized size of ${MAX_SERIALIZED_SIZE}`,
    );
  }
}

// Null-prototype record: `__proto__`, `constructor` and `prototype` are own
// data keys with literal true values — no inherited accessor can be hit and
// no prototype mutation occurs (a plain literal would also widen
// `constructor: true` to boolean and fail Record<string, true>).
const RESERVED_KEYS: Readonly<Record<string, true>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, true>, {
    ["__proto__"]: true,
    constructor: true,
    prototype: true,
  } as const),
);

function validateJsonNode(value: unknown, depth: number, budget: SizeBudget): void {
  if (depth > MAX_VALUE_DEPTH) {
    throw new ValidationError(
      `interaction.respond value: exceeds the max nesting depth of ${MAX_VALUE_DEPTH}`,
    );
  }
  if (value === null) {
    spend(budget, 4);
    return;
  }
  switch (typeof value) {
    case "string":
      if (value.length > MAX_TEXT_LENGTH) {
        throw new ValidationError(
          `interaction.respond value: string exceeds the max length of ${MAX_TEXT_LENGTH}`,
        );
      }
      spend(budget, value.length + 2);
      return;
    case "boolean":
      spend(budget, 5);
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new ValidationError(
          "interaction.respond value: numbers must be finite (JSON-safe)",
        );
      }
      spend(budget, 32);
      return;
    case "object": {
      if (Array.isArray(value)) {
        spend(budget, 1 + value.length);
        for (const item of value) {
          validateJsonNode(item, depth + 1, budget);
        }
        return;
      }
      if (!isPlainObject(value)) {
        throw new ValidationError(
          "interaction.respond value: only plain JSON objects are allowed",
        );
      }
      const keys = Object.keys(value);
      spend(budget, 4 + keys.length);
      for (const key of keys) {
        if (RESERVED_KEYS[key] === true) {
          throw new ValidationError(
            `interaction.respond value: reserved key "${key}" is not allowed`,
          );
        }
        spend(budget, key.length + 3);
        validateJsonNode(value[key], depth + 1, budget);
      }
      return;
    }
    default:
      // undefined, function, symbol, bigint — none are JSON-safe.
      throw new ValidationError("interaction.respond value: must be JSON-safe");
  }
}

/**
 * Validate an `InteractionResponseValue`: either a string, boolean,
 * string-array or plain JSON object — bounded by the exported limits and
 * JSON-safe at every nesting level.
 */
function validateInteractionValue(value: unknown): void {
  const budget: SizeBudget = { remaining: MAX_SERIALIZED_SIZE };
  if (value === null || typeof value === "number") {
    throw new ValidationError(
      "interaction.respond value: must be a string, boolean, string array or object",
    );
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_LIST_ITEMS) {
      throw new ValidationError(
        `interaction.respond value: array exceeds the max length of ${MAX_LIST_ITEMS}`,
      );
    }
    spend(budget, 1 + value.length);
    for (const item of value) {
      if (typeof item !== "string") {
        throw new ValidationError("interaction.respond value: array values must be strings");
      }
      validateJsonNode(item, 1, budget);
    }
    return;
  }
  validateJsonNode(value, 0, budget);
}

function validateInteractionRespondInput(input: unknown): void {
  assertPlainObject(input, "interaction.respond input");
  assertNoUnknownKeys(input, ["interactionId", "decision", "value"], "interaction.respond input");
  assertOpaqueToken(input.interactionId, "interaction.respond input: interactionId");
  const decision = input.decision;
  if (decision !== "submit" && decision !== "cancel") {
    throw new ValidationError('interaction.respond input: decision must be "submit" or "cancel"');
  }
  if ("value" in input) {
    validateInteractionValue(input.value);
  }
}

const MODEL_AUTH_TYPES = ["oauth", "api-key", "env", "command", "none"] as const;

function validateModelsProviderAuth(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["type", "apiKey", "envName", "command", "clearSecret"], what);
  if (typeof input.type !== "string" || !(MODEL_AUTH_TYPES as readonly string[]).includes(input.type)) {
    throw new ValidationError(`${what}: type must be a known ModelAuthType`);
  }
  if (input.apiKey !== undefined) {
    if (typeof input.apiKey !== "string" || input.apiKey.length === 0 || input.apiKey.length > MAX_TEXT_LENGTH) {
      throw new ValidationError(`${what}: apiKey must be a non-empty string`);
    }
  }
  if (input.envName !== undefined) assertNonEmptyText(input.envName, `${what}: envName`);
  if (input.command !== undefined) assertNonEmptyText(input.command, `${what}: command`);
  if (input.clearSecret !== undefined && typeof input.clearSecret !== "boolean") {
    throw new ValidationError(`${what}: clearSecret must be boolean`);
  }
}

function validateModelsProviderModels(input: unknown, what: string): void {
  if (!Array.isArray(input)) throw new ValidationError(`${what}: models must be an array`);
  if (input.length > MAX_LIST_ITEMS) throw new ValidationError(`${what}: models exceeds max length`);
  for (const item of input) {
    assertPlainObject(item, `${what}: model`);
    assertNoUnknownKeys(item, ["id", "name", "contextWindow", "maxTokens", "reasoning", "image"], `${what}: model`);
    assertNonEmptyText(item.id, `${what}: model.id`);
    if (item.name !== undefined) assertNonEmptyText(item.name, `${what}: model.name`);
    if (item.contextWindow !== undefined && (typeof item.contextWindow !== "number" || !Number.isSafeInteger(item.contextWindow) || item.contextWindow <= 0)) {
      throw new ValidationError(`${what}: model.contextWindow must be a positive integer`);
    }
    if (item.maxTokens !== undefined && (typeof item.maxTokens !== "number" || !Number.isSafeInteger(item.maxTokens) || item.maxTokens <= 0)) {
      throw new ValidationError(`${what}: model.maxTokens must be a positive integer`);
    }
    if (item.reasoning !== undefined && typeof item.reasoning !== "boolean") throw new ValidationError(`${what}: model.reasoning must be boolean`);
    if (item.image !== undefined && typeof item.image !== "boolean") throw new ValidationError(`${what}: model.image must be boolean`);
  }
}

function validateModelsProviderUpsertInput(input: unknown): void {
  assertPlainObject(input, "models.provider.upsert input");
  assertNoUnknownKeys(
    input,
    ["id", "name", "website", "note", "api", "endpointUrl", "local", "enabled", "auth", "discovery", "models", "expectedHash"],
    "models.provider.upsert input",
  );
  assertNonEmptyText(input.id, "models.provider.upsert input: id");
  assertNonEmptyText(input.name, "models.provider.upsert input: name");
  assertNonEmptyText(input.api, "models.provider.upsert input: api");
  if (input.website !== undefined) assertNonEmptyText(input.website, "models.provider.upsert input: website");
  if (input.note !== undefined && typeof input.note !== "string") throw new ValidationError("models.provider.upsert input: note must be a string");
  if (input.endpointUrl !== undefined) assertNonEmptyText(input.endpointUrl, "models.provider.upsert input: endpointUrl");
  if (input.local !== undefined && typeof input.local !== "boolean") throw new ValidationError("models.provider.upsert input: local must be boolean");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new ValidationError("models.provider.upsert input: enabled must be boolean");
  if (input.expectedHash !== undefined) assertNonEmptyText(input.expectedHash, "models.provider.upsert input: expectedHash");
  validateModelsProviderAuth(input.auth, "models.provider.upsert input: auth");
  if (input.discovery !== undefined && input.discovery !== null) {
    assertPlainObject(input.discovery, "models.provider.upsert input: discovery");
    assertNoUnknownKeys(input.discovery, ["type", "timeoutMs"], "models.provider.upsert input: discovery");
    assertNonEmptyText(input.discovery.type, "models.provider.upsert input: discovery.type");
    if (input.discovery.timeoutMs !== undefined && (typeof input.discovery.timeoutMs !== "number" || !Number.isSafeInteger(input.discovery.timeoutMs) || input.discovery.timeoutMs <= 0)) {
      throw new ValidationError("models.provider.upsert input: discovery.timeoutMs must be a positive integer");
    }
  }
  if (input.models !== undefined) validateModelsProviderModels(input.models, "models.provider.upsert input");
}

function validateModelsProviderDeleteInput(input: unknown): void {
  assertPlainObject(input, "models.provider.delete input");
  assertNoUnknownKeys(input, ["id", "expectedHash"], "models.provider.delete input");
  assertNonEmptyText(input.id, "models.provider.delete input: id");
  if (input.expectedHash !== undefined) assertNonEmptyText(input.expectedHash, "models.provider.delete input: expectedHash");
}

function validateModelsRolesSetInput(input: unknown): void {
  assertPlainObject(input, "models.roles.set input");
  assertNoUnknownKeys(input, ["roleId", "selector"], "models.roles.set input");
  assertNonEmptyText(input.roleId, "models.roles.set input: roleId");
  assertNonEmptyText(input.selector, "models.roles.set input: selector");
}

function validateModelsProviderTestInput(input: unknown): void {
  assertPlainObject(input, "models.provider.test input");
  assertNoUnknownKeys(input, ["providerId", "api", "endpointUrl", "apiKey"], "models.provider.test input");
  if (input.providerId !== undefined) assertNonEmptyText(input.providerId, "models.provider.test input: providerId");
  if (input.api !== undefined) assertNonEmptyText(input.api, "models.provider.test input: api");
  if (input.endpointUrl !== undefined) assertNonEmptyText(input.endpointUrl, "models.provider.test input: endpointUrl");
  if (input.apiKey !== undefined) assertNonEmptyText(input.apiKey, "models.provider.test input: apiKey");
}

function validateModelsCycleOrderSetInput(input: unknown): void {
  assertPlainObject(input, "models.cycleOrder.set input");
  assertNoUnknownKeys(input, ["order"], "models.cycleOrder.set input");
  if (!Array.isArray(input.order) || input.order.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ValidationError("models.cycleOrder.set input: order must be an array of non-empty strings");
  }
}

function validateModelsLoginStartInput(input: unknown): void {
  assertPlainObject(input, "models.login.start input");
  assertNoUnknownKeys(input, ["providerId"], "models.login.start input");
  assertNonEmptyText(input.providerId, "models.login.start input: providerId");
}

function validateEnabledToggleInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["name", "enabled", "scope"], what);
  assertNonEmptyText(input.name, `${what}: name`);
  if (typeof input.enabled !== "boolean") {
    throw new ValidationError(`${what}: enabled must be boolean`);
  }
  if (input.scope !== undefined && input.scope !== "user" && input.scope !== "project") {
    throw new ValidationError(`${what}: scope must be "user" or "project"`);
  }
}

function validatePluginsSetEnabledInput(input: unknown): void {
  validateEnabledToggleInput(input, "plugins.setEnabled input");
}

function validateSkillsSetEnabledInput(input: unknown): void {
  validateEnabledToggleInput(input, "skills.setEnabled input");
}

/**
 * Per-name query input validators keyed by the full contract QueryName map:
 * a mapped type over `QueryName`, so a name added to client-contract fails
 * to compile here until its validator exists, and a name removed is caught
 * as excess. The key set IS the authoritative runtime name list.
 */
const QUERY_INPUT_VALIDATORS: {
  readonly [K in QueryName]: (input: unknown) => void;
} = {
  "environment.get": (input) => validateEmptyInput(input, "environment.get input"),
  "capabilities.get": (input) => validateEmptyInput(input, "capabilities.get input"),
  "commands.getManifest": (input) => validateEmptyInput(input, "commands.getManifest input"),
  "diagnostics.get": (input) => validateEmptyInput(input, "diagnostics.get input"),
  "history.list": validateHistoryListInput,
  "session.state": (input) => validateEmptyInput(input, "session.state input"),
  "home.get": (input) => validateEmptyInput(input, "home.get input"),
  "models.get": (input) => validateEmptyInput(input, "models.get input"),
  "skills.get": (input) => validateEmptyInput(input, "skills.get input"),
  "projects.list": (input) => validateEmptyInput(input, "projects.list input"),
};

/** Per-name command input validators, keyed by the full CommandName map. */
const COMMAND_INPUT_VALIDATORS: {
  readonly [K in CommandName]: (input: unknown) => void;
} = {
  "core.prompt": (input) => validateTextInput(input, "core.prompt input"),
  "core.steer": (input) => validateTextInput(input, "core.steer input"),
  "core.followUp": (input) => validateTextInput(input, "core.followUp input"),
  "core.abort": (input) => validateEmptyCommandInput(input, "core.abort input"),
  "queue.enqueue": (input) => validateTextInput(input, "queue.enqueue input"),
  "runtime.pause": (input) => validateEmptyCommandInput(input, "runtime.pause input"),
  "runtime.resume": validatePauseResumeInput,
  "turn.retry": (input) => validateEmptyCommandInput(input, "turn.retry input"),
  "mode.plan.enter": (input) => validateOptionalTextFields(input, "mode.plan.enter input", ["initialPrompt"]),
  "mode.plan.exit": (input) => { assertPlainObject(input, "mode.plan.exit input"); assertNoUnknownKeys(input, ["discardDraft"], "mode.plan.exit input"); if (input.discardDraft !== undefined && typeof input.discardDraft !== "boolean") throw new ValidationError("mode.plan.exit input: discardDraft must be boolean"); },
  "mode.plan.review.open": (input) => validateEmptyCommandInput(input, "mode.plan.review.open input"),
  "mode.plan.review.respond": validatePlanReviewInput,
  "mode.vibe.enter": (input) => validateOptionalTextFields(input, "mode.vibe.enter input", ["initialPrompt"]),
  "mode.vibe.exit": (input) => validateEmptyCommandInput(input, "mode.vibe.exit input"),
  "goal.create": (input) => validateGoalInput(input, "goal.create input", true),
  "goal.replace": (input) => validateGoalInput(input, "goal.replace input", true),
  "goal.show": (input) => validateEmptyCommandInput(input, "goal.show input"),
  "goal.setBudget": (input) => validateGoalInput(input, "goal.setBudget input", false),
  "goal.pause": (input) => validateEmptyCommandInput(input, "goal.pause input"),
  "goal.resume": (input) => validateEmptyCommandInput(input, "goal.resume input"),
  "goal.drop": (input) => validateEmptyCommandInput(input, "goal.drop input"),
  "goal.guided.start": (input) => validateOptionalTextFields(input, "goal.guided.start input", ["initial"]),
  "loop.enable": validateLoopEnableInput,
  "loop.pause": (input) => validateEmptyCommandInput(input, "loop.pause input"),
  "loop.disable": (input) => validateEmptyCommandInput(input, "loop.disable input"),
  "session.fork": (input) => validateEmptyCommandInput(input, "session.fork input"),
  "session.tree.get": (input) => validateEmptyCommandInput(input, "session.tree.get input"),
  "session.tree.navigate": validateTreeNavigateInput,
  "operator.invoke": validateOperatorInvokeInput,
  "runtime.install": validateRuntimeInstallInput,
  "session.resume": (input) => validateThreadInput(input, "session.resume input"),
  "session.drop": (input) => validateThreadInput(input, "session.drop input"),
  "interaction.respond": validateInteractionRespondInput,
  "models.provider.upsert": validateModelsProviderUpsertInput,
  "models.provider.delete": validateModelsProviderDeleteInput,
  "models.roles.set": validateModelsRolesSetInput,
  "models.login.start": validateModelsLoginStartInput,
  "models.provider.test": validateModelsProviderTestInput,
  "models.cycleOrder.set": validateModelsCycleOrderSetInput,
  "plugins.setEnabled": validatePluginsSetEnabledInput,
  "skills.setEnabled": validateSkillsSetEnabledInput,
  "workspace.open": (input) => {
    assertPlainObject(input, "workspace.open input");
    assertNoUnknownKeys(input, ["workspaceId"], "workspace.open input");
    assertOpaqueToken(input.workspaceId, "workspace.open input: workspaceId");
  },
  "workspace.pick": (input) => validateEmptyCommandInput(input, "workspace.pick input"),
};

/** Every valid query name, derived from the client-contract map. */
export const QUERY_NAMES: readonly string[] = Object.freeze(Object.keys(QUERY_INPUT_VALIDATORS));

/** Every valid command name, derived from the client-contract map. */
export const COMMAND_NAMES: readonly string[] = Object.freeze(
  Object.keys(COMMAND_INPUT_VALIDATORS),
);

/**
 * Parse and strictly validate a renderer query envelope. Throws
 * {@link ValidationError} on any deviation; the returned value carries only
 * the two contract fields and never client identity, window id or authority.
 *
 * @param value - raw IPC payload (Main-side, before Host dispatch).
 */
export function parseClientQueryRequest(value: unknown): ClientQueryRequest {
  assertPlainObject(value, "query request");
  assertNoUnknownKeys(value, ["queryName", "input"], "query request");
  const queryName = value.queryName;
  if (typeof queryName !== "string") {
    throw new ValidationError("query request: queryName must be a string");
  }
  const validateInput = QUERY_INPUT_VALIDATORS[queryName as QueryName];
  if (validateInput === undefined) {
    throw new ValidationError(`query request: unknown queryName ${JSON.stringify(queryName)}`);
  }
  validateInput(value.input);
  return { queryName, input: value.input } as unknown as ClientQueryRequest;
}

/**
 * Parse and strictly validate a renderer command envelope: known
 * commandName, exact per-name input shape, non-empty bounded
 * requestId/idempotencyKey. Throws {@link ValidationError} before the
 * mutation could ever reach Host dispatch.
 *
 * @param value - raw IPC payload (Main-side, before Host dispatch).
 */
export function parseClientCommandRequest(value: unknown): ClientCommandRequest {
  assertPlainObject(value, "command request");
  assertNoUnknownKeys(
    value,
    ["commandName", "input", "idempotencyKey", "requestId"],
    "command request",
  );
  const commandName = value.commandName;
  if (typeof commandName !== "string") {
    throw new ValidationError("command request: commandName must be a string");
  }
  const validateInput = COMMAND_INPUT_VALIDATORS[commandName as CommandName];
  if (validateInput === undefined) {
    throw new ValidationError(
      `command request: unknown commandName ${JSON.stringify(commandName)}`,
    );
  }
  validateInput(value.input);
  assertOpaqueToken(value.requestId, "command request: requestId");
  assertOpaqueToken(value.idempotencyKey, "command request: idempotencyKey");
  return {
    commandName,
    input: value.input,
    idempotencyKey: value.idempotencyKey,
    requestId: value.requestId,
  } as unknown as ClientCommandRequest;
}

/**
 * Parse and strictly validate a subscription scope. Unknown scope values,
 * unknown extra fields and malformed thread/command selectors all fail
 * closed; a scope never carries sender identity.
 *
 * @param value - raw IPC payload (Main-side, before subscription setup).
 */
export function parseSubscriptionScope(value: unknown): SubscriptionScope {
  assertPlainObject(value, "subscription scope");
  const scope = value.scope;
  if (scope !== "all" && scope !== "runtime" && scope !== "thread" && scope !== "command") {
    const shown = typeof scope === "string" ? JSON.stringify(scope) : String(scope);
    throw new ValidationError(`subscription scope: unknown scope ${shown}`);
  }
  if (scope === "all" || scope === "runtime") {
    assertNoUnknownKeys(value, ["scope"], "subscription scope");
    return { scope };
  }
  if (scope === "thread") {
    assertNoUnknownKeys(value, ["scope", "threadId"], "subscription scope");
    assertOpaqueToken(value.threadId, "subscription scope: threadId");
    return { scope, threadId: value.threadId as ThreadId };
  }
  assertNoUnknownKeys(value, ["scope", "requestId"], "subscription scope");
  assertOpaqueToken(value.requestId, "subscription scope: requestId");
  return { scope, requestId: value.requestId as CommandRequestId };
}
