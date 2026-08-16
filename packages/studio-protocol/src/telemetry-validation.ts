import { ContractValidationError } from "./contract-error.js";
import type { SessionTelemetryEvent, SessionTelemetrySnapshot } from "./contracts/telemetry.js";

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError("expected an object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) throw new ContractValidationError(`unknown field ${JSON.stringify(unknown)}`, path);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ContractValidationError("expected a non-empty string", path);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractValidationError("expected a non-negative safe integer", path);
  }
  return value as number;
}

function finiteNonNegative(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ContractValidationError("expected a finite non-negative number", path);
  }
  return value;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractValidationError("expected a boolean", path);
  return value;
}

const TOKEN_FIELDS = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "total", "cost"] as const;

function parseTokenSet(value: unknown, path: string): SessionTelemetrySnapshot["tokens"] {
  const input = record(value, path);
  exactKeys(input, TOKEN_FIELDS, path);
  for (const field of TOKEN_FIELDS) finiteNonNegative(input[field], `${path}.${field}`);
  return input as SessionTelemetrySnapshot["tokens"];
}

function parseTurn(value: unknown, path: string): NonNullable<SessionTelemetrySnapshot["lastCompletedTurn"]> {
  const input = record(value, path);
  exactKeys(input, [...TOKEN_FIELDS, "completedAt"], path);
  for (const field of TOKEN_FIELDS) finiteNonNegative(input[field], `${path}.${field}`);
  nonEmptyString(input.completedAt, `${path}.completedAt`);
  return input as NonNullable<SessionTelemetrySnapshot["lastCompletedTurn"]>;
}

function parseContext(value: unknown, path: string): NonNullable<SessionTelemetrySnapshot["context"]> {
  const input = record(value, path);
  const fields = [
    "contextWindow",
    "usedTokens",
    "percent",
    "anchored",
    "systemPromptTokens",
    "systemContextTokens",
    "systemToolsTokens",
    "skillsTokens",
    "messagesTokens",
  ] as const;
  exactKeys(input, fields, path);
  nonNegativeInteger(input.contextWindow, `${path}.contextWindow`);
  if ((input.contextWindow as number) <= 0) throw new ContractValidationError("expected a positive integer", `${path}.contextWindow`);
  for (const field of ["usedTokens", "systemPromptTokens", "systemContextTokens", "systemToolsTokens", "skillsTokens", "messagesTokens"] as const) {
    nonNegativeInteger(input[field], `${path}.${field}`);
  }
  finiteNonNegative(input.percent, `${path}.percent`);
  booleanValue(input.anchored, `${path}.anchored`);
  return input as NonNullable<SessionTelemetrySnapshot["context"]>;
}

export function parseSessionTelemetrySnapshot(value: unknown, path = "$telemetry"): SessionTelemetrySnapshot {
  const input = record(value, path);
  exactKeys(input, ["sessionId", "capturedAt", "tokens", "lastCompletedTurn", "context", "unavailableReason"], path);
  nonEmptyString(input.sessionId, `${path}.sessionId`);
  nonEmptyString(input.capturedAt, `${path}.capturedAt`);
  parseTokenSet(input.tokens, `${path}.tokens`);
  if (input.lastCompletedTurn !== undefined) parseTurn(input.lastCompletedTurn, `${path}.lastCompletedTurn`);
  if (input.context !== null) parseContext(input.context, `${path}.context`);
  if (input.unavailableReason !== undefined && input.unavailableReason !== "runtime_not_ready" && input.unavailableReason !== "model_context_unknown") {
    throw new ContractValidationError("unsupported telemetry unavailable reason", `${path}.unavailableReason`);
  }
  return input as unknown as SessionTelemetrySnapshot;
}

export function parseSessionTelemetryEvent(value: unknown, path = "$event.event"): SessionTelemetryEvent {
  const input = record(value, path);
  exactKeys(input, ["kind", "sessionId", "telemetry"], path);
  if (input.kind !== "session.telemetry.changed") throw new ContractValidationError("unsupported telemetry event", `${path}.kind`);
  nonEmptyString(input.sessionId, `${path}.sessionId`);
  const telemetry = parseSessionTelemetrySnapshot(input.telemetry, `${path}.telemetry`);
  if (telemetry.sessionId !== input.sessionId) throw new ContractValidationError("telemetry session mismatch", `${path}.sessionId`);
  return input as unknown as SessionTelemetryEvent;
}

export function isSessionTelemetryEventKind(kind: unknown): kind is "session.telemetry.changed" {
  return kind === "session.telemetry.changed";
}
