import { ContractValidationError } from "./contract-error.js";
import {
  BTW_ERROR_CODES,
  BTW_ERROR_MESSAGE_MAX_CHARS,
  BTW_ID_MAX_CHARS,
  BTW_STATUSES,
  BTW_TEXT_MAX_CHARS,
  type BtwError,
  type BtwErrorCode,
  type BtwSnapshot,
  type BtwStatus,
} from "./contracts/btw.js";

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

function boundedNonEmptyString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError("expected a non-empty string", path);
  }
  if (value.length > maxChars) throw new ContractValidationError(`string exceeds ${maxChars} characters`, path);
  return value;
}

function boundedString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string") throw new ContractValidationError("expected a string", path);
  if (value.length > maxChars) throw new ContractValidationError(`string exceeds ${maxChars} characters`, path);
  return value;
}

function parseBtwError(value: unknown, path: string): BtwError {
  const input = record(value, path);
  exactKeys(input, ["code", "message"], path);
  if (!(BTW_ERROR_CODES as readonly string[]).includes(input.code as string)) {
    throw new ContractValidationError("unsupported BTW error code", `${path}.code`);
  }
  boundedString(input.message, `${path}.message`, BTW_ERROR_MESSAGE_MAX_CHARS);
  return input as unknown as BtwError;
}

/**
 * Structural parse for the `btw.changed` payload. The Runtime already keeps
 * this snapshot path-free, so this is a contract boundary check rather than a
 * sanitizer: an unknown field or an out-of-range status is a protocol bug and
 * must fail the frame instead of reaching the Renderer as `unknown`.
 */
export function parseBtwSnapshot(value: unknown, path = "$snapshot"): BtwSnapshot {
  const input = record(value, path);
  exactKeys(input, ["ephemeralId", "status", "text", "copy", "error"], path);
  boundedNonEmptyString(input.ephemeralId, `${path}.ephemeralId`, BTW_ID_MAX_CHARS);
  if (!(BTW_STATUSES as readonly string[]).includes(input.status as string)) {
    throw new ContractValidationError("unsupported BTW status", `${path}.status`);
  }
  boundedString(input.text, `${path}.text`, BTW_TEXT_MAX_CHARS);
  if (input.copy !== undefined) boundedString(input.copy, `${path}.copy`, BTW_TEXT_MAX_CHARS);
  if (input.error !== undefined) parseBtwError(input.error, `${path}.error`);
  return input as unknown as BtwSnapshot;
}

export function isBtwStatus(value: unknown): value is BtwStatus {
  return typeof value === "string" && (BTW_STATUSES as readonly string[]).includes(value);
}

export function isBtwErrorCode(value: unknown): value is BtwErrorCode {
  return typeof value === "string" && (BTW_ERROR_CODES as readonly string[]).includes(value);
}
