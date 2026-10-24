/**
 * Envelope parsing for the Desktop IPC boundary.
 *
 * Main only checks the envelope shape here and copies the known fields, so
 * extra fields (window ids, authority) never reach the Host. Per-command
 * input checks live in the Host facade and the services that run them.
 */

import type {
  ClientCommandRequest,
  ClientQueryRequest,
  CommandRequestId,
  SubscriptionScope,
  ThreadId,
} from "@omp-studio/client-contract";

/** Thrown when an IPC payload is not a well-formed envelope. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/** True for plain objects with an `Object.prototype` or null prototype. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw new ValidationError(`${what}: expected a plain object`);
  return value;
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ValidationError(`${what}: expected a non-empty string`);
  return value;
}

export function parseClientQueryRequest(value: unknown): ClientQueryRequest {
  const envelope = requireObject(value, "query request");
  const queryName = requireText(envelope.queryName, "query request: queryName");
  return { queryName, input: envelope.input } as unknown as ClientQueryRequest;
}

export function parseClientCommandRequest(value: unknown): ClientCommandRequest {
  const envelope = requireObject(value, "command request");
  return {
    commandName: requireText(envelope.commandName, "command request: commandName"),
    input: envelope.input,
    idempotencyKey: requireText(envelope.idempotencyKey, "command request: idempotencyKey"),
    requestId: requireText(envelope.requestId, "command request: requestId"),
  } as unknown as ClientCommandRequest;
}

export function parseSubscriptionScope(value: unknown): SubscriptionScope {
  const envelope = requireObject(value, "subscription scope");
  switch (envelope.scope) {
    case "all":
    case "runtime":
      return { scope: envelope.scope };
    case "thread":
      return { scope: "thread", threadId: requireText(envelope.threadId, "subscription scope: threadId") as ThreadId };
    case "command":
      return { scope: "command", requestId: requireText(envelope.requestId, "subscription scope: requestId") as CommandRequestId };
    default:
      throw new ValidationError(`subscription scope: unknown scope ${String(envelope.scope)}`);
  }
}
