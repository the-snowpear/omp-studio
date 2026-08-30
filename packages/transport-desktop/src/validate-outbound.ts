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
  BtwErrorCode,
  BtwStatus,
  ClientCommandAccepted,
  ClientEvent,
  ClientErrorCode,
  ClientInteraction,
  ClientQueryResponse,
  CommandReceipt,
  RuntimeBackend,
  RuntimeClassification,
  RuntimeConnectionStatus,
  RuntimeAutoRespawnStatus,
  RuntimeDisconnectCode,
  RuntimeUnavailableCode,
} from "@omp-studio/client-contract";
import {
  parseConversationRuntimeEvent,
  parseConversationTranscriptPage,
  STUDIO_RUNTIME_CODE_MODES,
  STUDIO_RUNTIME_COMPACTION_METHODS,
  STUDIO_RUNTIME_SETTING_KEYS,
  STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS,
  STUDIO_RUNTIME_UNEXPECTED_STOP_MODES,
} from "@omp-studio/client-contract";
import {
  parseConversationOpenResult,
  parseOperatorStateSnapshot,
  parseSessionTelemetryReadResult,
} from "@omp-studio/studio-protocol";

import {
  ValidationError,
  assertNoUnknownKeys,
  assertNonEmptyText,
  assertOpaqueToken,
  assertPlainObject,
  isOpaqueToken,
  isPlainObject,
  validatePromptImages,
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
  "CURSOR_STALE",
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

function assertSessionTelemetryReadResult(value: unknown): void {
  try {
    parseSessionTelemetryReadResult(value);
  } catch (error) {
    throw new ValidationError(
      `session.telemetry.read result: invalid telemetry read result (${error instanceof Error ? error.message : "invalid"})`,
    );
  }
}

function assertRuntimeSettingValue(key: unknown, value: unknown, what: string): void {
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

function assertRuntimeSettingsSnapshot(value: unknown, what: string): void {
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, [...STUDIO_RUNTIME_SETTING_KEYS], what);
  for (const key of STUDIO_RUNTIME_SETTING_KEYS) assertRuntimeSettingValue(key, value[key], `${what}: ${key}`);
}

function assertRuntimeSettingsGetResult(value: unknown): void {
  const what = "event: runtime.settings.get result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["values"], what);
  assertPlainObject(value.values, `${what}: values`);
  for (const key of Object.keys(value.values)) {
    if (!STUDIO_RUNTIME_SETTING_KEYS.includes(key as (typeof STUDIO_RUNTIME_SETTING_KEYS)[number])) {
      throw new ValidationError(`${what}: values contains an unsupported setting key`);
    }
    assertRuntimeSettingValue(key, value.values[key], `${what}: values.${key}`);
  }
}

function assertRuntimeSettingsSetResult(value: unknown): void {
  const what = "event: runtime.settings.set result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["key", "value", "persisted"], what);
  assertRuntimeSettingValue(value.key, value.value, `${what}: value`);
  if (typeof value.persisted !== "boolean") throw new ValidationError(`${what}: persisted must be boolean`);
}

function assertPlanSaveAndQuitResult(value: unknown): void {
  const what = "event: mode.plan.review.saveAndQuit result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["saved", "path", "exitedPlan", "newSession", "sessionId"], what);
  if (value.saved !== true || value.exitedPlan !== true) throw new ValidationError(`${what}: save did not complete`);
  assertNonEmptyText(value.path, `${what}: path`);
  const normalized = value.path.replaceAll("\\", "/");
  if (
    value.path.length > 1024 ||
    value.path.includes("\0") ||
    value.path !== value.path.trim() ||
    ((value.path.startsWith('"') && value.path.endsWith('"')) || (value.path.startsWith("'") && value.path.endsWith("'"))) ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    /^[A-Za-z]:/.test(value.path) ||
    normalized.endsWith("/") ||
    normalized.split("/").some((segment) => segment === ".." || segment.includes(":")) ||
    normalized.split("/").every((segment) => segment.length === 0 || segment === ".")
  ) {
    throw new ValidationError(`${what}: path must be workspace-relative`);
  }
  if (value.newSession !== "started" && value.newSession !== "cancelled" && value.newSession !== "failed") {
    throw new ValidationError(`${what}: invalid newSession status`);
  }
  if (value.sessionId !== undefined) assertOpaqueToken(value.sessionId, `${what}: sessionId`);
  if (value.newSession === "started" && value.sessionId === undefined) {
    throw new ValidationError(`${what}: started session is missing sessionId`);
  }
}

function assertOperatorStateSnapshot(value: unknown, what: string): void {
  try {
    parseOperatorStateSnapshot(value);
  } catch (error) {
    throw new ValidationError(`${what}: invalid operator snapshot (${error instanceof Error ? error.message : "invalid"})`);
  }
}

function assertResidentsReadModel(value: unknown, what = "residents read model"): void {
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["residents", "activeSessionId", "generatedAt"], what);
  assertNonEmptyText(value.generatedAt, `${what}: generatedAt`);
  if (value.activeSessionId !== undefined) {
    assertOpaqueToken(value.activeSessionId, `${what}: activeSessionId`);
  }
  if (!Array.isArray(value.residents) || value.residents.length > 10_000) {
    throw new ValidationError(`${what}: residents must be a bounded array`);
  }
  for (const [index, resident] of value.residents.entries()) {
    const rowWhat = `${what}: residents[${index}]`;
    assertPlainObject(resident, rowWhat);
    assertNoUnknownKeys(
      resident,
      ["sessionId", "workspaceId", "phase", "pendingMessages", "waitKind", "lastActivityAt"],
      rowWhat,
    );
    assertOpaqueToken(resident.sessionId, `${rowWhat}: sessionId`);
    assertOpaqueToken(resident.workspaceId, `${rowWhat}: workspaceId`);
    if (
      resident.phase !== "idle" &&
      resident.phase !== "running" &&
      resident.phase !== "compacting" &&
      resident.phase !== "waiting"
    ) {
      throw new ValidationError(`${rowWhat}: phase is invalid`);
    }
    assertCounter(resident.pendingMessages, `${rowWhat}: pendingMessages`);
    if (
      resident.waitKind !== undefined &&
      resident.waitKind !== "approval" &&
      resident.waitKind !== "ask" &&
      resident.waitKind !== "plan"
    ) {
      throw new ValidationError(`${rowWhat}: waitKind is invalid`);
    }
    assertNonEmptyText(resident.lastActivityAt, `${rowWhat}: lastActivityAt`);
  }
}

const AGENT_TRANSCRIPT_ROLES = ["user", "assistant", "custom", "system"] as const;

function assertAgentTranscriptPage(value: unknown): void {
  const what = "agent.transcript.read result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["agentId", "generation", "cursor", "nextCursor", "messages", "eof"], what);
  assertOpaqueToken(value.agentId, `${what}: agentId`);
  if (
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  ) {
    throw new ValidationError(`${what}: generation must be a positive safe integer`);
  }
  assertOpaqueToken(value.cursor, `${what}: cursor`);
  if ("nextCursor" in value && value.nextCursor !== undefined) {
    assertOpaqueToken(value.nextCursor, `${what}: nextCursor`);
  }
  if (typeof value.eof !== "boolean") {
    throw new ValidationError(`${what}: eof must be a boolean`);
  }
  if (!Array.isArray(value.messages)) {
    throw new ValidationError(`${what}: messages must be an array`);
  }
  for (const message of value.messages) {
    assertPlainObject(message, `${what}: message`);
    assertNoUnknownKeys(message, ["id", "role", "ts", "text"], `${what}: message`);
    assertNonEmptyText(message.id, `${what}: message.id`);
    if (!(AGENT_TRANSCRIPT_ROLES as readonly string[]).includes(message.role as string)) {
      throw new ValidationError(`${what}: message.role is not a known transcript role`);
    }
    if (typeof message.ts !== "number" || !Number.isSafeInteger(message.ts) || message.ts < 0) {
      throw new ValidationError(`${what}: message.ts must be a non-negative safe integer`);
    }
    if (typeof message.text !== "string") {
      throw new ValidationError(`${what}: message.text must be a string`);
    }
  }
}

function assertSessionAgentsListResult(value: unknown): void {
  const what = "session.agents.list result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["sessionId", "agents"], what);
  assertOpaqueToken(value.sessionId, `${what}: sessionId`);
  if (!Array.isArray(value.agents)) {
    throw new ValidationError(`${what}: agents must be an array`);
  }
  for (const [index, agent] of value.agents.entries()) {
    assertPlainObject(agent, `${what}: agents[${index}]`);
    assertOpaqueToken(agent.agentId, `${what}: agents[${index}].agentId`);
    if (typeof agent.displayName !== "string" || agent.displayName.length === 0) {
      throw new ValidationError(`${what}: agents[${index}].displayName must be a non-empty string`);
    }
    if (typeof agent.status !== "string" || agent.status.length === 0) {
      throw new ValidationError(`${what}: agents[${index}].status must be a non-empty string`);
    }
    if (typeof agent.hasTranscript !== "boolean") {
      throw new ValidationError(`${what}: agents[${index}].hasTranscript must be a boolean`);
    }
  }
}

function assertConversationTranscriptReadPage(value: unknown): void {
  assertPlainObject(value, "session.transcript.readPage result");
  assertNoUnknownKeys(
    value,
    [
      "sessionId",
      "transcriptRevision",
      "branchLeafId",
      "items",
      "olderCursor",
      "headCursor",
      "hasMoreBefore",
    ],
    "session.transcript.readPage result",
  );
  assertOpaqueToken(value.sessionId, "session.transcript.readPage result: sessionId");
  assertOpaqueToken(
    value.transcriptRevision,
    "session.transcript.readPage result: transcriptRevision",
  );
  try {
    // Reuse the protocol's exact, bounded item/cursor/page parser. The
    // synthetic epoch is validation-only and never enters the public result.
    parseConversationTranscriptPage({
      runtimeEpoch: 1,
      sessionId: value.sessionId,
      branchLeafId: value.branchLeafId,
      items: value.items,
      ...(value.olderCursor === undefined ? {} : { olderCursor: value.olderCursor }),
      headCursor: value.headCursor,
      hasMoreBefore: value.hasMoreBefore,
    });
  } catch (error) {
    throw new ValidationError(
      `session.transcript.readPage result: invalid transcript page (${error instanceof Error ? error.message : "invalid"})`,
    );
  }
}

function assertWorkspaceFileTree(value: unknown): void {
  assertPlainObject(value, "workspace.fileTree result");
  assertNoUnknownKeys(value, ["workspaceId", "nodes"], "workspace.fileTree result");
  assertOpaqueToken(value.workspaceId, "workspace.fileTree result: workspaceId");
  if (!Array.isArray(value.nodes) || value.nodes.length > 5_000) throw new ValidationError("workspace.fileTree result: nodes must be a bounded array");
  let count = 0;
  const visit = (nodes: unknown[], depth: number): void => {
    if (depth > 12) throw new ValidationError("workspace.fileTree result: tree is too deep");
    for (const node of nodes) {
      if (++count > 5_000) throw new ValidationError("workspace.fileTree result: tree is too large");
      assertPlainObject(node, "workspace.fileTree node");
      assertNoUnknownKeys(node, ["type", "name", "path", "children"], "workspace.fileTree node");
      if (node.type !== "file" && node.type !== "dir") throw new ValidationError("workspace.fileTree node: invalid type");
      assertNonEmptyText(node.name, "workspace.fileTree node: name");
      assertNonEmptyText(node.path, "workspace.fileTree node: path");
      const path = node.path.replaceAll("\\", "/");
      if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.split("/").some((part) => part === ".." || part.length === 0)) {
        throw new ValidationError("workspace.fileTree node: path must be relative");
      }
      if (node.type === "dir") {
        if (node.children !== undefined) {
          if (!Array.isArray(node.children)) throw new ValidationError("workspace.fileTree directory: children must be an array when present");
          visit(node.children, depth + 1);
        }
      } else if (node.children !== undefined) {
        throw new ValidationError("workspace.fileTree file: children are not allowed");
      }
    }
  };
  visit(value.nodes, 0);
}

function assertRelativePath(value: unknown, what: string): void {
  assertNonEmptyText(value, what);
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path) || path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new ValidationError(`${what}: path must be relative`);
  }
}

function assertGitToolchain(value: unknown): void {
  assertPlainObject(value, "git.toolchain.get result");
  assertNoUnknownKeys(value, ["git", "githubCli"], "git.toolchain.get result");
  for (const key of ["git", "githubCli"] as const) {
    const tool = value[key];
    assertPlainObject(tool, `git.toolchain.get result: ${key}`);
    assertNoUnknownKeys(tool, ["available", "version", "unavailableReason"], `git.toolchain.get result: ${key}`);
    if (typeof tool.available !== "boolean") throw new ValidationError(`git.toolchain.get result: ${key}.available must be boolean`);
    if (tool.version !== undefined && typeof tool.version !== "string") throw new ValidationError(`git.toolchain.get result: ${key}.version must be string`);
    if (tool.unavailableReason !== undefined && typeof tool.unavailableReason !== "string") throw new ValidationError(`git.toolchain.get result: ${key}.unavailableReason must be string`);
  }
}

const GIT_FILE_STATES = ["unmodified", "modified", "added", "deleted", "renamed", "copied", "untracked", "conflicted"] as const;

function assertGitRepository(value: unknown): void {
  const what = "git.repository.get result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["workspaceId", "isRepository", "repositoryId", "worktreeId", "branch", "headOid", "detached", "unborn", "upstream", "ahead", "behind", "stashCount", "operation", "changes", "insertions", "deletions", "revision", "unavailableReason"], what);
  assertOpaqueToken(value.workspaceId, `${what}: workspaceId`);
  if (typeof value.isRepository !== "boolean" || typeof value.detached !== "boolean" || typeof value.unborn !== "boolean") throw new ValidationError(`${what}: invalid repository flags`);
  for (const key of ["ahead", "behind", "stashCount"] as const) assertCounter(value[key], `${what}: ${key}`);
  for (const key of ["insertions", "deletions"] as const) if (value[key] !== undefined) assertCounter(value[key], `${what}: ${key}`);
  for (const key of ["repositoryId", "worktreeId", "revision"] as const) if (value[key] !== undefined) assertOpaqueToken(value[key], `${what}: ${key}`);
  for (const key of ["branch", "headOid", "upstream", "unavailableReason"] as const) if (value[key] !== undefined && typeof value[key] !== "string") throw new ValidationError(`${what}: ${key} must be string`);
  if (value.operation !== undefined && value.operation !== "merge" && value.operation !== "rebase" && value.operation !== "cherry-pick" && value.operation !== "revert") throw new ValidationError(`${what}: invalid operation`);
  if (!Array.isArray(value.changes) || value.changes.length > 50_000) throw new ValidationError(`${what}: changes must be bounded`);
  for (const change of value.changes) {
    assertPlainObject(change, `${what}: change`);
    assertNoUnknownKeys(change, ["path", "originalPath", "index", "worktree", "conflicted"], `${what}: change`);
    assertRelativePath(change.path, `${what}: change.path`);
    if (change.originalPath !== undefined) assertRelativePath(change.originalPath, `${what}: change.originalPath`);
    if (typeof change.index !== "string" || !(GIT_FILE_STATES as readonly string[]).includes(change.index) || typeof change.worktree !== "string" || !(GIT_FILE_STATES as readonly string[]).includes(change.worktree)) throw new ValidationError(`${what}: invalid change state`);
    if (typeof change.conflicted !== "boolean") throw new ValidationError(`${what}: conflicted must be boolean`);
  }
}

function assertGitDiff(value: unknown): void {
  const what = "git.diff.get result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["workspaceId", "path", "target", "patch", "binary", "truncated", "revision"], what);
  assertOpaqueToken(value.workspaceId, `${what}: workspaceId`);
  assertRelativePath(value.path, `${what}: path`);
  if (value.target !== "working" && value.target !== "staged") throw new ValidationError(`${what}: invalid target`);
  if (typeof value.patch !== "string" || value.patch.length > 4 * 1024 * 1024) throw new ValidationError(`${what}: patch exceeds limit`);
  if (typeof value.binary !== "boolean" || typeof value.truncated !== "boolean") throw new ValidationError(`${what}: invalid flags`);
  assertOpaqueToken(value.revision, `${what}: revision`);
}

const GIT_LOG_REF_KINDS = ["head", "local", "remote", "tag"] as const;
const GIT_LOG_RELATIONS = ["head", "outgoing", "incoming", "common"] as const;
const GIT_COMMIT_CHANGE_STATUSES = ["added", "modified", "deleted", "renamed", "copied"] as const;

function assertGitLogList(value: unknown): void {
  const what = "git.log.list result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["workspaceId", "commits", "truncated", "cursor", "headOid", "upstream", "mergeBaseOid", "ahead", "behind"], what);
  assertOpaqueToken(value.workspaceId, `${what}: workspaceId`);
  if (typeof value.truncated !== "boolean") throw new ValidationError(`${what}: truncated must be boolean`);
  assertCounter(value.ahead, `${what}: ahead`);
  assertCounter(value.behind, `${what}: behind`);
  for (const key of ["cursor", "headOid", "upstream", "mergeBaseOid"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new ValidationError(`${what}: ${key} must be string`);
  }
  if (!Array.isArray(value.commits) || value.commits.length > 200) throw new ValidationError(`${what}: commits must be bounded`);
  for (const commit of value.commits) {
    assertPlainObject(commit, `${what}: commit`);
    assertNoUnknownKeys(commit, ["oid", "parents", "subject", "authorName", "authorDate", "refs", "relation", "insertions", "deletions"], `${what}: commit`);
    assertNonEmptyText(commit.oid, `${what}: oid`);
    assertNonEmptyText(commit.subject, `${what}: subject`);
    assertNonEmptyText(commit.authorName, `${what}: authorName`);
    assertNonEmptyText(commit.authorDate, `${what}: authorDate`);
    if (typeof commit.relation !== "string" || !(GIT_LOG_RELATIONS as readonly string[]).includes(commit.relation)) throw new ValidationError(`${what}: invalid relation`);
    if (!Array.isArray(commit.parents) || commit.parents.length > 32) throw new ValidationError(`${what}: parents must be bounded`);
    for (const parent of commit.parents) assertNonEmptyText(parent, `${what}: parent`);
    if (!Array.isArray(commit.refs) || commit.refs.length > 64) throw new ValidationError(`${what}: refs must be bounded`);
    for (const ref of commit.refs) {
      assertPlainObject(ref, `${what}: ref`);
      assertNoUnknownKeys(ref, ["name", "kind", "current"], `${what}: ref`);
      assertNonEmptyText(ref.name, `${what}: ref.name`);
      if (typeof ref.kind !== "string" || !(GIT_LOG_REF_KINDS as readonly string[]).includes(ref.kind)) throw new ValidationError(`${what}: invalid ref kind`);
      if (typeof ref.current !== "boolean") throw new ValidationError(`${what}: ref.current must be boolean`);
    }
    for (const key of ["insertions", "deletions"] as const) if (commit[key] !== undefined) assertCounter(commit[key], `${what}: ${key}`);
  }
}

function assertGitCommitChanges(value: unknown): void {
  const what = "git.commit.changes result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["workspaceId", "oid", "subject", "files"], what);
  assertOpaqueToken(value.workspaceId, `${what}: workspaceId`);
  assertNonEmptyText(value.oid, `${what}: oid`);
  assertNonEmptyText(value.subject, `${what}: subject`);
  if (!Array.isArray(value.files) || value.files.length > 10_000) throw new ValidationError(`${what}: files must be bounded`);
  for (const file of value.files) {
    assertPlainObject(file, `${what}: file`);
    assertNoUnknownKeys(file, ["path", "status", "originalPath"], `${what}: file`);
    assertRelativePath(file.path, `${what}: file.path`);
    if (typeof file.status !== "string" || !(GIT_COMMIT_CHANGE_STATUSES as readonly string[]).includes(file.status)) throw new ValidationError(`${what}: invalid file status`);
    if (file.originalPath !== undefined) assertRelativePath(file.originalPath, `${what}: file.originalPath`);
  }
}

function assertGitCommitDiff(value: unknown): void {
  const what = "git.commit.diff result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["workspaceId", "oid", "path", "patch", "binary", "truncated"], what);
  assertOpaqueToken(value.workspaceId, `${what}: workspaceId`);
  assertNonEmptyText(value.oid, `${what}: oid`);
  assertRelativePath(value.path, `${what}: path`);
  if (typeof value.patch !== "string" || value.patch.length > 4 * 1024 * 1024) throw new ValidationError(`${what}: patch exceeds limit`);
  if (typeof value.binary !== "boolean" || typeof value.truncated !== "boolean") throw new ValidationError(`${what}: invalid flags`);
}

function assertGitList(value: unknown, kind: "branches" | "worktrees" | "remotes"): void {
  const what = `git.${kind}.list result`;
  assertPlainObject(value, what);
  const listKey = kind;
  assertNoUnknownKeys(value, kind === "worktrees" ? ["workspaceId", "rootConfigured", listKey] : ["workspaceId", listKey], what);
  assertOpaqueToken(value.workspaceId, `${what}: workspaceId`);
  if (kind === "worktrees" && typeof value.rootConfigured !== "boolean") throw new ValidationError(`${what}: rootConfigured must be boolean`);
  const list = value[listKey];
  if (!Array.isArray(list) || list.length > 10_000) throw new ValidationError(`${what}: list must be bounded`);
  for (const entry of list) {
    assertPlainObject(entry, `${what}: entry`);
    if (kind === "branches") {
      assertNoUnknownKeys(entry, ["name", "remote", "current", "headOid", "upstream", "ahead", "behind", "checkedOutWorktreeId"], `${what}: entry`);
      assertNonEmptyText(entry.name, `${what}: name`); assertNonEmptyText(entry.headOid, `${what}: headOid`);
      if (typeof entry.remote !== "boolean" || typeof entry.current !== "boolean") throw new ValidationError(`${what}: invalid flags`);
      assertCounter(entry.ahead, `${what}: ahead`); assertCounter(entry.behind, `${what}: behind`);
      if (entry.upstream !== undefined && typeof entry.upstream !== "string") throw new ValidationError(`${what}: upstream must be string`);
      if (entry.checkedOutWorktreeId !== undefined) assertOpaqueToken(entry.checkedOutWorktreeId, `${what}: checkedOutWorktreeId`);
    } else if (kind === "worktrees") {
      assertNoUnknownKeys(entry, ["worktreeId", "name", "branch", "headOid", "current", "detached", "bare", "locked", "lockReason", "prunable", "workspaceId"], `${what}: entry`);
      assertOpaqueToken(entry.worktreeId, `${what}: worktreeId`); assertNonEmptyText(entry.name, `${what}: name`);
      for (const key of ["current", "detached", "bare", "locked", "prunable"] as const) if (typeof entry[key] !== "boolean") throw new ValidationError(`${what}: ${key} must be boolean`);
      for (const key of ["branch", "headOid", "lockReason"] as const) if (entry[key] !== undefined && typeof entry[key] !== "string") throw new ValidationError(`${what}: ${key} must be string`);
      if (entry.workspaceId !== undefined) assertOpaqueToken(entry.workspaceId, `${what}: workspaceId`);
    } else {
      assertNoUnknownKeys(entry, ["name", "fetchUrl", "pushUrl", "host", "repository"], `${what}: entry`);
      assertNonEmptyText(entry.name, `${what}: name`); assertNonEmptyText(entry.fetchUrl, `${what}: fetchUrl`); assertNonEmptyText(entry.pushUrl, `${what}: pushUrl`);
      if (/^[a-z]+:\/\/[^/@\s]+@/iu.test(entry.fetchUrl) || /^[a-z]+:\/\/[^/@\s]+@/iu.test(entry.pushUrl)) throw new ValidationError(`${what}: remote URL contains userinfo`);
      if (/^(?:[A-Za-z]:[\\/]|\/)/u.test(entry.fetchUrl) || /^(?:[A-Za-z]:[\\/]|\/)/u.test(entry.pushUrl)) throw new ValidationError(`${what}: remote URL contains an absolute path`);
      for (const key of ["host", "repository"] as const) if (entry[key] !== undefined && typeof entry[key] !== "string") throw new ValidationError(`${what}: ${key} must be string`);
    }
  }
}

function assertGithubAuth(value: unknown): void {
  const what = "github.auth.get result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["available", "authenticated", "host", "account", "gitProtocol", "unavailableReason"], what);
  if (typeof value.available !== "boolean" || typeof value.authenticated !== "boolean") throw new ValidationError(`${what}: invalid flags`);
  if (value.gitProtocol !== undefined && value.gitProtocol !== "https" && value.gitProtocol !== "ssh") throw new ValidationError(`${what}: invalid gitProtocol`);
  for (const key of ["host", "account", "unavailableReason"] as const) if (value[key] !== undefined && typeof value[key] !== "string") throw new ValidationError(`${what}: ${key} must be string`);
}

function assertGithubPullRequest(value: unknown, what: string): void {
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["number", "title", "body", "state", "draft", "headBranch", "baseBranch", "headOid", "author", "url", "reviewDecision", "mergeState", "additions", "deletions", "changedFiles", "updatedAt"], what);
  if (typeof value.number !== "number" || !Number.isSafeInteger(value.number) || value.number <= 0) throw new ValidationError(`${what}: number must be positive`);
  assertNonEmptyText(value.title, `${what}: title`);
  if (value.body !== undefined && (typeof value.body !== "string" || value.body.length > 2 * 1024 * 1024)) throw new ValidationError(`${what}: invalid body`);
  if (value.state !== "open" && value.state !== "closed" && value.state !== "merged") throw new ValidationError(`${what}: invalid state`);
  if (typeof value.draft !== "boolean") throw new ValidationError(`${what}: draft must be boolean`);
  assertNonEmptyText(value.headBranch, `${what}: headBranch`);
  assertNonEmptyText(value.baseBranch, `${what}: baseBranch`);
  for (const key of ["headOid", "author", "reviewDecision", "mergeState", "updatedAt"] as const) if (value[key] !== undefined && typeof value[key] !== "string") throw new ValidationError(`${what}: ${key} must be string`);
  if (typeof value.url !== "string" || !value.url.startsWith("https://") || /^[a-z]+:\/\/[^/@\s]+@/iu.test(value.url)) throw new ValidationError(`${what}: invalid URL`);
  for (const key of ["additions", "deletions", "changedFiles"] as const) if (value[key] !== undefined) assertCounter(value[key], `${what}: ${key}`);
}

function assertGithubChecks(value: unknown, what: string): void {
  if (!Array.isArray(value) || value.length > 1_000) throw new ValidationError(`${what}: checks must be bounded`);
  for (const check of value) {
    assertPlainObject(check, `${what}: check`);
    assertNoUnknownKeys(check, ["name", "state", "bucket", "link", "workflow"], `${what}: check`);
    assertNonEmptyText(check.name, `${what}: check.name`);
    assertNonEmptyText(check.state, `${what}: check.state`);
    if (check.bucket !== "pass" && check.bucket !== "fail" && check.bucket !== "pending" && check.bucket !== "skipping" && check.bucket !== "cancel") throw new ValidationError(`${what}: invalid check bucket`);
    if (check.link !== undefined && (typeof check.link !== "string" || !check.link.startsWith("https://"))) throw new ValidationError(`${what}: invalid check link`);
    if (check.workflow !== undefined && typeof check.workflow !== "string") throw new ValidationError(`${what}: workflow must be string`);
  }
}

function assertGithubPrPayload(value: unknown, mode: "list" | "detail" | "checks"): void {
  const what = `github.pr.${mode} result`;
  assertPlainObject(value, what);
  if (mode === "list") {
    assertNoUnknownKeys(value, ["workspaceId", "pullRequests"], what); assertOpaqueToken(value.workspaceId, `${what}: workspaceId`); if (!Array.isArray(value.pullRequests) || value.pullRequests.length > 1_000) throw new ValidationError(`${what}: pullRequests must be bounded`); for (const pullRequest of value.pullRequests) assertGithubPullRequest(pullRequest, `${what}: pullRequest`); return;
  }
  if (mode === "checks") {
    assertNoUnknownKeys(value, ["workspaceId", "pullRequestNumber", "checks", "overall"], what); assertOpaqueToken(value.workspaceId, `${what}: workspaceId`); if (typeof value.pullRequestNumber !== "number" || !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber <= 0) throw new ValidationError(`${what}: pullRequestNumber must be positive`); assertGithubChecks(value.checks, what); if (value.overall !== "pass" && value.overall !== "fail" && value.overall !== "pending" && value.overall !== "neutral") throw new ValidationError(`${what}: invalid overall`); return;
  }
  assertNoUnknownKeys(value, ["workspaceId", "pullRequest", "checks"], what); assertOpaqueToken(value.workspaceId, `${what}: workspaceId`); assertGithubPullRequest(value.pullRequest, `${what}: pullRequest`); assertGithubChecks(value.checks, what);
}

const GIT_OPERATION_KINDS = ["init", "clone", "stage", "unstage", "discard", "commit", "branch.create", "branch.switch", "branch.rename", "branch.delete", "worktree.pickRoot", "worktree.create", "worktree.lock", "worktree.unlock", "worktree.remove", "worktree.prune", "remote.add", "remote.setUrl", "remote.remove", "fetch", "pull", "push", "stash.push", "stash.apply", "stash.drop", "tag.create", "tag.delete", "merge", "rebase", "cherry-pick", "revert", "checkout", "reset", "continue", "abort", "cancel"] as const;
const GITHUB_OPERATION_KINDS = ["auth.login", "auth.logout", "pr.create", "pr.edit", "pr.ready", "pr.comment", "pr.review", "pr.updateBranch", "pr.merge", "pr.close", "pr.reopen", "pr.checkout", "cancel"] as const;

function assertGitOperationResult(value: unknown): void {
  const what = "git.execute result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["operation", "message", "repository", "workspaceId", "createdWorkspaceId", "url"], what);
  if (typeof value.operation !== "string" || !(GIT_OPERATION_KINDS as readonly string[]).includes(value.operation)) throw new ValidationError(`${what}: invalid operation`);
  assertNonEmptyText(value.message, `${what}: message`);
  if (value.repository !== undefined) assertGitRepository(value.repository);
  for (const key of ["workspaceId", "createdWorkspaceId"] as const) if (value[key] !== undefined) assertOpaqueToken(value[key], `${what}: ${key}`);
  if (value.url !== undefined && (typeof value.url !== "string" || !value.url.startsWith("https://"))) throw new ValidationError(`${what}: invalid URL`);
}

function assertGithubOperationResult(value: unknown): void {
  const what = "github.execute result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["operation", "message", "url", "pullRequest"], what);
  if (typeof value.operation !== "string" || !(GITHUB_OPERATION_KINDS as readonly string[]).includes(value.operation)) throw new ValidationError(`${what}: invalid operation`);
  assertNonEmptyText(value.message, `${what}: message`);
  if (value.url !== undefined && (typeof value.url !== "string" || !value.url.startsWith("https://"))) throw new ValidationError(`${what}: invalid URL`);
  if (value.pullRequest !== undefined) assertGithubPullRequest(value.pullRequest, `${what}: pullRequest`);
}

function assertWorkspaceFileMutationResult(value: unknown): void {
  const what = "workspace file mutation result";
  assertPlainObject(value, what);
  assertNoUnknownKeys(value, ["applied", "kind", "path"], what);
  if (typeof value.applied !== "boolean") throw new ValidationError(`${what}: applied must be boolean`);
  if (value.kind !== "file" && value.kind !== "directory") throw new ValidationError(`${what}: invalid kind`);
  assertRelativePath(value.path, `${what}: path`);
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
    if (queryName === "session.transcript.read") {
      try {
        parseConversationTranscriptPage(value.result);
      } catch (error) {
        throw new ValidationError(
          `query response: invalid transcript page (${error instanceof Error ? error.message : "invalid"})`,
        );
      }
    }
    if (queryName === "conversation.open") {
      try {
        parseConversationOpenResult(value.result);
      } catch (error) {
        throw new ValidationError(
          `query response: invalid conversation open result (${error instanceof Error ? error.message : "invalid"})`,
        );
      }
    }
    if (queryName === "session.transcript.readPage") {
      assertConversationTranscriptReadPage(value.result);
    }
    if (queryName === "session.agents.list") {
      assertSessionAgentsListResult(value.result);
    }
    if (queryName === "agent.transcript.read") {
      assertAgentTranscriptPage(value.result);
    }
    if (queryName === "agent.conversation.read") {
      try {
        parseConversationTranscriptPage(value.result);
      } catch (error) {
        throw new ValidationError(
          `query response: invalid agent conversation page (${error instanceof Error ? error.message : "invalid"})`,
        );
      }
    }
    if (queryName === "session.telemetry.read") {
      assertSessionTelemetryReadResult(value.result);
    }
    if (queryName === "residents.list") {
      assertResidentsReadModel(value.result, "residents.list result");
    }
    if (queryName === "workspace.fileTree") {
      assertWorkspaceFileTree(value.result);
    }
    if (queryName === "git.toolchain.get") assertGitToolchain(value.result);
    if (queryName === "git.repository.get") assertGitRepository(value.result);
    if (queryName === "git.diff.get") assertGitDiff(value.result);
    if (queryName === "git.branches.list") assertGitList(value.result, "branches");
    if (queryName === "git.worktrees.list") assertGitList(value.result, "worktrees");
    if (queryName === "git.remotes.list") assertGitList(value.result, "remotes");
    if (queryName === "git.log.list") assertGitLogList(value.result);
    if (queryName === "git.commit.changes") assertGitCommitChanges(value.result);
    if (queryName === "git.commit.diff") assertGitCommitDiff(value.result);
    if (queryName === "github.auth.get") assertGithubAuth(value.result);
    if (queryName === "github.pr.list") assertGithubPrPayload(value.result, "list");
    if (queryName === "github.pr.get") assertGithubPrPayload(value.result, "detail");
    if (queryName === "github.pr.checks") assertGithubPrPayload(value.result, "checks");
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
  "interaction.required",
  "interaction.resolved",
  "command.receipt",
  "runtime.changed",
  "resync.required",
  "diagnostics.changed",
  "residents.changed",
  "telemetry.changed",
  "operation.progress",
  "git.repository.changed",
  "conversation.changed",
  "btw.changed",
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
  "ask",
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

function assertAskOptionList(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new ValidationError("event: ask options must be an array");
  }
  for (const option of value) {
    assertPlainObject(option, "event: ask option");
    assertNoUnknownKeys(option, ["id", "label", "description", "preview"], "event: ask option");
    assertNonEmptyText(option.id, "event: ask option id");
    assertNonEmptyText(option.label, "event: ask option label");
    if (option.description !== undefined && typeof option.description !== "string") {
      throw new ValidationError("event: ask option description must be a string");
    }
    if (option.preview !== undefined && typeof option.preview !== "string") {
      throw new ValidationError("event: ask option preview must be a string");
    }
  }
}

function assertAskQuestions(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError("event: ask questions must be a non-empty array");
  }
  for (const question of value) {
    assertPlainObject(question, "event: ask question");
    assertNoUnknownKeys(
      question,
      ["id", "question", "header", "options", "multiple", "recommended"],
      "event: ask question",
    );
    assertNonEmptyText(question.id, "event: ask question id");
    assertNonEmptyText(question.question, "event: ask question text");
    if (question.header !== undefined && typeof question.header !== "string") {
      throw new ValidationError("event: ask question header must be a string");
    }
    assertAskOptionList(question.options);
    if (typeof question.multiple !== "boolean") {
      throw new ValidationError("event: ask question multiple must be a boolean");
    }
    if (
      question.recommended !== undefined &&
      (typeof question.recommended !== "number" || !Number.isSafeInteger(question.recommended) || question.recommended < 0)
    ) {
      throw new ValidationError("event: ask question recommended must be a non-negative integer");
    }
  }
}

/** Assert a Host-issued interaction prompt shape. */
function assertClientInteraction(value: unknown): void {
  assertPlainObject(value, "event: interaction");
  assertOpaqueToken(value.interactionId, "event: interactionId");
  assertOpaqueToken(value.sessionId, "event: interaction sessionId");
  assertCounter(value.leaseGeneration, "event: interaction leaseGeneration");
  assertNonEmptyText(value.title, "event: interaction title");
  if (value.requestId !== undefined) {
    assertOpaqueToken(value.requestId, "event: interaction requestId");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(INTERACTION_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(`event: interaction has unknown kind ${describe(kind)}`);
  }
  switch (kind) {
    case "confirm":
      assertNoUnknownKeys(
        value,
        [
          "kind",
          "interactionId",
          "sessionId",
          "leaseGeneration",
          "title",
          "requestId",
          "message",
          "destructive",
        ],
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
        ["kind", "interactionId", "sessionId", "leaseGeneration", "title", "requestId", "options", "multiple"],
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
        ["kind", "interactionId", "sessionId", "leaseGeneration", "title", "requestId", "placeholder", "secret"],
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
        ["kind", "interactionId", "sessionId", "leaseGeneration", "title", "requestId", "content", "language"],
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
        ["kind", "interactionId", "sessionId", "leaseGeneration", "title", "requestId", "approvalType", "detail"],
        "event: interaction",
      );
      assertNonEmptyText(value.approvalType, "event: interaction approvalType");
      assertPlainObject(value.detail, "event: interaction detail");
      return;
    case "ask":
      assertNoUnknownKeys(
        value,
        ["kind", "interactionId", "sessionId", "leaseGeneration", "title", "requestId", "questions"],
        "event: interaction",
      );
      assertAskQuestions(value.questions);
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
      if (commandName === "git.execute") assertGitOperationResult(value.result);
      if (commandName === "github.execute") assertGithubOperationResult(value.result);
      if (commandName === "workspace.file.create" || commandName === "workspace.directory.create") assertWorkspaceFileMutationResult(value.result);
      if (commandName === "operator.invoke") assertOperatorInvokeOutcome(value.result);
      if (commandName === "session.tree.navigate" || commandName === "session.tree.branch") {
        assertSessionTreeCommandOutcome(value.result);
      }
      if (commandName === "btw.ask") assertBtwAskOutcome(value.result);
      if (commandName === "btw.branch") assertBtwBranchOutcome(value.result);
      if (commandName === "runtime.ensure") assertRuntimeConnection(value.result);
      if (commandName === "runtime.settings.get") assertRuntimeSettingsGetResult(value.result);
      if (commandName === "runtime.settings.set") assertRuntimeSettingsSetResult(value.result);
      if (commandName === "mode.plan.review.saveAndQuit") assertPlanSaveAndQuitResult(value.result);
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

/** Assert the enriched operator.invoke completion: snapshot + output + raw result. */
function assertOperatorInvokeOutcome(value: unknown): void {
  assertPlainObject(value, "event: operator.invoke result");
  assertNoUnknownKeys(value, ["snapshot", "output", "result"], "event: operator.invoke result");
  assertOperatorStateSnapshot(value.snapshot, "event: operator.invoke result snapshot");
  if (!Array.isArray(value.output)) {
    throw new ValidationError("event: operator.invoke result output must be an array");
  }
  for (const line of value.output) {
    if (typeof line !== "string") {
      throw new ValidationError("event: operator.invoke result output must contain only strings");
    }
  }
  if (!("result" in value)) {
    throw new ValidationError("event: operator.invoke result is missing the command result");
  }
}

const SESSION_TREE_RESULT_KEYS = [
  "snapshot",
  "cancelled",
  "sessionId",
  "editorText",
  "editorImages",
  "leafId",
  "aborted",
  "askReanswerCommitted",
] as const;

/** Assert tree navigate/branch completion: snapshot plus optional editor fill-back. */
function assertSessionTreeCommandOutcome(value: unknown): void {
  assertPlainObject(value, "event: session.tree result");
  assertNoUnknownKeys(value, [...SESSION_TREE_RESULT_KEYS], "event: session.tree result");
  assertOperatorStateSnapshot(value.snapshot, "event: session.tree result snapshot");
  if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") {
    throw new ValidationError("event: session.tree result cancelled must be boolean");
  }
  if (value.aborted !== undefined && typeof value.aborted !== "boolean") {
    throw new ValidationError("event: session.tree result aborted must be boolean");
  }
  if (value.askReanswerCommitted !== undefined && typeof value.askReanswerCommitted !== "boolean") {
    throw new ValidationError("event: session.tree result askReanswerCommitted must be boolean");
  }
  if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length === 0)) {
    throw new ValidationError("event: session.tree result sessionId must be a non-empty string");
  }
  if (value.editorText !== undefined && typeof value.editorText !== "string") {
    throw new ValidationError("event: session.tree result editorText must be a string");
  }
  if (value.leafId !== undefined && value.leafId !== null && (typeof value.leafId !== "string" || value.leafId.length === 0)) {
    throw new ValidationError("event: session.tree result leafId must be a non-empty string or null");
  }
  if (value.editorImages !== undefined) {
    validatePromptImages(value.editorImages, "event: session.tree result editorImages");
  }
}

const BTW_STATUS_VALUES = ["running", "completed", "failed", "aborted"] as const satisfies readonly BtwStatus[];

const BTW_ERROR_CODE_VALUES = ["INTERNAL_ERROR", "OUTPUT_LIMIT"] as const satisfies readonly BtwErrorCode[];

/** Assert the BTW side-channel snapshot carried by `btw.changed` and receipts. */
function assertBtwSnapshot(value: unknown, field: string): void {
  assertPlainObject(value, field);
  assertNoUnknownKeys(value, ["ephemeralId", "status", "text", "copy", "error"], field);
  assertOpaqueToken(value.ephemeralId, `${field} ephemeralId`);
  if (typeof value.status !== "string" || !(BTW_STATUS_VALUES as readonly string[]).includes(value.status)) {
    throw new ValidationError(`${field} has unsupported status ${describe(value.status)}`);
  }
  if (typeof value.text !== "string") {
    throw new ValidationError(`${field} text must be a string`);
  }
  if (value.copy !== undefined && typeof value.copy !== "string") {
    throw new ValidationError(`${field} copy must be a string`);
  }
  if (value.error !== undefined) {
    assertPlainObject(value.error, `${field} error`);
    assertNoUnknownKeys(value.error, ["code", "message"], `${field} error`);
    if (typeof value.error.code !== "string" || !(BTW_ERROR_CODE_VALUES as readonly string[]).includes(value.error.code)) {
      throw new ValidationError(`${field} error has unsupported code ${describe(value.error.code)}`);
    }
    if (typeof value.error.message !== "string") {
      throw new ValidationError(`${field} error message must be a string`);
    }
  }
}

/** Assert `btw.ask` completion: snapshot plus the one-shot branch authorization. */
function assertBtwAskOutcome(value: unknown): void {
  assertPlainObject(value, "event: btw.ask result");
  assertNoUnknownKeys(value, ["snapshot", "ephemeralId", "branchToken", "status"], "event: btw.ask result");
  assertOperatorStateSnapshot(value.snapshot, "event: btw.ask result snapshot");
  assertOpaqueToken(value.ephemeralId, "event: btw.ask result ephemeralId");
  assertOpaqueToken(value.branchToken, "event: btw.ask result branchToken");
  if (value.status !== "running") {
    throw new ValidationError('event: btw.ask result status must be exactly "running"');
  }
}

/** Assert `btw.branch` completion: whether the branch happened and where it landed. */
function assertBtwBranchOutcome(value: unknown): void {
  assertPlainObject(value, "event: btw.branch result");
  assertNoUnknownKeys(value, ["snapshot", "branched", "newSessionId", "newLeafId", "reason"], "event: btw.branch result");
  assertOperatorStateSnapshot(value.snapshot, "event: btw.branch result snapshot");
  if (typeof value.branched !== "boolean") {
    throw new ValidationError("event: btw.branch result branched must be boolean");
  }
  if (value.newSessionId !== undefined) assertOpaqueToken(value.newSessionId, "event: btw.branch result newSessionId");
  if (value.newLeafId !== undefined) assertOpaqueToken(value.newLeafId, "event: btw.branch result newLeafId");
  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new ValidationError("event: btw.branch result reason must be a string");
  }
}

const CONNECTION_STATUSES = [
  "connecting",
  "connected",
  "disconnected",
  "unavailable",
] as const satisfies readonly RuntimeConnectionStatus[];

const CONNECTION_CLASSIFICATIONS = [
  "unavailable",
  "managed",
  "compatible-system",
  "limited-system",
  "rejected",
] as const satisfies readonly RuntimeClassification[];

const UNAVAILABLE_CODES = [
  "no-workspace",
  "workspace-unusable",
  "not-installed",
  "resolution-rejected",
  "resolution-limited",
  "launch-failed",
  "handshake-timeout",
  "spawn-failed",
  "exited-before-ready",
  "not-wired",
] as const satisfies readonly RuntimeUnavailableCode[];

const DISCONNECT_CODES = [
  "pipe-closed",
  "process-exit",
  "lease-lost",
  "host-stop",
] as const satisfies readonly RuntimeDisconnectCode[];

const AUTO_RESPAWN_STATUSES = [
  "scheduled",
  "failed",
  "exhausted",
] as const satisfies readonly RuntimeAutoRespawnStatus[];

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
      "unavailableCode",
      "unavailableReason",
      "disconnectCode",
      "disconnectReason",
      "disconnectedAt",
      "autoRespawn",
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
    "unavailableReason",
    "disconnectReason",
  ] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new ValidationError(`event: connection ${field} must be a string`);
    }
  }
  if (value.unavailableCode !== undefined) {
    if (typeof value.unavailableCode !== "string" || !(UNAVAILABLE_CODES as readonly string[]).includes(value.unavailableCode)) {
      throw new ValidationError(`event: connection has unknown unavailableCode ${describe(value.unavailableCode)}`);
    }
  }
  if (value.disconnectCode !== undefined) {
    if (typeof value.disconnectCode !== "string" || !(DISCONNECT_CODES as readonly string[]).includes(value.disconnectCode)) {
      throw new ValidationError(`event: connection has unknown disconnectCode ${describe(value.disconnectCode)}`);
    }
  }
  if (value.disconnectedAt !== undefined) {
    if (typeof value.disconnectedAt !== "string" || value.disconnectedAt.length === 0) {
      throw new ValidationError("event: connection disconnectedAt must be a non-empty string");
    }
  }
  if (value.autoRespawn !== undefined) {
    if (typeof value.autoRespawn !== "string" || !(AUTO_RESPAWN_STATUSES as readonly string[]).includes(value.autoRespawn)) {
      throw new ValidationError(`event: connection has unknown autoRespawn ${describe(value.autoRespawn)}`);
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
      assertOperatorStateSnapshot(value.snapshot, "event: snapshot");
      return;
    case "state.changed":
    case "diagnostics.changed":
      assertEventKeys(value, "event", []);
      assertEventBase(value);
      return;
    case "residents.changed":
      assertEventKeys(value, "event", ["residents"]);
      assertEventBase(value);
      assertResidentsReadModel(value.residents, "event: residents");
      return;
    case "operation.progress":
      assertEventKeys(value, "event", ["progress"]);
      assertEventBase(value);
      assertPlainObject(value.progress, "event: progress");
      assertNoUnknownKeys(value.progress, ["requestId", "domain", "phase", "message", "percent"], "event: progress");
      assertOpaqueToken(value.progress.requestId, "event: progress requestId");
      if (value.progress.domain !== "git" && value.progress.domain !== "github") throw new ValidationError("event: invalid progress domain");
      assertNonEmptyText(value.progress.phase, "event: progress phase");
      if (typeof value.progress.message !== "string") throw new ValidationError("event: progress message must be string");
      if (value.progress.percent !== undefined && (typeof value.progress.percent !== "number" || !Number.isFinite(value.progress.percent) || value.progress.percent < 0 || value.progress.percent > 100)) throw new ValidationError("event: progress percent must be 0..100");
      return;
    case "git.repository.changed":
      assertEventKeys(value, "event", ["repository"]);
      assertEventBase(value);
      assertPlainObject(value.repository, "event: repository");
      assertNoUnknownKeys(value.repository, ["workspaceId", "repositoryId", "revision", "reason"], "event: repository");
      assertOpaqueToken(value.repository.workspaceId, "event: repository workspaceId");
      if (value.repository.repositoryId !== undefined) assertOpaqueToken(value.repository.repositoryId, "event: repository repositoryId");
      if (value.repository.revision !== undefined) assertOpaqueToken(value.repository.revision, "event: repository revision");
      if (value.repository.reason !== "command" && value.repository.reason !== "workspace" && value.repository.reason !== "external") throw new ValidationError("event: invalid repository change reason");
      return;
    case "telemetry.changed":
      assertEventKeys(value, "event", ["sessionId", "telemetry"]);
      assertEventBase(value);
      assertOpaqueToken(value.sessionId, "event: telemetry sessionId");
      assertPlainObject(value.telemetry, "event: telemetry");
      return;
    case "command.accepted":
      assertEventKeys(value, "event", ["accepted"]);
      assertEventBase(value);
      assertClientCommandAccepted(value.accepted);
      return;
    case "interaction.required":
      assertEventKeys(value, "event", ["interaction"]);
      assertEventBase(value);
      assertClientInteraction(value.interaction);
      return;
    case "interaction.resolved":
      assertEventKeys(value, "event", ["interactionId", "leaseGeneration", "outcome"]);
      assertEventBase(value);
      assertOpaqueToken(value.interactionId, "event: interactionId");
      assertCounter(value.leaseGeneration, "event: leaseGeneration");
      if (
        value.outcome !== "submitted" &&
        value.outcome !== "cancelled" &&
        value.outcome !== "aborted" &&
        value.outcome !== "expired"
      ) {
        throw new ValidationError(`event: unsupported interaction outcome ${describe(value.outcome)}`);
      }
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
    case "conversation.changed":
      assertEventKeys(value, "event", ["sessionId", "streamSeq", "eventSeq", "update"]);
      assertEventBase(value);
      assertOpaqueToken(value.sessionId, "event: sessionId");
      assertCounter(value.streamSeq, "event: streamSeq");
      assertCounter(value.eventSeq, "event: eventSeq");
      if (!isPlainObject(value.update)) {
        throw new ValidationError("event: conversation update must be a plain object");
      }
      try {
        const parsed = parseConversationRuntimeEvent(value.update);
        if (parsed.sessionId !== value.sessionId) {
          throw new ValidationError("event: conversation sessionId does not match update.sessionId");
        }
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        throw new ValidationError(
          `event: invalid conversation update (${error instanceof Error ? error.message : "invalid"})`,
        );
      }
      return;
    case "btw.changed":
      assertEventKeys(value, "event", ["sessionId", "eventSeq", "snapshot"]);
      assertEventBase(value);
      assertOpaqueToken(value.sessionId, "event: btw sessionId");
      assertCounter(value.eventSeq, "event: btw eventSeq");
      assertBtwSnapshot(value.snapshot, "event: btw snapshot");
      return;
    default:
      throw new ValidationError(`event: unhandled kind ${describe(kind)}`);
  }
}
