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
import {
  CONVERSATION_LIMITS,
  MODEL_CONFIG_THINKING_EFFORTS,
  SESSION_THINKING_SELECTORS,
  STUDIO_RUNTIME_CODE_MODES,
  STUDIO_RUNTIME_COMPACTION_METHODS,
  STUDIO_RUNTIME_SETTING_KEYS,
  STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS,
  STUDIO_RUNTIME_UNEXPECTED_STOP_MODES,
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
export const MAX_INTERACTION_TEXT_LENGTH = 128 * 1024;

/** Max elements of the top-level string-array `interaction.respond` value. */
export const MAX_INTERACTION_LIST_ITEMS = 256;

/** Max characters used by other text-bearing command inputs. */
export const MAX_TEXT_LENGTH = 100_000;

/** Max elements used by non-interaction command lists. */
export const MAX_LIST_ITEMS = 1_000;

/** Max object/array nesting depth inside an `interaction.respond` value. */
export const MAX_VALUE_DEPTH = 32;

/**
 * Conservative serialized-size proxy (code units, counted during the walk)
 * for an `interaction.respond` value. Approximate, not byte-exact; it fails
 * closed with margin.
 */
export const MAX_SERIALIZED_SIZE = MAX_INTERACTION_TEXT_LENGTH + 2;

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

const THINKING_SELECTOR_SET = new Set<string>(SESSION_THINKING_SELECTORS);
const MAX_MODEL_SELECTOR_CHARS = 256;

function assertThinkingSelector(value: unknown, field: string): void {
  if (typeof value !== "string" || !THINKING_SELECTOR_SET.has(value)) {
    throw new ValidationError(`${field}: unsupported thinking selector`);
  }
}

/** Reject objects with no allowed keys (the EmptyInput query shape). */
function validateEmptyInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, [], what);
}

function validateTranscriptPaginationFields(
  input: Record<string, unknown>,
  what: string,
): void {
  if ("cursor" in input) {
    const cursor = input.cursor;
    if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > CONVERSATION_LIMITS.CURSOR_MAX_CHARS) {
      throw new ValidationError(
        `${what}: cursor must be a non-empty string of at most ${CONVERSATION_LIMITS.CURSOR_MAX_CHARS} characters`,
      );
    }
  }
  if ("limit" in input) {
    const limit = input.limit;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN ||
      limit > CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX
    ) {
      throw new ValidationError(
        `${what}: limit must be an integer between ${CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN} and ${CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX}`,
      );
    }
  }
}

function validateTranscriptReadInput(input: unknown): void {
  const what = "session.transcript.read input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["cursor", "limit"], what);
  validateTranscriptPaginationFields(input, what);
}

function validateConversationOpenInput(input: unknown): void {
  const what = "conversation.open input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["target", "limit"], what);
  assertPlainObject(input.target, `${what}: target`);
  if (input.target.kind === "session") {
    assertNoUnknownKeys(input.target, ["kind", "sessionId"], `${what}: target`);
    assertOpaqueToken(input.target.sessionId, `${what}: target.sessionId`);
  } else if (input.target.kind === "agent") {
    assertNoUnknownKeys(input.target, ["kind", "parentSessionId", "agentId"], `${what}: target`);
    assertOpaqueToken(input.target.parentSessionId, `${what}: target.parentSessionId`);
    assertOpaqueToken(input.target.agentId, `${what}: target.agentId`);
  } else {
    throw new ValidationError(`${what}: target.kind must be session or agent`);
  }
  validateTranscriptPaginationFields(input, what);
}

function validateTranscriptReadPageInput(input: unknown): void {
  const what = "session.transcript.readPage input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["sessionId", "agentId", "cursor", "limit"], what);
  assertOpaqueToken(input.sessionId, `${what}: sessionId`);
  if (input.agentId !== undefined) assertOpaqueToken(input.agentId, `${what}: agentId`);
  validateTranscriptPaginationFields(input, what);
}

function validateSessionAgentsListInput(input: unknown): void {
  const what = "session.agents.list input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["sessionId"], what);
  assertOpaqueToken(input.sessionId, `${what}: sessionId`);
}

function validateSessionTelemetryReadInput(input: unknown): void {
  const what = "session.telemetry.read input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["sessionId"], what);
  assertOpaqueToken(input.sessionId, `${what}: sessionId`);
}

function validateAgentTranscriptReadInput(input: unknown): void {
  const what = "agent.transcript.read input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["agentId", "cursor", "limit"], what);
  assertOpaqueToken(input.agentId, `${what}: agentId`);
  validateTranscriptPaginationFields(input, what);
}

function validateAgentConversationReadInput(input: unknown): void {
  const what = "agent.conversation.read input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["agentId", "cursor", "limit"], what);
  assertOpaqueToken(input.agentId, `${what}: agentId`);
  validateTranscriptPaginationFields(input, what);
}

function validateAgentIdGenerationFields(input: Record<string, unknown>, what: string): void {
  assertOpaqueToken(input.agentId, `${what}: agentId`);
  if (
    typeof input.expectedGeneration !== "number" ||
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 1
  ) {
    throw new ValidationError(`${what}: expectedGeneration must be a positive safe integer`);
  }
}

function validateAgentSpawnInput(input: unknown): void {
  const what = "agent.spawn input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["definition", "assignment", "context", "async", "isolation", "effort"], what);
  assertNonEmptyText(input.definition, `${what}: definition`);
  assertNonEmptyText(input.assignment, `${what}: assignment`);
  if ("context" in input && input.context !== undefined) {
    if (typeof input.context !== "string" || input.context.trim().length === 0) {
      throw new ValidationError(`${what}: context must be a non-empty string when present`);
    }
  }
  if ("async" in input && input.async !== undefined && typeof input.async !== "boolean") {
    throw new ValidationError(`${what}: async must be boolean when present`);
  }
  if (
    "isolation" in input &&
    input.isolation !== undefined &&
    input.isolation !== "patch" &&
    input.isolation !== "branch"
  ) {
    throw new ValidationError(`${what}: isolation must be patch or branch when present`);
  }
  if (
    "effort" in input &&
    input.effort !== undefined &&
    input.effort !== "lo" &&
    input.effort !== "med" &&
    input.effort !== "hi"
  ) {
    throw new ValidationError(`${what}: effort must be lo, med, or hi when present`);
  }
}

function validateAgentSendInput(input: unknown): void {
  const what = "agent.send input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["agentId", "expectedGeneration", "text", "mode", "images"], what);
  validateAgentIdGenerationFields(input, what);
  assertNonEmptyText(input.text, `${what}: text`);
  if (input.mode !== "prompt" && input.mode !== "steer" && input.mode !== "followUp") {
    throw new ValidationError(`${what}: mode must be prompt, steer, or followUp`);
  }
  if (input.images !== undefined) validatePromptImages(input.images, what);
}

function validateAgentLifecycleInput(input: unknown): void {
  const what = "agent lifecycle input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["agentId", "expectedGeneration"], what);
  validateAgentIdGenerationFields(input, what);
}

function validateJobCancelInput(input: unknown): void {
  const what = "job.cancel input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["jobId", "expectedGeneration"], what);
  assertOpaqueToken(input.jobId, `${what}: jobId`);
  if (
    typeof input.expectedGeneration !== "number" ||
    !Number.isSafeInteger(input.expectedGeneration) ||
    input.expectedGeneration < 1
  ) {
    throw new ValidationError(`${what}: expectedGeneration must be a positive safe integer`);
  }
}

function validateHistoryListInput(input: unknown): void {
  assertPlainObject(input, "history.list input");
  assertNoUnknownKeys(input, ["limit", "status", "workspaceId"], "history.list input");
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
  if ("status" in input) {
    const status = input.status;
    if (status !== "active" && status !== "archived" && status !== "closed") {
      throw new ValidationError("history.list input: status must be active, archived or closed");
    }
  }
  if (input.workspaceId !== undefined) {
    assertOpaqueToken(input.workspaceId, "history.list input: workspaceId");
  }
}

function validateWorkspaceFilePath(value: unknown, what: string): void {
  assertNonEmptyText(value, what);
  if (value.length > 1_000 || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new ValidationError(`${what}: path must be a relative workspace path`);
  }
  const parts = value.replaceAll("\\", "/").split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ValidationError(`${what}: path must stay inside the workspace`);
  }
}

function validateWorkspaceFileTreeInput(input: unknown): void {
  assertPlainObject(input, "workspace.fileTree input");
  assertNoUnknownKeys(input, ["workspaceId", "path"], "workspace.fileTree input");
  assertOpaqueToken(input.workspaceId, "workspace.fileTree input: workspaceId");
  if (input.path !== undefined) validateWorkspaceFilePath(input.path, "workspace.fileTree input: path");
}

function validateWorkspaceFileMutationInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "path"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  validateWorkspaceFilePath(input.path, `${what}: path`);
}

function validateWorkspaceSelector(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
}

function validateOptionalWorkspaceSelector(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId"], what);
  if (input.workspaceId !== undefined) assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
}

function validateGitRef(value: unknown, what: string): void {
  assertNonEmptyText(value, what);
  if (value.length > MAX_ID_LENGTH || value.startsWith("-") || /[\0\r\n]/u.test(value)) {
    throw new ValidationError(`${what}: invalid Git ref`);
  }
}

function validateGitRemoteUrl(value: unknown, what: string): void {
  assertNonEmptyText(value, what);
  if (value.length > 4_096 || value.startsWith("-") || /[\0\r\n\t ]/u.test(value)) {
    throw new ValidationError(`${what}: invalid remote URL`);
  }
  if (!value.includes("://") && !value.includes("::") && /^(?:[^@/:\s]+@)?[^/:\s]+:[^:\s][^\s]*$/u.test(value) && !/^[A-Za-z]:/u.test(value)) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new ValidationError(`${what}: remote URL must use https, http, ssh, git, or SCP syntax`); }
  if (!(["https:", "http:", "ssh:", "git:"] as const).includes(parsed.protocol as "https:" | "http:" | "ssh:" | "git:") || parsed.hostname.length === 0 || parsed.password.length > 0) {
    throw new ValidationError(`${what}: remote URL must use https, http, ssh, git, or SCP syntax without a password`);
  }
}

function validateBoundedText(value: unknown, what: string, maximum = MAX_TEXT_LENGTH): void {
  if (typeof value !== "string" || value.length > maximum) throw new ValidationError(`${what}: text exceeds the max length of ${maximum}`);
}

function validateGitPaths(value: unknown, what: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
    throw new ValidationError(`${what}: paths must be a non-empty bounded array`);
  }
  for (const path of value) validateWorkspaceFilePath(path, `${what}: path`);
}

function validateOptionalBoolean(value: unknown, what: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new ValidationError(`${what}: must be boolean`);
}

function validatePositiveInteger(value: unknown, what: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`${what}: must be a positive integer`);
  }
}

function validateGitDiffInput(input: unknown): void {
  const what = "git.diff.get input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "path", "target"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  validateWorkspaceFilePath(input.path, `${what}: path`);
  if (input.target !== "working" && input.target !== "staged") throw new ValidationError(`${what}: invalid target`);
}

function validateGitLogInput(input: unknown): void {
  const what = "git.log.list input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "limit", "skip"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  if (input.limit !== undefined) {
    if (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200) {
      throw new ValidationError(`${what}: limit must be an integer from 1 to 200`);
    }
  }
  if (input.skip !== undefined) {
    if (typeof input.skip !== "number" || !Number.isSafeInteger(input.skip) || input.skip < 0) {
      throw new ValidationError(`${what}: skip must be a non-negative integer`);
    }
  }
}

function validateGitCommitChangesInput(input: unknown): void {
  const what = "git.commit.changes input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "oid"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  validateGitRef(input.oid, `${what}: oid`);
}

function validateGitCommitDiffInput(input: unknown): void {
  const what = "git.commit.diff input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "oid", "path"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  validateGitRef(input.oid, `${what}: oid`);
  validateWorkspaceFilePath(input.path, `${what}: path`);
}

function validateGithubPrListInput(input: unknown): void {
  const what = "github.pr.list input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "state"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  if (input.state !== undefined && input.state !== "open" && input.state !== "closed" && input.state !== "merged" && input.state !== "all") {
    throw new ValidationError(`${what}: invalid state`);
  }
}

function validateGithubPrNumberInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "number"], what);
  assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  validatePositiveInteger(input.number, `${what}: number`);
}

function validateGitExecuteInput(input: unknown): void {
  const what = "git.execute input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "operation"], what);
  if (input.workspaceId !== undefined) assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  assertPlainObject(input.operation, `${what}: operation`);
  const operation = input.operation;
  assertNonEmptyText(operation.kind, `${what}: operation.kind`);
  const bool = (key: string) => validateOptionalBoolean(operation[key], `${what}: ${key}`);
  const ref = (key: string, required = false) => {
    if (required || operation[key] !== undefined) validateGitRef(operation[key], `${what}: ${key}`);
  };
  switch (operation.kind) {
    case "init":
    case "worktree.pickRoot":
      assertNoUnknownKeys(operation, ["kind"], `${what}: operation`);
      break;
    case "clone":
      assertNoUnknownKeys(operation, ["kind", "url", "directoryName"], `${what}: operation`);
      validateGitRemoteUrl(operation.url, `${what}: url`);
      if (operation.directoryName !== undefined) validateWorkspaceFilePath(operation.directoryName, `${what}: directoryName`);
      return;
    case "stage":
    case "unstage":
      assertNoUnknownKeys(operation, ["kind", "paths"], `${what}: operation`);
      validateGitPaths(operation.paths, what);
      break;
    case "discard":
      assertNoUnknownKeys(operation, ["kind", "paths", "expectedRevision"], `${what}: operation`);
      validateGitPaths(operation.paths, what);
      assertOpaqueToken(operation.expectedRevision, `${what}: expectedRevision`);
      break;
    case "commit":
      assertNoUnknownKeys(operation, ["kind", "message", "amend", "sign", "paths"], `${what}: operation`);
      assertNonEmptyText(operation.message, `${what}: message`);
      if (operation.message.length > MAX_TEXT_LENGTH) throw new ValidationError(`${what}: message is too long`);
      bool("amend"); bool("sign");
      if (operation.paths !== undefined) validateGitPaths(operation.paths, what);
      break;
    case "branch.create":
      assertNoUnknownKeys(operation, ["kind", "name", "startPoint", "checkout"], `${what}: operation`);
      ref("name", true); ref("startPoint"); bool("checkout");
      break;
    case "branch.switch":
      assertNoUnknownKeys(operation, ["kind", "name"], `${what}: operation`); ref("name", true);
      break;
    case "branch.rename":
      assertNoUnknownKeys(operation, ["kind", "oldName", "newName"], `${what}: operation`); ref("oldName"); ref("newName", true);
      break;
    case "branch.delete":
      assertNoUnknownKeys(operation, ["kind", "name", "force", "expectedRevision"], `${what}: operation`); ref("name", true); bool("force"); if (operation.expectedRevision !== undefined) assertOpaqueToken(operation.expectedRevision, `${what}: expectedRevision`);
      break;
    case "worktree.create":
      assertNoUnknownKeys(operation, ["kind", "branch", "startPoint", "createBranch", "directoryName"], `${what}: operation`); ref("branch", true); ref("startPoint"); bool("createBranch"); if (operation.directoryName !== undefined) validateWorkspaceFilePath(operation.directoryName, `${what}: directoryName`);
      break;
    case "worktree.lock":
      assertNoUnknownKeys(operation, ["kind", "worktreeId", "reason"], `${what}: operation`); assertOpaqueToken(operation.worktreeId, `${what}: worktreeId`); if (operation.reason !== undefined) assertNonEmptyText(operation.reason, `${what}: reason`);
      break;
    case "worktree.unlock":
      assertNoUnknownKeys(operation, ["kind", "worktreeId"], `${what}: operation`); assertOpaqueToken(operation.worktreeId, `${what}: worktreeId`);
      break;
    case "worktree.remove":
      assertNoUnknownKeys(operation, ["kind", "worktreeId", "force", "expectedRevision"], `${what}: operation`); assertOpaqueToken(operation.worktreeId, `${what}: worktreeId`); bool("force"); if (operation.expectedRevision !== undefined) assertOpaqueToken(operation.expectedRevision, `${what}: expectedRevision`);
      break;
    case "worktree.prune":
      assertNoUnknownKeys(operation, ["kind", "dryRun"], `${what}: operation`); bool("dryRun");
      break;
    case "remote.add":
    case "remote.setUrl":
      assertNoUnknownKeys(operation, operation.kind === "remote.add" ? ["kind", "name", "url"] : ["kind", "name", "url", "push"], `${what}: operation`); ref("name", true); validateGitRemoteUrl(operation.url, `${what}: url`); if (operation.kind === "remote.setUrl") bool("push");
      break;
    case "remote.remove":
      assertNoUnknownKeys(operation, ["kind", "name"], `${what}: operation`); ref("name", true);
      break;
    case "fetch":
      assertNoUnknownKeys(operation, ["kind", "remote", "prune"], `${what}: operation`); ref("remote"); bool("prune");
      break;
    case "pull":
      assertNoUnknownKeys(operation, ["kind", "strategy", "remote", "branch"], `${what}: operation`); if (operation.strategy !== "ff-only" && operation.strategy !== "rebase" && operation.strategy !== "merge") throw new ValidationError(`${what}: invalid pull strategy`); ref("remote"); ref("branch");
      break;
    case "push":
      assertNoUnknownKeys(operation, ["kind", "remote", "branch", "setUpstream", "forceWithLease", "expectedRemoteOid"], `${what}: operation`); ref("remote"); ref("branch"); bool("setUpstream"); bool("forceWithLease"); if (operation.expectedRemoteOid !== undefined) assertOpaqueToken(operation.expectedRemoteOid, `${what}: expectedRemoteOid`); if (operation.forceWithLease === true && operation.expectedRemoteOid === undefined) throw new ValidationError(`${what}: forceWithLease requires expectedRemoteOid`);
      break;
    case "stash.push":
      assertNoUnknownKeys(operation, ["kind", "message", "includeUntracked"], `${what}: operation`); if (operation.message !== undefined) assertNonEmptyText(operation.message, `${what}: message`); bool("includeUntracked");
      break;
    case "stash.apply":
      assertNoUnknownKeys(operation, ["kind", "stash", "pop"], `${what}: operation`); ref("stash"); bool("pop");
      break;
    case "stash.drop":
      assertNoUnknownKeys(operation, ["kind", "stash", "expectedRevision"], `${what}: operation`); ref("stash", true); assertOpaqueToken(operation.expectedRevision, `${what}: expectedRevision`);
      break;
    case "tag.create":
      assertNoUnknownKeys(operation, ["kind", "name", "target", "message"], `${what}: operation`); ref("name", true); ref("target"); if (operation.message !== undefined) assertNonEmptyText(operation.message, `${what}: message`);
      break;
    case "tag.delete":
      assertNoUnknownKeys(operation, ["kind", "name"], `${what}: operation`); ref("name", true);
      break;
    case "merge":
      assertNoUnknownKeys(operation, ["kind", "ref", "noFastForward"], `${what}: operation`); ref("ref", true); bool("noFastForward");
      break;
    case "rebase":
    case "cherry-pick":
    case "revert":
    case "checkout":
      assertNoUnknownKeys(operation, ["kind", "ref"], `${what}: operation`); ref("ref", true);
      break;
    case "reset":
      assertNoUnknownKeys(operation, ["kind", "mode", "ref", "expectedRevision"], `${what}: operation`); if (operation.mode !== "soft" && operation.mode !== "mixed" && operation.mode !== "hard") throw new ValidationError(`${what}: invalid reset mode`); ref("ref", true); assertOpaqueToken(operation.expectedRevision, `${what}: expectedRevision`);
      break;
    case "continue":
    case "abort":
      assertNoUnknownKeys(operation, ["kind", "operation"], `${what}: operation`); if (operation.operation !== "merge" && operation.operation !== "rebase" && operation.operation !== "cherry-pick" && operation.operation !== "revert") throw new ValidationError(`${what}: invalid in-progress operation`);
      break;
    case "cancel":
      assertNoUnknownKeys(operation, ["kind", "requestId"], `${what}: operation`); assertOpaqueToken(operation.requestId, `${what}: requestId`);
      return;
    default:
      throw new ValidationError(`${what}: unknown operation kind`);
  }
  if (input.workspaceId === undefined) throw new ValidationError(`${what}: workspaceId is required for this operation`);
}

function validateGithubExecuteInput(input: unknown): void {
  const what = "github.execute input";
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["workspaceId", "operation"], what);
  if (input.workspaceId !== undefined) assertOpaqueToken(input.workspaceId, `${what}: workspaceId`);
  assertPlainObject(input.operation, `${what}: operation`);
  const operation = input.operation;
  switch (operation.kind) {
    case "auth.login":
      assertNoUnknownKeys(operation, ["kind", "host", "gitProtocol"], `${what}: operation`);
      if (operation.host !== undefined) validateGitRef(operation.host, `${what}: host`);
      if (operation.gitProtocol !== undefined && operation.gitProtocol !== "https" && operation.gitProtocol !== "ssh") throw new ValidationError(`${what}: invalid gitProtocol`);
      return;
    case "auth.logout":
      assertNoUnknownKeys(operation, ["kind", "host"], `${what}: operation`);
      if (operation.host !== undefined) validateGitRef(operation.host, `${what}: host`);
      return;
    case "pr.create":
      assertNoUnknownKeys(operation, ["kind", "title", "body", "base", "head", "draft"], `${what}: operation`); assertNonEmptyText(operation.title, `${what}: title`); validateBoundedText(operation.title, `${what}: title`, 256); validateBoundedText(operation.body, `${what}: body`); validateGitRef(operation.base, `${what}: base`); if (operation.head !== undefined) validateGitRef(operation.head, `${what}: head`); validateOptionalBoolean(operation.draft, `${what}: draft`);
      break;
    case "pr.edit":
      assertNoUnknownKeys(operation, ["kind", "number", "title", "body", "base"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); if (operation.title !== undefined) { assertNonEmptyText(operation.title, `${what}: title`); validateBoundedText(operation.title, `${what}: title`, 256); } if (operation.body !== undefined) validateBoundedText(operation.body, `${what}: body`); if (operation.base !== undefined) validateGitRef(operation.base, `${what}: base`);
      break;
    case "pr.ready":
      assertNoUnknownKeys(operation, ["kind", "number", "undo"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); validateOptionalBoolean(operation.undo, `${what}: undo`);
      break;
    case "pr.comment":
      assertNoUnknownKeys(operation, ["kind", "number", "body"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); assertNonEmptyText(operation.body, `${what}: body`); validateBoundedText(operation.body, `${what}: body`);
      break;
    case "pr.review":
      assertNoUnknownKeys(operation, ["kind", "number", "decision", "body"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); if (operation.decision !== "approve" && operation.decision !== "comment" && operation.decision !== "request-changes") throw new ValidationError(`${what}: invalid review decision`); if (operation.body !== undefined) validateBoundedText(operation.body, `${what}: body`);
      break;
    case "pr.updateBranch":
      assertNoUnknownKeys(operation, ["kind", "number", "rebase"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); validateOptionalBoolean(operation.rebase, `${what}: rebase`);
      break;
    case "pr.merge":
      assertNoUnknownKeys(operation, ["kind", "number", "method", "expectedHeadOid", "auto", "deleteBranch"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); if (operation.method !== "merge" && operation.method !== "squash" && operation.method !== "rebase") throw new ValidationError(`${what}: invalid merge method`); assertOpaqueToken(operation.expectedHeadOid, `${what}: expectedHeadOid`); validateOptionalBoolean(operation.auto, `${what}: auto`); validateOptionalBoolean(operation.deleteBranch, `${what}: deleteBranch`);
      break;
    case "pr.close":
      assertNoUnknownKeys(operation, ["kind", "number", "comment", "deleteBranch"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`); if (operation.comment !== undefined) { assertNonEmptyText(operation.comment, `${what}: comment`); validateBoundedText(operation.comment, `${what}: comment`); } validateOptionalBoolean(operation.deleteBranch, `${what}: deleteBranch`);
      break;
    case "pr.reopen":
    case "pr.checkout":
      assertNoUnknownKeys(operation, ["kind", "number"], `${what}: operation`); validatePositiveInteger(operation.number, `${what}: number`);
      break;
    case "cancel":
      assertNoUnknownKeys(operation, ["kind", "requestId"], `${what}: operation`); assertOpaqueToken(operation.requestId, `${what}: requestId`);
      return;
    default:
      throw new ValidationError(`${what}: unknown operation kind`);
  }
  if (input.workspaceId === undefined) throw new ValidationError(`${what}: workspaceId is required for PR operations`);
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
  validateNamedTextInput(input, what, "text");
}

/** Single-field command input whose value is an opaque Runtime-minted token. */
function validateOpaqueIdInput(input: unknown, what: string, field: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, [field], what);
  assertOpaqueToken(input[field], `${what}: ${field}`);
}

function validateNamedTextInput(input: unknown, what: string, field: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, [field], what);
  assertNonEmptyText(input[field], `${what}: ${field}`);
  if ((input[field] as string).length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${what}: ${field} exceeds the max length of ${MAX_TEXT_LENGTH}`);
  }
}

const PROMPT_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Maximum number of image attachments accepted in one prompt command. */
export const MAX_PROMPT_IMAGES = 16;

/**
 * Maximum decoded bytes for one image. 16 MiB keeps one IPC attachment from
 * dominating the Main process while remaining above ordinary screenshots.
 */
export const MAX_PROMPT_IMAGE_BYTES = 16 * 1024 * 1024;

/**
 * Maximum decoded bytes across all images in one prompt command. 64 MiB
 * bounds the aggregate memory amplification from the 16-image allowance.
 */
export const MAX_PROMPT_IMAGES_TOTAL_BYTES = 64 * 1024 * 1024;

/** Reject oversized encoded payloads before scanning/decoding their contents. */
const MAX_PROMPT_IMAGE_BASE64_LENGTH = Math.ceil((MAX_PROMPT_IMAGE_BYTES + 2) / 3) * 4;

function base64CharacterValue(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

/**
 * Return the exact decoded byte count for canonical Base64 without calling
 * `atob`/`Buffer`, which would allocate a second large copy at the boundary.
 */
function decodedBase64Bytes(value: string, field: string): number {
  if (value.length === 0) {
    throw new ValidationError(`${field}: data must be a non-empty Base64 string`);
  }
  if (value.length > MAX_PROMPT_IMAGE_BASE64_LENGTH) {
    throw new ValidationError(`${field}: data exceeds the max decoded image size of ${MAX_PROMPT_IMAGE_BYTES} bytes`);
  }
  if (value.length % 4 !== 0) {
    throw new ValidationError(`${field}: data must be canonical Base64 with valid padding`);
  }
  let padding = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x3d) {
      if (index < value.length - 2 || padding === 2) {
        throw new ValidationError(`${field}: data must be canonical Base64 with valid padding`);
      }
      padding += 1;
      continue;
    }
    if (padding > 0 || base64CharacterValue(code) < 0) {
      throw new ValidationError(`${field}: data must be canonical Base64 with valid padding`);
    }
  }
  if (padding === 2 && (base64CharacterValue(value.charCodeAt(value.length - 3)) & 0x0f) !== 0) {
    throw new ValidationError(`${field}: data must be canonical Base64 with valid padding`);
  }
  if (padding === 1 && (base64CharacterValue(value.charCodeAt(value.length - 2)) & 0x03) !== 0) {
    throw new ValidationError(`${field}: data must be canonical Base64 with valid padding`);
  }
  return (value.length / 4) * 3 - padding;
}

export function validatePromptImages(value: unknown, what: string): void {
  if (!Array.isArray(value)) throw new ValidationError(`${what}: images must be an array`);
  if (value.length > MAX_PROMPT_IMAGES) {
    throw new ValidationError(`${what}: images exceeds the max count of ${MAX_PROMPT_IMAGES}`);
  }
  let totalBytes = 0;
  for (const [index, image] of value.entries()) {
    const field = `${what}: images[${index}]`;
    assertPlainObject(image, field);
    assertNoUnknownKeys(image, ["type", "mimeType", "data"], field);
    if (image.type !== "image") throw new ValidationError(`${field}: type must be "image"`);
    if (typeof image.mimeType !== "string" || !PROMPT_IMAGE_MIME.has(image.mimeType)) {
      throw new ValidationError(`${field}: unsupported mimeType`);
    }
    if (typeof image.data !== "string") {
      throw new ValidationError(`${field}: data must be a non-empty Base64 string`);
    }
    const decodedBytes = decodedBase64Bytes(image.data, field);
    if (decodedBytes > MAX_PROMPT_IMAGE_BYTES) {
      throw new ValidationError(`${field}: decoded data exceeds the max image size of ${MAX_PROMPT_IMAGE_BYTES} bytes`);
    }
    totalBytes += decodedBytes;
    if (totalBytes > MAX_PROMPT_IMAGES_TOTAL_BYTES) {
      throw new ValidationError(
        `${what}: decoded images exceed the max total size of ${MAX_PROMPT_IMAGES_TOTAL_BYTES} bytes`,
      );
    }
  }
}

function validatePromptInput(input: unknown, what: string): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["text", "images"], what);
  assertNonEmptyText(input.text, `${what}: text`);
  if (input.text.length > MAX_TEXT_LENGTH) {
    throw new ValidationError(`${what}: text exceeds the max length of ${MAX_TEXT_LENGTH}`);
  }
  if (input.images !== undefined) validatePromptImages(input.images, what);
}

function validateEmptyCommandInput(input: unknown, what: string): void {
  validateEmptyInput(input, what);
}

function validateRuntimeEnsureInput(input: unknown): void {
  assertPlainObject(input, "runtime.ensure input");
  assertNoUnknownKeys(input, ["force"], "runtime.ensure input");
  if (input.force !== undefined && typeof input.force !== "boolean") {
    throw new ValidationError("runtime.ensure input: force must be boolean");
  }
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
  if (
    input.decision !== "execute" &&
    input.decision !== "compact" &&
    input.decision !== "keep" &&
    input.decision !== "approve" &&
    input.decision !== "refine" &&
    input.decision !== "dismiss"
  ) {
    throw new ValidationError("mode.plan.review.respond input: invalid decision");
  }
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

function validateTreeBranchInput(input: unknown): void {
  assertPlainObject(input, "session.tree.branch input");
  assertNoUnknownKeys(input, ["targetId"], "session.tree.branch input");
  assertOpaqueToken(input.targetId, "session.tree.branch input: targetId");
}

function validatePauseResumeInput(input: unknown): void {
  assertPlainObject(input, "runtime.resume input");
  assertNoUnknownKeys(input, ["expectedPauseEpoch"], "runtime.resume input");
  if (typeof input.expectedPauseEpoch !== "number" || !Number.isSafeInteger(input.expectedPauseEpoch) || input.expectedPauseEpoch < 0) {
    throw new ValidationError("runtime.resume input: expectedPauseEpoch must be a non-negative safe integer");
  }
}

function validateRuntimeSettingValue(key: unknown, value: unknown, what: string): void {
  if (typeof key !== "string" || !STUDIO_RUNTIME_SETTING_KEYS.includes(key as (typeof STUDIO_RUNTIME_SETTING_KEYS)[number])) {
    throw new ValidationError(`${what}: unsupported setting key`);
  }
  switch (key) {
    case "edit.autoRepair.enabled":
    case "extendedContext":
    case "compaction.asyncEnabled":
      if (typeof value !== "boolean") throw new ValidationError(`${what}: value must be boolean`);
      return;
    case "features.unexpectedStopDetection":
      if (!STUDIO_RUNTIME_UNEXPECTED_STOP_MODES.includes(value as (typeof STUDIO_RUNTIME_UNEXPECTED_STOP_MODES)[number])) {
        throw new ValidationError(`${what}: invalid unexpected-stop detection mode`);
      }
      return;
    case "providers.unexpectedStopModel":
      if (!STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS.includes(value as (typeof STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS)[number])) {
        throw new ValidationError(`${what}: invalid unexpected-stop model`);
      }
      return;
    case "providers.openai-codex.codeMode":
      if (!STUDIO_RUNTIME_CODE_MODES.includes(value as (typeof STUDIO_RUNTIME_CODE_MODES)[number])) {
        throw new ValidationError(`${what}: invalid code mode`);
      }
      return;
    case "compaction.methodOrder":
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((method) => !STUDIO_RUNTIME_COMPACTION_METHODS.includes(method as (typeof STUDIO_RUNTIME_COMPACTION_METHODS)[number])) ||
        new Set(value).size !== value.length
      ) {
        throw new ValidationError(`${what}: value must be a non-empty unique compaction method list`);
      }
      return;
  }
}

function validateRuntimeSettingsGetInput(input: unknown): void {
  assertPlainObject(input, "runtime.settings.get input");
  assertNoUnknownKeys(input, ["keys"], "runtime.settings.get input");
  if (input.keys === undefined) return;
  if (
    !Array.isArray(input.keys) ||
    input.keys.length === 0 ||
    input.keys.length > STUDIO_RUNTIME_SETTING_KEYS.length ||
    input.keys.some((key) => !STUDIO_RUNTIME_SETTING_KEYS.includes(key as (typeof STUDIO_RUNTIME_SETTING_KEYS)[number])) ||
    new Set(input.keys).size !== input.keys.length
  ) {
    throw new ValidationError("runtime.settings.get input: keys must be a non-empty unique supported setting list");
  }
}

function validateRuntimeSettingsSetInput(input: unknown): void {
  assertPlainObject(input, "runtime.settings.set input");
  assertNoUnknownKeys(input, ["key", "value", "persist"], "runtime.settings.set input");
  validateRuntimeSettingValue(input.key, input.value, "runtime.settings.set input");
  if (typeof input.persist !== "boolean") throw new ValidationError("runtime.settings.set input: persist must be boolean");
}

function validatePlanSaveAndQuitInput(input: unknown): void {
  assertPlainObject(input, "mode.plan.review.saveAndQuit input");
  assertNoUnknownKeys(input, ["path"], "mode.plan.review.saveAndQuit input");
  assertNonEmptyText(input.path, "mode.plan.review.saveAndQuit input: path");
  if (
    input.path.length > 1024 ||
    input.path.includes("\0") ||
    input.path !== input.path.trim() ||
    ((input.path.startsWith('"') && input.path.endsWith('"')) || (input.path.startsWith("'") && input.path.endsWith("'")))
  ) {
    throw new ValidationError("mode.plan.review.saveAndQuit input: invalid path length or NUL");
  }
  const normalized = input.path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    /^[A-Za-z]:/.test(input.path) ||
    normalized.endsWith("/")
  ) {
    throw new ValidationError("mode.plan.review.saveAndQuit input: path must be workspace-relative");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw new ValidationError("mode.plan.review.saveAndQuit input: path escapes the workspace");
  }
  if (segments.every((segment) => segment.length === 0 || segment === ".")) {
    throw new ValidationError("mode.plan.review.saveAndQuit input: path must name a file");
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
      if (value.length > MAX_INTERACTION_TEXT_LENGTH) {
        throw new ValidationError(
          `interaction.respond value: string exceeds the max length of ${MAX_INTERACTION_TEXT_LENGTH}`,
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
    if (value.length > MAX_INTERACTION_LIST_ITEMS) {
      throw new ValidationError(
        `interaction.respond value: array exceeds the max length of ${MAX_INTERACTION_LIST_ITEMS}`,
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
  assertNoUnknownKeys(input, ["interactionId", "leaseGeneration", "decision", "value"], "interaction.respond input");
  assertOpaqueToken(input.interactionId, "interaction.respond input: interactionId");
  if (
    typeof input.leaseGeneration !== "number" ||
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration <= 0
  ) {
    throw new ValidationError("interaction.respond input: leaseGeneration must be a positive safe integer");
  }
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

function validateThinkingEfforts(value: unknown, what: string): void {
  if (!Array.isArray(value)) throw new ValidationError(`${what} must be an array`);
  if (value.length > MODEL_CONFIG_THINKING_EFFORTS.length) {
    throw new ValidationError(`${what} exceeds max length`);
  }
  for (const item of value) {
    if (typeof item !== "string" || !(MODEL_CONFIG_THINKING_EFFORTS as readonly string[]).includes(item)) {
      throw new ValidationError(`${what}: invalid effort`);
    }
  }
}

const MODEL_OVERRIDE_KEYS = [
  "name",
  "contextWindow",
  "maxTokens",
  "reasoning",
  "image",
  "tools",
  "cost",
  "omitMaxOutputTokens",
  "premiumMultiplier",
  "headers",
  "contextPromotionTarget",
  "compactionModel",
  "remoteCompaction",
  "thinking",
] as const;

const MODEL_PROVIDER_MODEL_KEYS = ["id", "api", "baseUrl", ...MODEL_OVERRIDE_KEYS] as const;

function validateModelPatchFields(item: Record<string, unknown>, what: string): void {
  if (item.name !== undefined) assertNonEmptyText(item.name, `${what}.name`);
  if (item.contextWindow !== undefined && (typeof item.contextWindow !== "number" || !Number.isSafeInteger(item.contextWindow) || item.contextWindow <= 0)) {
    throw new ValidationError(`${what}.contextWindow must be a positive integer`);
  }
  if (item.maxTokens !== undefined && (typeof item.maxTokens !== "number" || !Number.isSafeInteger(item.maxTokens) || item.maxTokens <= 0)) {
    throw new ValidationError(`${what}.maxTokens must be a positive integer`);
  }
  if (item.reasoning !== undefined && typeof item.reasoning !== "boolean") throw new ValidationError(`${what}.reasoning must be boolean`);
  if (item.image !== undefined && typeof item.image !== "boolean") throw new ValidationError(`${what}.image must be boolean`);
  if (item.tools !== undefined && typeof item.tools !== "boolean") throw new ValidationError(`${what}.tools must be boolean`);
  if (item.thinking !== undefined) validateThinkingEfforts(item.thinking, `${what}.thinking`);
}

function validateModelsProviderModels(input: unknown, what: string): void {
  if (!Array.isArray(input)) throw new ValidationError(`${what}: models must be an array`);
  if (input.length > MAX_LIST_ITEMS) throw new ValidationError(`${what}: models exceeds max length`);
  for (const item of input) {
    assertPlainObject(item, `${what}: model`);
    assertNoUnknownKeys(item, MODEL_PROVIDER_MODEL_KEYS, `${what}: model`);
    assertNonEmptyText(item.id, `${what}: model.id`);
    if (item.api !== undefined) assertNonEmptyText(item.api, `${what}: model.api`);
    if (item.baseUrl !== undefined) assertNonEmptyText(item.baseUrl, `${what}: model.baseUrl`);
    validateModelPatchFields(item, `${what}: model`);
  }
}

function validateModelsProviderOverrides(input: unknown, what: string): void {
  assertPlainObject(input, what);
  for (const [modelId, patch] of Object.entries(input)) {
    assertNonEmptyText(modelId, `${what}: model id`);
    assertPlainObject(patch, `${what}: ${modelId}`);
    assertNoUnknownKeys(patch, MODEL_OVERRIDE_KEYS, `${what}: ${modelId}`);
    validateModelPatchFields(patch, `${what}: ${modelId}`);
  }
}

function validateModelsProviderUpsertInput(input: unknown): void {
  assertPlainObject(input, "models.provider.upsert input");
  assertNoUnknownKeys(
    input,
    ["id", "name", "website", "note", "api", "endpointUrl", "local", "enabled", "auth", "discovery", "models", "modelOverrides", "expectedHash", "headers", "disableStrictTools", "transport", "remoteCompaction"],
    "models.provider.upsert input",
  );
  assertNonEmptyText(input.id, "models.provider.upsert input: id");
  assertNonEmptyText(input.name, "models.provider.upsert input: name");
  assertNonEmptyText(input.api, "models.provider.upsert input: api");
  if (input.website !== undefined) assertNonEmptyText(input.website, "models.provider.upsert input: website");
  if (input.note !== undefined && typeof input.note !== "string") throw new ValidationError("models.provider.upsert input: note must be a string");
  if (input.endpointUrl !== undefined) {
    if (typeof input.endpointUrl !== "string") throw new ValidationError("models.provider.upsert input: endpointUrl must be a string");
    if (input.endpointUrl.length > MAX_TEXT_LENGTH) throw new ValidationError("models.provider.upsert input: endpointUrl exceeds max length");
  }
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
  if (input.modelOverrides !== undefined && input.modelOverrides !== null) {
    validateModelsProviderOverrides(input.modelOverrides, "models.provider.upsert input: modelOverrides");
  }
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
  if (typeof input.selector !== "string") throw new ValidationError("models.roles.set input: selector must be a string");
  if (input.selector.length > MAX_TEXT_LENGTH) throw new ValidationError("models.roles.set input: selector exceeds max length");
}

function validateModelsProviderSetEnabledInput(input: unknown): void {
  assertPlainObject(input, "models.provider.setEnabled input");
  assertNoUnknownKeys(input, ["id", "enabled"], "models.provider.setEnabled input");
  assertNonEmptyText(input.id, "models.provider.setEnabled input: id");
  if (typeof input.enabled !== "boolean") throw new ValidationError("models.provider.setEnabled input: enabled must be boolean");
}

/** Custom request headers carried by model provider inputs. Never a secret store. */
function validateModelsHeaderMap(input: unknown, what: string): void {
  assertPlainObject(input, what);
  const entries = Object.entries(input);
  if (entries.length > MAX_LIST_ITEMS) throw new ValidationError(`${what}: exceeds max length`);
  for (const [name, value] of entries) {
    assertNonEmptyText(name, `${what}: header name`);
    assertNonEmptyText(value, `${what}: ${name}`);
    if (name.length > MAX_TEXT_LENGTH || (value as string).length > MAX_TEXT_LENGTH) {
      throw new ValidationError(`${what}: ${name} exceeds max length`);
    }
  }
}

function validateModelsProviderProbeInput(input: unknown): void {
  assertPlainObject(input, "models.provider.probe input");
  assertNoUnknownKeys(input, ["providerId", "endpointUrl", "apiKey", "discoveryType", "timeoutMs", "api", "headers"], "models.provider.probe input");
  assertNonEmptyText(input.providerId, "models.provider.probe input: providerId");
  if (input.endpointUrl !== undefined) {
    if (typeof input.endpointUrl !== "string") throw new ValidationError("models.provider.probe input: endpointUrl must be a string");
    if (input.endpointUrl.length > MAX_TEXT_LENGTH) throw new ValidationError("models.provider.probe input: endpointUrl exceeds max length");
  }
  if (input.apiKey !== undefined) assertNonEmptyText(input.apiKey, "models.provider.probe input: apiKey");
  if (input.discoveryType !== undefined) assertNonEmptyText(input.discoveryType, "models.provider.probe input: discoveryType");
  if (input.api !== undefined) assertNonEmptyText(input.api, "models.provider.probe input: api");
  if (input.headers !== undefined) validateModelsHeaderMap(input.headers, "models.provider.probe input: headers");
  if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new ValidationError("models.provider.probe input: timeoutMs must be a positive integer");
  }
}

function validateModelsRolesWriteInput(input: unknown): void {
  assertPlainObject(input, "models.roles.write input");
  assertNoUnknownKeys(input, ["roles"], "models.roles.write input");
  assertPlainObject(input.roles, "models.roles.write input: roles");
  for (const [roleId, selector] of Object.entries(input.roles)) {
    assertNonEmptyText(roleId, "models.roles.write input: role id");
    if (typeof selector !== "string") throw new ValidationError("models.roles.write input: selector must be a string");
    if (selector.length > MAX_TEXT_LENGTH) throw new ValidationError("models.roles.write input: selector exceeds max length");
  }
}

function validateModelsRolesCreateInput(input: unknown): void {
  assertPlainObject(input, "models.roles.create input");
  assertNoUnknownKeys(input, ["id", "name", "desc", "color", "selector"], "models.roles.create input");
  assertNonEmptyText(input.id, "models.roles.create input: id");
  assertNonEmptyText(input.name, "models.roles.create input: name");
  if (input.desc !== undefined && typeof input.desc !== "string") throw new ValidationError("models.roles.create input: desc must be a string");
  if (input.color !== undefined) assertNonEmptyText(input.color, "models.roles.create input: color");
  if (input.selector !== undefined) {
    if (typeof input.selector !== "string") throw new ValidationError("models.roles.create input: selector must be a string");
    if (input.selector.length > MAX_TEXT_LENGTH) throw new ValidationError("models.roles.create input: selector exceeds max length");
  }
}

function validateModelsRolesDeleteInput(input: unknown): void {
  assertPlainObject(input, "models.roles.delete input");
  assertNoUnknownKeys(input, ["roleId"], "models.roles.delete input");
  assertNonEmptyText(input.roleId, "models.roles.delete input: roleId");
}

function validateModelsRoleStorageSetInput(input: unknown): void {
  assertPlainObject(input, "models.roleStorage.set input");
  assertNoUnknownKeys(input, ["storage"], "models.roleStorage.set input");
  if (input.storage !== "global" && input.storage !== "project") {
    throw new ValidationError("models.roleStorage.set input: storage must be \"global\" or \"project\"");
  }
}

function validateModelsFallbackSetInput(input: unknown): void {
  assertPlainObject(input, "models.fallback.set input");
  assertNoUnknownKeys(input, ["chains", "revertPolicy"], "models.fallback.set input");
  assertPlainObject(input.chains, "models.fallback.set input: chains");
  for (const [key, chain] of Object.entries(input.chains)) {
    assertNonEmptyText(key, "models.fallback.set input: chain key");
    validateStringList(chain, `models.fallback.set input: chains.${key}`, true);
  }
  if (input.revertPolicy !== undefined && input.revertPolicy !== "cooldown-expiry" && input.revertPolicy !== "never") {
    throw new ValidationError("models.fallback.set input: revertPolicy must be \"cooldown-expiry\" or \"never\"");
  }
}

function validateModelsProviderOrderSetInput(input: unknown): void {
  assertPlainObject(input, "models.providerOrder.set input");
  assertNoUnknownKeys(input, ["order"], "models.providerOrder.set input");
  if (!Array.isArray(input.order) || input.order.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ValidationError("models.providerOrder.set input: order must be an array of non-empty strings");
  }
}

function validateModelsLoginLogoutInput(input: unknown): void {
  assertPlainObject(input, "models.login.logout input");
  assertNoUnknownKeys(input, ["providerId"], "models.login.logout input");
  assertNonEmptyText(input.providerId, "models.login.logout input: providerId");
}

function validateModelsProviderTestInput(input: unknown): void {
  assertPlainObject(input, "models.provider.test input");
  assertNoUnknownKeys(input, ["providerId", "api", "endpointUrl", "apiKey"], "models.provider.test input");
  if (input.providerId !== undefined) assertNonEmptyText(input.providerId, "models.provider.test input: providerId");
  if (input.api !== undefined) assertNonEmptyText(input.api, "models.provider.test input: api");
  if (input.endpointUrl !== undefined) assertNonEmptyText(input.endpointUrl, "models.provider.test input: endpointUrl");
  if (input.apiKey !== undefined) assertNonEmptyText(input.apiKey, "models.provider.test input: apiKey");
}

function validateModelsYmlWriteInput(input: unknown): void {
  assertPlainObject(input, "models.yml.write input");
  assertNoUnknownKeys(input, ["text", "expectedHash", "overlay"], "models.yml.write input");
  assertNonEmptyText(input.text, "models.yml.write input: text");
  if (input.expectedHash !== undefined) assertNonEmptyText(input.expectedHash, "models.yml.write input: expectedHash");
  if (input.overlay !== undefined) validateModelsProviderUpsertInput(input.overlay);
}

function validateModelsCycleOrderSetInput(input: unknown): void {
  assertPlainObject(input, "models.cycleOrder.set input");
  assertNoUnknownKeys(input, ["order"], "models.cycleOrder.set input");
  if (!Array.isArray(input.order) || input.order.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ValidationError("models.cycleOrder.set input: order must be an array of non-empty strings");
  }
}

function validateModelsWebSearchSetInput(input: unknown): void {
  assertPlainObject(input, "models.webSearch.set input");
  assertNoUnknownKeys(
    input,
    ["enabled", "order", "exclude", "timeoutSeconds", "geminiModel", "searxng", "exa"],
    "models.webSearch.set input",
  );
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ValidationError("models.webSearch.set input: enabled must be boolean");
  }
  for (const key of ["order", "exclude"] as const) {
    if (input[key] !== undefined) {
      if (!Array.isArray(input[key]) || input[key].some((item) => typeof item !== "string" || item.length === 0)) {
        throw new ValidationError(`models.webSearch.set input: ${key} must be an array of non-empty strings`);
      }
      if (new Set(input[key]).size !== input[key].length) {
        throw new ValidationError(`models.webSearch.set input: ${key} must not contain duplicates`);
      }
    }
  }
  if (input.timeoutSeconds !== undefined && (typeof input.timeoutSeconds !== "number" || !Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0)) {
    throw new ValidationError("models.webSearch.set input: timeoutSeconds must be a positive number");
  }
  if (input.geminiModel !== undefined && typeof input.geminiModel !== "string") {
    throw new ValidationError("models.webSearch.set input: geminiModel must be a string");
  }
  if (input.searxng !== undefined) {
    assertPlainObject(input.searxng, "models.webSearch.set input: searxng");
    assertNoUnknownKeys(
      input.searxng,
      ["endpoint", "token", "basicUsername", "basicPassword", "categories", "engines", "language", "safesearch"],
      "models.webSearch.set input: searxng",
    );
    for (const key of ["endpoint", "token", "basicUsername", "basicPassword", "categories", "engines", "language"] as const) {
      if (input.searxng[key] !== undefined && typeof input.searxng[key] !== "string") {
        throw new ValidationError(`models.webSearch.set input: searxng.${key} must be a string`);
      }
    }
    // null deletes the key; otherwise only the 0/1/2 levels are accepted.
    if (input.searxng.safesearch !== undefined && input.searxng.safesearch !== null) {
      if (typeof input.searxng.safesearch !== "number" || ![0, 1, 2].includes(input.searxng.safesearch)) {
        throw new ValidationError("models.webSearch.set input: searxng.safesearch must be 0, 1, 2 or null");
      }
    }
  }
  if (input.exa !== undefined) {
    assertPlainObject(input.exa, "models.webSearch.set input: exa");
    assertNoUnknownKeys(input.exa, ["enabled", "searchDelayMs"], "models.webSearch.set input: exa");
    if (input.exa.enabled !== undefined && typeof input.exa.enabled !== "boolean") {
      throw new ValidationError("models.webSearch.set input: exa.enabled must be boolean");
    }
    if (input.exa.searchDelayMs !== undefined && (typeof input.exa.searchDelayMs !== "number" || !Number.isFinite(input.exa.searchDelayMs) || input.exa.searchDelayMs < 0)) {
      throw new ValidationError("models.webSearch.set input: exa.searchDelayMs must be a non-negative number");
    }
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

function validateNamedOptionalScopeInput(input: unknown, what: string, nameRequired: boolean): void {
  assertPlainObject(input, what);
  assertNoUnknownKeys(input, ["name", "scope"], what);
  if (nameRequired || input.name !== undefined) {
    assertNonEmptyText(input.name, `${what}: name`);
  }
  if (input.scope !== undefined && input.scope !== "user" && input.scope !== "project") {
    throw new ValidationError(`${what}: scope must be "user" or "project"`);
  }
}

function validateSkillsRevealInput(input: unknown): void {
  validateNamedOptionalScopeInput(input, "skills.reveal input", true);
}

function validateSkillsRevealRootInput(input: unknown): void {
  assertPlainObject(input, "skills.revealRoot input");
  assertNoUnknownKeys(input, ["scope"], "skills.revealRoot input");
  if (input.scope !== undefined && input.scope !== "user" && input.scope !== "project") {
    throw new ValidationError("skills.revealRoot input: scope must be \"user\" or \"project\"");
  }
}

function validateMcpRefreshInput(input: unknown): void {
  assertPlainObject(input, "mcp.refresh input");
  assertNoUnknownKeys(input, ["name"], "mcp.refresh input");
  if (input.name !== undefined) {
    assertNonEmptyText(input.name, "mcp.refresh input: name");
  }
}

function validateMcpTestInput(input: unknown): void {
  validateNamedOptionalScopeInput(input, "mcp.test input", true);
}

function validateMcpLogsGetInput(input: unknown): void {
  assertPlainObject(input, "mcp.logs.get input");
  assertNoUnknownKeys(input, ["name"], "mcp.logs.get input");
  assertNonEmptyText(input.name, "mcp.logs.get input: name");
}

function validatePluginsSetEnabledInput(input: unknown): void {
  validateEnabledToggleInput(input, "plugins.setEnabled input");
}

function validateSkillsSetEnabledInput(input: unknown): void {
  validateEnabledToggleInput(input, "skills.setEnabled input");
}

function validateMcpSetEnabledInput(input: unknown): void {
  validateEnabledToggleInput(input, "mcp.setEnabled input");
}

const AGENT_THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
]);

function validateStringList(value: unknown, what: string, allowEmpty: boolean): asserts value is string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${what} must be an array of strings`);
  if (value.length > MAX_LIST_ITEMS) throw new ValidationError(`${what} exceeds max length`);
  if (!allowEmpty && value.length === 0) throw new ValidationError(`${what} must not be empty`);
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new ValidationError(`${what} must be an array of non-empty strings`);
    }
    if (item.length > MAX_TEXT_LENGTH) throw new ValidationError(`${what} item exceeds max length`);
  }
}

function validateOptionalJsonValue(value: unknown, what: string): void {
  if (value === undefined || value === null) return;
  try {
    validateJsonNode(value, 0, { remaining: MAX_SERIALIZED_SIZE });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ValidationError(`${what}: invalid JSON value`);
    }
    throw error;
  }
}

function validateNullableBoolean(value: unknown, what: string): void {
  if (value !== null && typeof value !== "boolean") {
    throw new ValidationError(`${what} must be boolean or null`);
  }
}

function validateAgentDefinitionUpsertInput(input: unknown): void {
  assertPlainObject(input, "agents.definition.upsert input");
  assertNoUnknownKeys(
    input,
    [
      "name",
      "description",
      "systemPrompt",
      "scope",
      "tools",
      "spawns",
      "model",
      "thinkingLevel",
      "output",
      "blocking",
      "autoloadSkills",
      "readSummarize",
      "prewalk",
      "advisor",
      "expectedHash",
    ],
    "agents.definition.upsert input",
  );
  assertNonEmptyText(input.name, "agents.definition.upsert input: name");
  assertNonEmptyText(input.description, "agents.definition.upsert input: description");
  if (typeof input.systemPrompt !== "string") {
    throw new ValidationError("agents.definition.upsert input: systemPrompt must be a string");
  }
  if (input.systemPrompt.length > MAX_TEXT_LENGTH) {
    throw new ValidationError("agents.definition.upsert input: systemPrompt exceeds max length");
  }
  if (input.scope !== "user" && input.scope !== "project") {
    throw new ValidationError("agents.definition.upsert input: scope must be \"user\" or \"project\"");
  }
  if (input.tools !== undefined && input.tools !== null) {
    validateStringList(input.tools, "agents.definition.upsert input: tools", true);
  }
  if (input.spawns !== undefined && input.spawns !== null && input.spawns !== "*") {
    validateStringList(input.spawns, "agents.definition.upsert input: spawns", true);
  }
  if (input.model !== undefined && input.model !== null) {
    validateStringList(input.model, "agents.definition.upsert input: model", true);
  }
  if (input.thinkingLevel !== undefined && input.thinkingLevel !== null) {
    if (typeof input.thinkingLevel !== "string" || !AGENT_THINKING_LEVELS.has(input.thinkingLevel)) {
      throw new ValidationError("agents.definition.upsert input: thinkingLevel is invalid");
    }
  }
  if (input.output !== undefined) validateOptionalJsonValue(input.output, "agents.definition.upsert input: output");
  if (input.blocking !== undefined) validateNullableBoolean(input.blocking, "agents.definition.upsert input: blocking");
  if (input.autoloadSkills !== undefined && input.autoloadSkills !== null) {
    validateStringList(input.autoloadSkills, "agents.definition.upsert input: autoloadSkills", true);
  }
  if (input.readSummarize !== undefined) {
    validateNullableBoolean(input.readSummarize, "agents.definition.upsert input: readSummarize");
  }
  if (input.prewalk !== undefined && input.prewalk !== null && typeof input.prewalk !== "boolean") {
    if (typeof input.prewalk !== "string" || input.prewalk.trim().length === 0) {
      throw new ValidationError("agents.definition.upsert input: prewalk must be boolean, string, or null");
    }
  }
  if (input.advisor !== undefined && input.advisor !== null && typeof input.advisor !== "boolean") {
    if (typeof input.advisor !== "string" || input.advisor.trim().length === 0) {
      throw new ValidationError("agents.definition.upsert input: advisor must be boolean, string, or null");
    }
  }
  if (input.expectedHash !== undefined) assertNonEmptyText(input.expectedHash, "agents.definition.upsert input: expectedHash");
}

function validateAgentDefinitionDeleteInput(input: unknown): void {
  assertPlainObject(input, "agents.definition.delete input");
  assertNoUnknownKeys(input, ["name", "scope", "expectedHash"], "agents.definition.delete input");
  assertNonEmptyText(input.name, "agents.definition.delete input: name");
  if (input.scope !== "user" && input.scope !== "project") {
    throw new ValidationError("agents.definition.delete input: scope must be \"user\" or \"project\"");
  }
  if (input.expectedHash !== undefined) assertNonEmptyText(input.expectedHash, "agents.definition.delete input: expectedHash");
}

function validateAgentDefinitionConfigureInput(input: unknown): void {
  assertPlainObject(input, "agents.definition.configure input");
  assertNoUnknownKeys(
    input,
    ["name", "disabled", "overrideModel", "prewalkOverride", "advisorOverride"],
    "agents.definition.configure input",
  );
  assertNonEmptyText(input.name, "agents.definition.configure input: name");
  if (input.disabled !== undefined && typeof input.disabled !== "boolean") {
    throw new ValidationError("agents.definition.configure input: disabled must be boolean");
  }
  if (input.overrideModel !== undefined && input.overrideModel !== null) {
    if (typeof input.overrideModel !== "string" || input.overrideModel.trim().length === 0) {
      throw new ValidationError("agents.definition.configure input: overrideModel must be a non-empty string or null");
    }
  }
  if (input.prewalkOverride !== undefined && input.prewalkOverride !== null) {
    if (typeof input.prewalkOverride !== "string" || input.prewalkOverride.trim().length === 0) {
      throw new ValidationError("agents.definition.configure input: prewalkOverride must be a non-empty string or null");
    }
  }
  if (input.advisorOverride !== undefined && input.advisorOverride !== null) {
    if (typeof input.advisorOverride !== "string" || input.advisorOverride.trim().length === 0) {
      throw new ValidationError("agents.definition.configure input: advisorOverride must be a non-empty string or null");
    }
  }
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
  "residents.list": (input) => validateEmptyInput(input, "residents.list input"),
  "session.state": (input) => validateEmptyInput(input, "session.state input"),
  "home.get": (input) => validateEmptyInput(input, "home.get input"),
  "models.get": (input) => validateEmptyInput(input, "models.get input"),
  "skills.get": (input) => validateEmptyInput(input, "skills.get input"),
  "mcp.get": (input) => validateEmptyInput(input, "mcp.get input"),
  "mcp.logs.get": validateMcpLogsGetInput,
  "agents.definitions.get": (input) => validateEmptyInput(input, "agents.definitions.get input"),
  "projects.list": (input) => validateEmptyInput(input, "projects.list input"),
  "workspace.fileTree": validateWorkspaceFileTreeInput,
  "usage.get": (input) => validateEmptyInput(input, "usage.get input"),
  "conversation.open": validateConversationOpenInput,
  "session.transcript.read": validateTranscriptReadInput,
  "agent.transcript.read": validateAgentTranscriptReadInput,
  "agent.conversation.read": validateAgentConversationReadInput,
  "session.transcript.readPage": validateTranscriptReadPageInput,
  "session.agents.list": validateSessionAgentsListInput,
  "session.telemetry.read": validateSessionTelemetryReadInput,
  "git.toolchain.get": (input) => validateEmptyInput(input, "git.toolchain.get input"),
  "git.repository.get": (input) => validateWorkspaceSelector(input, "git.repository.get input"),
  "git.diff.get": validateGitDiffInput,
  "git.branches.list": (input) => validateWorkspaceSelector(input, "git.branches.list input"),
  "git.worktrees.list": (input) => validateWorkspaceSelector(input, "git.worktrees.list input"),
  "git.remotes.list": (input) => validateWorkspaceSelector(input, "git.remotes.list input"),
  "git.log.list": validateGitLogInput,
  "git.commit.changes": validateGitCommitChangesInput,
  "git.commit.diff": validateGitCommitDiffInput,
  "github.auth.get": (input) => validateOptionalWorkspaceSelector(input, "github.auth.get input"),
  "github.pr.list": validateGithubPrListInput,
  "github.pr.get": (input) => validateGithubPrNumberInput(input, "github.pr.get input"),
  "github.pr.checks": (input) => validateGithubPrNumberInput(input, "github.pr.checks input"),
};

/** Per-name command input validators, keyed by the full CommandName map. */
const COMMAND_INPUT_VALIDATORS: {
  readonly [K in CommandName]: (input: unknown) => void;
} = {
  "core.prompt": (input) => validatePromptInput(input, "core.prompt input"),
  "core.steer": (input) => validatePromptInput(input, "core.steer input"),
  "core.followUp": (input) => validatePromptInput(input, "core.followUp input"),
  "core.abort": (input) => validateEmptyCommandInput(input, "core.abort input"),
  "queue.enqueue": (input) => validateTextInput(input, "queue.enqueue input"),
  "runtime.pause": (input) => validateEmptyCommandInput(input, "runtime.pause input"),
  "runtime.resume": validatePauseResumeInput,
  "runtime.settings.get": validateRuntimeSettingsGetInput,
  "runtime.settings.set": validateRuntimeSettingsSetInput,
  "turn.retry": (input) => validateEmptyCommandInput(input, "turn.retry input"),
  "mode.plan.enter": (input) => validateOptionalTextFields(input, "mode.plan.enter input", ["initialPrompt"]),
  "mode.plan.exit": (input) => { assertPlainObject(input, "mode.plan.exit input"); assertNoUnknownKeys(input, ["discardDraft"], "mode.plan.exit input"); if (input.discardDraft !== undefined && typeof input.discardDraft !== "boolean") throw new ValidationError("mode.plan.exit input: discardDraft must be boolean"); },
  "mode.plan.review.open": (input) => validateEmptyCommandInput(input, "mode.plan.review.open input"),
  "mode.plan.review.respond": validatePlanReviewInput,
  "mode.plan.review.saveAndQuit": validatePlanSaveAndQuitInput,
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
  "session.fast.set": (input) => {
    assertPlainObject(input, "session.fast.set input");
    assertNoUnknownKeys(input, ["enabled"], "session.fast.set input");
    if (typeof input.enabled !== "boolean") throw new ValidationError("session.fast.set input: enabled must be boolean");
  },
  "session.prewalk.arm": (input) => validateOptionalTextFields(input, "session.prewalk.arm input", ["target"]),
  "session.prewalk.disarm": (input) => validateEmptyCommandInput(input, "session.prewalk.disarm input"),
  "session.clearContext": (input) => validateEmptyCommandInput(input, "session.clearContext input"),
  "session.fork": (input) => validateEmptyCommandInput(input, "session.fork input"),
  "session.handoff": (input) => validateOptionalTextFields(input, "session.handoff input", ["customInstructions"]),
  "session.model.set": (input) => {
    assertPlainObject(input, "session.model.set input");
    assertNoUnknownKeys(input, ["selector", "thinking"], "session.model.set input");
    assertNonEmptyText(input.selector, "session.model.set input: selector");
    if (input.selector.length > MAX_MODEL_SELECTOR_CHARS) {
      throw new ValidationError(`session.model.set input: selector exceeds ${MAX_MODEL_SELECTOR_CHARS} characters`);
    }
    if (input.thinking !== undefined) assertThinkingSelector(input.thinking, "session.model.set input: thinking");
  },
  "session.thinking.set": (input) => {
    assertPlainObject(input, "session.thinking.set input");
    assertNoUnknownKeys(input, ["level"], "session.thinking.set input");
    assertThinkingSelector(input.level, "session.thinking.set input: level");
  },
  "session.tree.get": (input) => validateEmptyCommandInput(input, "session.tree.get input"),
  "session.tree.navigate": validateTreeNavigateInput,
  "session.tree.branch": validateTreeBranchInput,
  "operator.invoke": validateOperatorInvokeInput,
  "btw.ask": (input) => validateNamedTextInput(input, "btw.ask input", "question"),
  "btw.abort": (input) => validateOpaqueIdInput(input, "btw.abort input", "ephemeralId"),
  "btw.branch": (input) => validateOpaqueIdInput(input, "btw.branch input", "branchToken"),
  "tan.start": (input) => validateNamedTextInput(input, "tan.start input", "work"),
  "omfg.generate": (input) => validateNamedTextInput(input, "omfg.generate input", "complaint"),
  "agent.spawn": validateAgentSpawnInput,
  "agent.send": validateAgentSendInput,
  "agent.kill": validateAgentLifecycleInput,
  "agent.revive": validateAgentLifecycleInput,
  "agent.release": validateAgentLifecycleInput,
  "job.cancel": validateJobCancelInput,
  "runtime.install": validateRuntimeInstallInput,
  "runtime.ensure": validateRuntimeEnsureInput,
  "session.create": (input) => validateEmptyCommandInput(input, "session.create input"),
  "session.resume": (input) => validateThreadInput(input, "session.resume input"),
  "session.drop": (input) => validateThreadInput(input, "session.drop input"),
  "session.archive": (input) => validateThreadInput(input, "session.archive input"),
  "session.unarchive": (input) => validateThreadInput(input, "session.unarchive input"),
  "session.delete": (input) => validateThreadInput(input, "session.delete input"),
  "interaction.respond": validateInteractionRespondInput,
  "permissions.mode.set": (input) => {
    assertPlainObject(input, "permissions.mode.set input");
    assertNoUnknownKeys(input, ["mode"], "permissions.mode.set input");
    if (input.mode !== "always-ask" && input.mode !== "write" && input.mode !== "yolo") {
      throw new ValidationError("permissions.mode.set input: mode must be always-ask, write or yolo");
    }
  },
  "models.provider.upsert": validateModelsProviderUpsertInput,
  "models.provider.delete": validateModelsProviderDeleteInput,
  "models.provider.setEnabled": validateModelsProviderSetEnabledInput,
  "models.roles.set": validateModelsRolesSetInput,
  "models.roles.write": validateModelsRolesWriteInput,
  "models.roles.create": validateModelsRolesCreateInput,
  "models.roles.delete": validateModelsRolesDeleteInput,
  "models.roleStorage.set": validateModelsRoleStorageSetInput,
  "models.fallback.set": validateModelsFallbackSetInput,
  "models.providerOrder.set": validateModelsProviderOrderSetInput,
  "models.yml.write": validateModelsYmlWriteInput,
  "models.login.start": validateModelsLoginStartInput,
  "models.login.logout": validateModelsLoginLogoutInput,
  "models.provider.test": validateModelsProviderTestInput,
  "models.provider.probe": validateModelsProviderProbeInput,
  "models.discovery.refresh": (input) => validateEmptyCommandInput(input, "models.discovery.refresh input"),
  "models.cycleOrder.set": validateModelsCycleOrderSetInput,
  "models.webSearch.set": validateModelsWebSearchSetInput,
  "plugins.setEnabled": validatePluginsSetEnabledInput,
  "skills.setEnabled": validateSkillsSetEnabledInput,
  "skills.reveal": validateSkillsRevealInput,
  "skills.revealRoot": validateSkillsRevealRootInput,
  "mcp.setEnabled": validateMcpSetEnabledInput,
  "mcp.refresh": validateMcpRefreshInput,
  "mcp.test": validateMcpTestInput,
  "agents.definition.upsert": validateAgentDefinitionUpsertInput,
  "agents.definition.delete": validateAgentDefinitionDeleteInput,
  "agents.definition.configure": validateAgentDefinitionConfigureInput,
  "workspace.open": (input) => {
    assertPlainObject(input, "workspace.open input");
    assertNoUnknownKeys(input, ["workspaceId"], "workspace.open input");
    assertOpaqueToken(input.workspaceId, "workspace.open input: workspaceId");
  },
  "workspace.pick": (input) => {
    assertPlainObject(input, "workspace.pick input");
    assertNoUnknownKeys(input, ["name"], "workspace.pick input");
    if (input.name !== undefined) {
      assertNonEmptyText(input.name, "workspace.pick input: name");
      if (input.name.trim().length > 80) throw new ValidationError("workspace.pick input: name must be at most 80 characters");
    }
  },
  "workspace.file.create": (input) => validateWorkspaceFileMutationInput(input, "workspace.file.create input"),
  "workspace.directory.create": (input) => validateWorkspaceFileMutationInput(input, "workspace.directory.create input"),
  "usage.openDashboard": (input) => validateEmptyCommandInput(input, "usage.openDashboard input"),
  "git.execute": validateGitExecuteInput,
  "github.execute": validateGithubExecuteInput,
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
