/**
 * Safe outbound assertions for the Desktop IPC boundary
 * (FRONTEND_INTEGRATION.md §9).
 *
 * Main runs these on Host/back-end output BEFORE anything is sent to the
 * preload. They are the mirror image of the inbound parsers: an envelope
 * that violates the contract (unknown kind, mismatched name, malformed
 * receipt, unknown error code, unhandled payload shape) throws
 * {@link ValidationError} so the Renderer never receives malformed data.
 *
 * Purity: browser/Node-neutral ECMAScript only — no Node, Electron, DOM or
 * schema-library imports. Payloads are asserted structurally; client
 * identity is a Main-side concern and never part of a payload.
 */

import type {
  ClientCommandAccepted,
  ClientEvent,
  ClientErrorCode,
  ClientInteraction,
  ClientQueryResponse,
  CommandReceipt,
  RuntimeBackend,
  RuntimeClassification,
  RuntimeConnectionStatus,
} from "@omp-studio/client-contract";

import {
  ValidationError,
  assertNoUnknownKeys,
  assertNonEmptyText,
  assertOpaqueToken,
  assertPlainObject,
  isOpaqueToken,
} from "./validate-inbound.js";
import { COMMAND_NAMES, QUERY_NAMES } from "./validate-inbound.js";

/** Human-readable form of an unexpected value for error messages. */
function describe(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

const CLIENT_ERROR_CODES = [
  "UNAVAILABLE",
  "INVALID_ARGUMENT",
  "STALE_EPOCH",
  "STATE_VERSION_CONFLICT",
  "CAPABILITY_UNAVAILABLE",
  "RESYNC_REQUIRED",
  "TRANSPORT_ERROR",
  "INTERNAL_ERROR",
] as const satisfies readonly ClientErrorCode[];

/**
 * Assert a well-formed `ClientError`: known code plus a string message,
 * nothing else. A code added to the contract but missing here fails closed
 * until the list is updated.
 */
function assertClientError(value: unknown): void {
  assertPlainObject(value, "client error");
  assertNoUnknownKeys(value, ["code", "message"], "client error");
  const code = value.code;
  if (typeof code !== "string" || !(CLIENT_ERROR_CODES as readonly string[]).includes(code)) {
    throw new ValidationError(`client error: unknown code ${describe(code)}`);
  }
  if (typeof value.message !== "string") {
    throw new ValidationError("client error: message must be a string");
  }
}

/**
 * Assert a query response envelope before it crosses to the preload:
 * boolean `ok`, a queryName from the client-contract map, an exact result
 * when ok, a well-formed error otherwise.
 */
export function assertClientQueryResponse(value: unknown): asserts value is ClientQueryResponse {
  assertPlainObject(value, "query response");
  assertNoUnknownKeys(value, ["ok", "queryName", "result", "error"], "query response");
  const ok = value.ok;
  if (typeof ok !== "boolean") {
    throw new ValidationError("query response: ok must be a boolean");
  }
  const queryName = value.queryName;
  if (typeof queryName !== "string" || !QUERY_NAMES.includes(queryName)) {
    throw new ValidationError(`query response: invalid queryName ${describe(queryName)}`);
  }
  if (ok) {
    if (!("result" in value)) {
      throw new ValidationError("query response: ok response is missing the result");
    }
    return;
  }
  assertClientError(value.error);
}

/**
 * Assert a command acknowledgement envelope before it crosses to the
 * preload: known commandName, echoed requestId, status exactly "accepted"
 * and a non-empty acceptedAt.
 */
export function assertClientCommandAccepted(
  value: unknown,
): asserts value is ClientCommandAccepted {
  assertPlainObject(value, "command accepted");
  assertNoUnknownKeys(
    value,
    ["commandName", "requestId", "status", "acceptedAt"],
    "command accepted",
  );
  const commandName = value.commandName;
  if (typeof commandName !== "string" || !COMMAND_NAMES.includes(commandName)) {
    throw new ValidationError(`command accepted: invalid commandName ${describe(commandName)}`);
  }
  assertOpaqueToken(value.requestId, "command accepted: requestId");
  if (value.status !== "accepted") {
    throw new ValidationError('command accepted: status must be exactly "accepted"');
  }
  assertNonEmptyText(value.acceptedAt, "command accepted: acceptedAt");
}

const EVENT_KINDS = [
  "snapshot",
  "state.changed",
  "command.accepted",
  "command.interactionRequired",
  "command.receipt",
  "runtime.changed",
  "resync.required",
  "diagnostics.changed",
] as const satisfies readonly ClientEvent["kind"][];

const EVENT_BASE_KEYS = [
  "kind",
  "authorityEpoch",
  "runtimeEpoch",
  "stateVersion",
  "cursor",
  "occurredAt",
] as const;

/** Assert a non-negative safe integer (epochs and state versions). */
function assertCounter(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field}: expected a non-negative safe integer`);
  }
}

function assertEventBase(value: Record<string, unknown>): void {
  const kind = value.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`event: unknown kind ${describe(kind)}`);
  }
  assertCounter(value.authorityEpoch, "event: authorityEpoch");
  assertCounter(value.stateVersion, "event: stateVersion");
  if (value.runtimeEpoch !== undefined) {
    assertCounter(value.runtimeEpoch, "event: runtimeEpoch");
  }
  assertOpaqueToken(value.cursor, "event: cursor");
  assertNonEmptyText(value.occurredAt, "event: occurredAt");
}

function assertEventKeys(
  value: Record<string, unknown>,
  what: string,
  extra: readonly string[],
): void {
  assertNoUnknownKeys(value, [...EVENT_BASE_KEYS, ...extra], what);
}

const INTERACTION_KINDS = [
  "confirm",
  "select",
  "input",
  "editor",
  "approval",
] as const satisfies readonly ClientInteraction["kind"][];

function assertOptionList(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new ValidationError("event: interaction options must be an array");
  }
  for (const option of value) {
    assertPlainObject(option, "event: interaction option");
    assertNoUnknownKeys(option, ["id", "label", "description"], "event: interaction option");
    assertNonEmptyText(option.id, "event: interaction option id");
    assertNonEmptyText(option.label, "event: interaction option label");
    if (option.description !== undefined && typeof option.description !== "string") {
      throw new ValidationError("event: interaction option description must be a string");
    }
  }
}

/** Assert a Host-issued interaction prompt shape. */
function assertClientInteraction(value: unknown): void {
  assertPlainObject(value, "event: interaction");
  assertOpaqueToken(value.interactionId, "event: interactionId");
  assertOpaqueToken(value.requestId, "event: interaction requestId");
  const kind = value.kind;
  if (typeof kind !== "string" || !(INTERACTION_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`event: interaction has unknown kind ${describe(kind)}`);
  }
  switch (kind) {
    case "confirm":
      assertNoUnknownKeys(
        value,
        ["kind", "interactionId", "requestId", "message", "destructive"],
        "event: interaction",
      );
      assertNonEmptyText(value.message, "event: interaction message");
      if (typeof value.destructive !== "boolean") {
        throw new ValidationError("event: interaction destructive must be a boolean");
      }
      return;
    case "select":
      assertNoUnknownKeys(
        value,
        ["kind", "interactionId", "requestId", "options", "multiple"],
        "event: interaction",
      );
      assertOptionList(value.options);
      if (typeof value.multiple !== "boolean") {
        throw new ValidationError("event: interaction multiple must be a boolean");
      }
      return;
    case "input":
      assertNoUnknownKeys(
        value,
        ["kind", "interactionId", "requestId", "placeholder", "secret"],
        "event: interaction",
      );
      if (value.placeholder !== undefined && typeof value.placeholder !== "string") {
        throw new ValidationError("event: interaction placeholder must be a string");
      }
      if (typeof value.secret !== "boolean") {
        throw new ValidationError("event: interaction secret must be a boolean");
      }
      return;
    case "editor":
      assertNoUnknownKeys(
        value,
        ["kind", "interactionId", "requestId", "content", "language"],
        "event: interaction",
      );
      if (value.content !== undefined && typeof value.content !== "string") {
        throw new ValidationError("event: interaction content must be a string");
      }
      if (value.language !== undefined && typeof value.language !== "string") {
        throw new ValidationError("event: interaction language must be a string");
      }
      return;
    case "approval":
      assertNoUnknownKeys(
        value,
        ["kind", "interactionId", "requestId", "approvalType", "detail"],
        "event: interaction",
      );
      assertNonEmptyText(value.approvalType, "event: interaction approvalType");
      assertPlainObject(value.detail, "event: interaction detail");
      return;
    default:
      throw new ValidationError(`event: unhandled interaction kind ${describe(kind)}`);
  }
}

const TERMINAL_STATUSES = [
  "completed",
  "failed",
  "rejected",
  "outcome_unknown",
] as const satisfies readonly CommandReceipt["status"][];

/** Assert a terminal command receipt shape, per-status exact fields. */
function assertCommandReceipt(value: unknown): void {
  assertPlainObject(value, "event: receipt");
  const commandName = value.commandName;
  if (typeof commandName !== "string" || !COMMAND_NAMES.includes(commandName)) {
    throw new ValidationError(`event: receipt has invalid commandName ${describe(commandName)}`);
  }
  assertOpaqueToken(value.requestId, "event: receipt requestId");
  assertNonEmptyText(value.observedAt, "event: receipt observedAt");
  const status = value.status;
  if (typeof status !== "string" || !(TERMINAL_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`event: receipt has unknown status ${describe(status)}`);
  }
  switch (status) {
    case "completed":
      assertNoUnknownKeys(
        value,
        ["requestId", "commandName", "status", "result", "observedAt"],
        "event: receipt",
      );
      if (!("result" in value)) {
        throw new ValidationError("event: completed receipt is missing the result");
      }
      return;
    case "failed":
      assertNoUnknownKeys(
        value,
        ["requestId", "commandName", "status", "error", "observedAt"],
        "event: receipt",
      );
      assertClientError(value.error);
      return;
    case "rejected":
    case "outcome_unknown":
      assertNoUnknownKeys(
        value,
        ["requestId", "commandName", "status", "reason", "observedAt"],
        "event: receipt",
      );
      assertNonEmptyText(value.reason, "event: receipt reason");
      return;
    default:
      throw new ValidationError(`event: unhandled receipt status ${describe(status)}`);
  }
}

const CONNECTION_STATUSES = [
  "connecting",
  "connected",
  "disconnected",
] as const satisfies readonly RuntimeConnectionStatus[];

const CONNECTION_CLASSIFICATIONS = [
  "managed",
  "compatible-system",
  "limited-system",
  "rejected",
] as const satisfies readonly RuntimeClassification[];

const RUNTIME_BACKENDS = ["studio-host", "rpc-ui", "acp"] as const satisfies readonly RuntimeBackend[];

/** Assert a runtime connection fact payload. */
function assertRuntimeConnection(value: unknown): void {
  assertPlainObject(value, "event: connection");
  assertNoUnknownKeys(
    value,
    [
      "status",
      "classification",
      "runtimeId",
      "runtimeEpoch",
      "backend",
      "runtimeVersion",
      "upstreamVersion",
      "upstreamCommit",
      "rejectionReason",
    ],
    "event: connection",
  );
  const status = value.status;
  if (typeof status !== "string" || !(CONNECTION_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`event: connection has unknown status ${describe(status)}`);
  }
  const classification = value.classification;
  if (
    typeof classification !== "string" ||
    !(CONNECTION_CLASSIFICATIONS as readonly string[]).includes(classification)
  ) {
    throw new ValidationError(
      `event: connection has unknown classification ${describe(classification)}`,
    );
  }
  if (value.runtimeId !== undefined && !isOpaqueToken(value.runtimeId)) {
    throw new ValidationError("event: connection runtimeId must be an opaque token");
  }
  if (value.runtimeEpoch !== undefined) {
    assertCounter(value.runtimeEpoch, "event: connection runtimeEpoch");
  }
  if (value.backend !== undefined) {
    if (
      typeof value.backend !== "string" ||
      !(RUNTIME_BACKENDS as readonly string[]).includes(value.backend)
    ) {
      throw new ValidationError(`event: connection has unknown backend ${describe(value.backend)}`);
    }
  }
  for (const field of [
    "runtimeVersion",
    "upstreamVersion",
    "upstreamCommit",
    "rejectionReason",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new ValidationError(`event: connection ${field} must be a string`);
    }
  }
}

/**
 * Assert a subscription event envelope before it crosses to the preload:
 * known kind, well-formed base fields (epochs, state version, cursor,
 * timestamp), exact per-kind keys and well-formed payloads.
 */
export function assertClientEvent(value: unknown): asserts value is ClientEvent {
  assertPlainObject(value, "event");
  const kind = value.kind;
  if (typeof kind !== "string" || !(EVENT_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`event: unknown kind ${describe(kind)}`);
  }
  switch (kind) {
    case "snapshot":
      assertEventKeys(value, "event", ["snapshot"]);
      assertEventBase(value);
      assertPlainObject(value.snapshot, "event: snapshot");
      return;
    case "state.changed":
    case "diagnostics.changed":
      assertEventKeys(value, "event", []);
      assertEventBase(value);
      return;
    case "command.accepted":
      assertEventKeys(value, "event", ["accepted"]);
      assertEventBase(value);
      assertClientCommandAccepted(value.accepted);
      return;
    case "command.interactionRequired":
      assertEventKeys(value, "event", ["interaction"]);
      assertEventBase(value);
      assertClientInteraction(value.interaction);
      return;
    case "command.receipt":
      assertEventKeys(value, "event", ["receipt"]);
      assertEventBase(value);
      assertCommandReceipt(value.receipt);
      return;
    case "runtime.changed":
      assertEventKeys(value, "event", ["connection"]);
      assertEventBase(value);
      assertRuntimeConnection(value.connection);
      return;
    case "resync.required":
      assertEventKeys(value, "event", ["reason"]);
      assertEventBase(value);
      assertNonEmptyText(value.reason, "event: reason");
      return;
    default:
      throw new ValidationError(`event: unhandled kind ${describe(kind)}`);
  }
}
