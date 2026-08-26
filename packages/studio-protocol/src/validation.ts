import { ContractValidationError } from "./contract-error.js";
import type { AgentTranscriptMessage, AgentTranscriptPage } from "./contracts/agents-jobs.js";
import { parseBtwSnapshot } from "./btw-validation.js";
import type { AgentId, Generation, OpaqueCursor } from "./contracts/ids.js";
import {
  CONVERSATION_LIMITS,
  SESSION_TRANSCRIPT_READ_KIND,
} from "./contracts/conversation.js";
import {
  STUDIO_PROTOCOL_NAME,
  STUDIO_PROTOCOL_VERSION,
  type FrameHeader,
  type StudioEventEnvelope,
  type StudioHelloRequest,
  type StudioHelloResponse,
  type StudioReceipt,
  type StudioRequest,
  type StudioSnapshotResponse,
} from "./contracts/protocol.js";
import { SESSION_THINKING_LEVELS, SESSION_THINKING_SELECTORS } from "./contracts/state.js";
import type { OperatorStateSnapshot } from "./contracts/state.js";
import {
  STUDIO_RUNTIME_CODE_MODES,
  STUDIO_RUNTIME_COMPACTION_METHODS,
  STUDIO_RUNTIME_SETTING_KEYS,
  STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS,
  STUDIO_RUNTIME_UNEXPECTED_STOP_MODES,
  type StudioRuntimeSettingKey,
} from "./contracts/runtime-settings.js";
import type { OperatorCommandManifest } from "./contracts/manifests.js";
import {
  isConversationRuntimeEventKind,
  parseConversationRuntimeEvent,
  parseOpaqueConversationCursor,
  parseSessionTranscriptReadLimit,
} from "./conversation-validation.js";
import {
  isSessionTelemetryEventKind,
  parseSessionTelemetryEvent,
  parseSessionTelemetryReadResult,
  parseSessionTelemetrySnapshot,
} from "./telemetry-validation.js";

export { ContractValidationError } from "./contract-error.js";
export { isBtwErrorCode, isBtwStatus, parseBtwSnapshot } from "./btw-validation.js";
export {
  parseConversationContentBlock,
  parseConversationItem,
  parseConversationRuntimeEvent,
  parseConversationTranscriptPage,
  parseOpaqueConversationCursor,
  parseSessionTranscriptReadLimit,
} from "./conversation-validation.js";
export {
  isSessionTelemetryEventKind,
  parseSessionTelemetryEvent,
  parseSessionTelemetryReadResult,
  parseSessionTelemetrySnapshot,
} from "./telemetry-validation.js";

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractValidationError("expected an object", path);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new ContractValidationError(`unknown field ${JSON.stringify(unknown)}`, path);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractValidationError("expected a non-empty string", path);
  }
  return value;
}

const INTERACTION_LIMITS = {
  ID_MAX_CHARS: 256,
  TITLE_MAX_CHARS: 4_096,
  MESSAGE_MAX_CHARS: 16 * 1024,
  OPTION_COUNT_MAX: 256,
  QUESTION_COUNT_MAX: 32,
  OPTION_TEXT_MAX_CHARS: 4_096,
  EDITOR_CONTENT_MAX_CHARS: 128 * 1024,
  DETAILS_MAX_BYTES: 64 * 1024,
} as const;

function boundedInteractionString(value: unknown, path: string, maxChars: number): string {
  const text = nonEmptyString(value, path);
  if (text.length > maxChars) {
    throw new ContractValidationError(`string exceeds ${maxChars} characters`, path);
  }
  return text;
}

function boundedOptionalInteractionString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new ContractValidationError("expected a string", path);
  }
  if (value.length > maxChars) {
    throw new ContractValidationError(`string exceeds ${maxChars} characters`, path);
  }
  return value;
}

function boundedInteractionJson(value: unknown, path: string, maxBytes: number): void {
  jsonValue(value, path);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || new TextEncoder().encode(encoded).length > maxBytes) {
    throw new ContractValidationError(`JSON value exceeds ${maxBytes} bytes`, path);
  }
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ContractValidationError("expected a boolean", path);
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ContractValidationError("expected a non-negative safe integer", path);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ContractValidationError("expected a positive safe integer", path);
  }
  return value as number;
}

function oneOf(value: unknown, values: readonly string[], path: string): string {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new ContractValidationError("unsupported value", path);
  }
  return value;
}

function validateRuntimeSettingValue(
  key: StudioRuntimeSettingKey,
  value: unknown,
  path: string,
): void {
  switch (key) {
    case "edit.autoRepair.enabled":
    case "extendedContext":
    case "compaction.asyncEnabled":
      booleanValue(value, path);
      return;
    case "features.unexpectedStopDetection":
      oneOf(value, STUDIO_RUNTIME_UNEXPECTED_STOP_MODES, path);
      return;
    case "providers.unexpectedStopModel":
      oneOf(value, STUDIO_RUNTIME_UNEXPECTED_STOP_MODELS, path);
      return;
    case "providers.openai-codex.codeMode":
      oneOf(value, STUDIO_RUNTIME_CODE_MODES, path);
      return;
    case "compaction.methodOrder":
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some((item) => !STUDIO_RUNTIME_COMPACTION_METHODS.includes(item as (typeof STUDIO_RUNTIME_COMPACTION_METHODS)[number])) ||
        new Set(value).size !== value.length
      ) {
        throw new ContractValidationError("expected a non-empty array of unique compaction methods", path);
      }
      return;
  }
}

function validateRuntimeSettingsSnapshot(value: unknown, path: string): void {
  const settings = record(value, path);
  exactKeys(settings, STUDIO_RUNTIME_SETTING_KEYS, path);
  for (const key of STUDIO_RUNTIME_SETTING_KEYS) {
    validateRuntimeSettingValue(key, settings[key], `${path}.${key}`);
  }
}

function validateRuntimeSettingsSelection(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > STUDIO_RUNTIME_SETTING_KEYS.length) {
    throw new ContractValidationError("expected a non-empty settings key array", path);
  }
  if (
    value.some((key) => !STUDIO_RUNTIME_SETTING_KEYS.includes(key as StudioRuntimeSettingKey)) ||
    new Set(value).size !== value.length
  ) {
    throw new ContractValidationError("expected unique supported settings keys", path);
  }
}

function validatePlanSavePath(value: unknown, path: string): void {
  const rawPath = nonEmptyString(value, path);
  if (
    rawPath.length > 1024 ||
    rawPath.includes("\0") ||
    rawPath !== rawPath.trim() ||
    ((rawPath.startsWith('"') && rawPath.endsWith('"')) || (rawPath.startsWith("'") && rawPath.endsWith("'")))
  ) {
    throw new ContractValidationError("invalid plan save path", path);
  }
  const normalized = rawPath.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    /^[A-Za-z]:/.test(rawPath) ||
    normalized.endsWith("/")
  ) {
    throw new ContractValidationError("plan save path must be workspace-relative", path);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment.includes(":"))) {
    throw new ContractValidationError("plan save path escapes the workspace", path);
  }
  if (segments.every((segment) => segment.length === 0 || segment === ".")) {
    throw new ContractValidationError("plan save path must name a file", path);
  }
}

export function parseFrameHeader(value: unknown): FrameHeader {
  const input = record(value, "$header");
  exactKeys(input, ["protocol", "version", "frameId", "runtimeEpoch", "bodyLength"], "$header");
  if (input.protocol !== STUDIO_PROTOCOL_NAME) {
    throw new ContractValidationError("unsupported protocol", "$header.protocol");
  }
  if (input.version !== STUDIO_PROTOCOL_VERSION) {
    throw new ContractValidationError("unsupported protocol version", "$header.version");
  }
  nonEmptyString(input.frameId, "$header.frameId");
  nonNegativeInteger(input.runtimeEpoch, "$header.runtimeEpoch");
  nonNegativeInteger(input.bodyLength, "$header.bodyLength");
  return input as unknown as FrameHeader;
}

export function parseStudioHelloRequest(value: unknown): StudioHelloRequest {
  const input = record(value, "$hello");
  exactKeys(
    input,
    ["type", "requestId", "supportedProtocolVersions", "requiredProfile", "challenge"],
    "$hello",
  );
  if (input.type !== "studio.hello") {
    throw new ContractValidationError("expected studio.hello", "$hello.type");
  }
  nonEmptyString(input.requestId, "$hello.requestId");
  nonEmptyString(input.challenge, "$hello.challenge");
  if (input.requiredProfile !== "full-parity-v1") {
    throw new ContractValidationError("unsupported profile", "$hello.requiredProfile");
  }
  if (
    !Array.isArray(input.supportedProtocolVersions) ||
    input.supportedProtocolVersions.length === 0 ||
    input.supportedProtocolVersions.some((item) => !Number.isSafeInteger(item) || item <= 0) ||
    new Set(input.supportedProtocolVersions).size !== input.supportedProtocolVersions.length
  ) {
    throw new ContractValidationError(
      "expected a non-empty array of unique positive integers",
      "$hello.supportedProtocolVersions",
    );
  }
  return input as unknown as StudioHelloRequest;
}

function parseCapabilityManifest(value: unknown): void {
  const manifest = record(value, "$hello.capabilityManifest");
  exactKeys(manifest, ["profile", "generatedAt", "hash", "capabilities"], "$hello.capabilityManifest");
  if (manifest.profile !== "full-parity-v1" && manifest.profile !== "limited") {
    throw new ContractValidationError("unsupported profile", "$hello.capabilityManifest.profile");
  }
  nonEmptyString(manifest.generatedAt, "$hello.capabilityManifest.generatedAt");
  nonEmptyString(manifest.hash, "$hello.capabilityManifest.hash");
  if (!Array.isArray(manifest.capabilities)) {
    throw new ContractValidationError("expected an array", "$hello.capabilityManifest.capabilities");
  }
  const grades = new Set(["stable", "experimental", "limited", "unavailable"]);
  for (const [index, rawEntry] of manifest.capabilities.entries()) {
    const path = `$hello.capabilityManifest.capabilities[${index}]`;
    const entry = record(rawEntry, path);
    exactKeys(entry, ["id", "grade", "version", "evidence", "limitations"], path);
    nonEmptyString(entry.id, `${path}.id`);
    if (!grades.has(entry.grade as string)) {
      throw new ContractValidationError("unsupported capability grade", `${path}.grade`);
    }
    positiveInteger(entry.version, `${path}.version`);
    nonEmptyString(entry.evidence, `${path}.evidence`);
    if (
      entry.limitations !== undefined &&
      (!Array.isArray(entry.limitations) || entry.limitations.some((item) => typeof item !== "string"))
    ) {
      throw new ContractValidationError("expected a string array", `${path}.limitations`);
    }
  }
}

export function parseStudioHelloResponse(value: unknown): StudioHelloResponse {
  const input = record(value, "$hello");
  exactKeys(
    input,
    [
      "type",
      "requestId",
      "selectedProtocolVersion",
      "runtimeVersion",
      "upstreamVersion",
      "upstreamCommit",
      "runtimeInstanceId",
      "runtimeEpoch",
      "capabilityManifest",
      "commandManifestHash",
      "stateVersion",
      "challengeProof",
    ],
    "$hello",
  );
  if (input.type !== "studio.hello.result") {
    throw new ContractValidationError("expected studio.hello.result", "$hello.type");
  }
  nonEmptyString(input.requestId, "$hello.requestId");
  positiveInteger(input.selectedProtocolVersion, "$hello.selectedProtocolVersion");
  nonEmptyString(input.runtimeVersion, "$hello.runtimeVersion");
  nonEmptyString(input.upstreamVersion, "$hello.upstreamVersion");
  nonEmptyString(input.upstreamCommit, "$hello.upstreamCommit");
  nonEmptyString(input.runtimeInstanceId, "$hello.runtimeInstanceId");
  positiveInteger(input.runtimeEpoch, "$hello.runtimeEpoch");
  parseCapabilityManifest(input.capabilityManifest);
  nonEmptyString(input.commandManifestHash, "$hello.commandManifestHash");
  nonNegativeInteger(input.stateVersion, "$hello.stateVersion");
  nonEmptyString(input.challengeProof, "$hello.challengeProof");
  return input as unknown as StudioHelloResponse;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) nonEmptyString(value, path);
}

const COMMAND_SOURCES = new Set(["builtin", "extension", "skill", "prompt-template", "file-command"]);
const COMMAND_IMPLEMENTATIONS = new Set([
  "shared-service",
  "headless-handle",
  "extension-command",
  "tui-compatibility",
]);
const COMMAND_PRESENTATIONS = new Set(["native", "generic-form", "terminal"]);
const COMMAND_AVAILABILITY = new Set(["available", "disabled", "blocked"]);
const COMMAND_RISKS = new Set(["normal", "sensitive", "destructive"]);
const COMMAND_EFFECTS = new Set(["read", "session", "workspace", "process", "external"]);
const INTERACTION_KINDS = new Set(["confirm", "select", "input", "editor", "approval", "ask"]);

export function parseOperatorCommandManifest(value: unknown): OperatorCommandManifest {
  const manifest = record(value, "$commandManifest");
  exactKeys(manifest, ["generatedAt", "upstreamCommit", "hash", "commands", "unclassifiedBuiltins"], "$commandManifest");
  nonEmptyString(manifest.generatedAt, "$commandManifest.generatedAt");
  nonEmptyString(manifest.upstreamCommit, "$commandManifest.upstreamCommit");
  nonEmptyString(manifest.hash, "$commandManifest.hash");
  if (!Array.isArray(manifest.commands)) {
    throw new ContractValidationError("expected an array", "$commandManifest.commands");
  }
  const seenIds = new Set<string>();
  for (const [index, rawCommand] of manifest.commands.entries()) {
    const path = `$commandManifest.commands[${index}]`;
    const command = record(rawCommand, path);
    exactKeys(command, ["id", "name", "aliases", "description", "source", "implementation", "argumentSchema", "interactionKinds", "presentation", "availability", "risk", "effect", "contractTestId"], path);
    const id = nonEmptyString(command.id, `${path}.id`);
    if (seenIds.has(id)) throw new ContractValidationError("duplicate command id", `${path}.id`);
    seenIds.add(id);
    nonEmptyString(command.name, `${path}.name`);
    nonEmptyString(command.description, `${path}.description`);
    if (!Array.isArray(command.aliases) || command.aliases.some((alias) => typeof alias !== "string")) {
      throw new ContractValidationError("expected a string array", `${path}.aliases`);
    }
    if (!COMMAND_SOURCES.has(command.source as string)) throw new ContractValidationError("unsupported command source", `${path}.source`);
    if (!COMMAND_IMPLEMENTATIONS.has(command.implementation as string)) throw new ContractValidationError("unsupported command implementation", `${path}.implementation`);
    if (command.argumentSchema !== undefined) record(command.argumentSchema, `${path}.argumentSchema`);
    if (!Array.isArray(command.interactionKinds) || command.interactionKinds.some((kind) => !INTERACTION_KINDS.has(kind as string))) {
      throw new ContractValidationError("unsupported interaction kind", `${path}.interactionKinds`);
    }
    if (!COMMAND_PRESENTATIONS.has(command.presentation as string)) throw new ContractValidationError("unsupported command presentation", `${path}.presentation`);
    if (!COMMAND_AVAILABILITY.has(command.availability as string)) throw new ContractValidationError("unsupported command availability", `${path}.availability`);
    if (!COMMAND_RISKS.has(command.risk as string)) throw new ContractValidationError("unsupported command risk", `${path}.risk`);
    if (!COMMAND_EFFECTS.has(command.effect as string)) throw new ContractValidationError("unsupported command effect", `${path}.effect`);
    nonEmptyString(command.contractTestId, `${path}.contractTestId`);
  }
  if (!Array.isArray(manifest.unclassifiedBuiltins) || manifest.unclassifiedBuiltins.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ContractValidationError("expected a non-empty string array", "$commandManifest.unclassifiedBuiltins");
  }
  return manifest as unknown as OperatorCommandManifest;
}

export function parseOperatorStateSnapshot(value: unknown): OperatorStateSnapshot {
  const input = record(value, "$snapshot.snapshot");
  exactKeys(
    input,
    [
      "runtimeId",
      "runtimeEpoch",
      "stateVersion",
      "sessionId",
      "sessionTitle",
      "sessionTitleSource",
      "isStreaming",
      "isCompacting",
      "activeMode",
      "approvalMode",
      "plan",
      "goal",
      "vibe",
      "loop",
      "model",
      "fast",
      "prewalk",
      "pause",
      "live",
      "pendingMessages",
      "pendingInteraction",
      "activeCommandIds",
      "agentsRevision",
      "jobsRevision",
      "agents",
      "jobs",
      "telemetry",
      "runtimeSettings",
      "compactionSpeculation",
    ],
    "$snapshot.snapshot",
  );
  nonEmptyString(input.runtimeId, "$snapshot.snapshot.runtimeId");
  positiveInteger(input.runtimeEpoch, "$snapshot.snapshot.runtimeEpoch");
  nonNegativeInteger(input.stateVersion, "$snapshot.snapshot.stateVersion");
  nonEmptyString(input.sessionId, "$snapshot.snapshot.sessionId");
  if (input.sessionTitle !== undefined) nonEmptyString(input.sessionTitle, "$snapshot.snapshot.sessionTitle");
  if (input.sessionTitleSource !== undefined && input.sessionTitleSource !== "user" && input.sessionTitleSource !== "auto") {
    throw new ContractValidationError("unsupported session title source", "$snapshot.snapshot.sessionTitleSource");
  }
  booleanValue(input.isStreaming, "$snapshot.snapshot.isStreaming");
  booleanValue(input.isCompacting, "$snapshot.snapshot.isCompacting");
  if (!["normal", "plan", "goal", "vibe"].includes(input.activeMode as string)) {
    throw new ContractValidationError("unsupported active mode", "$snapshot.snapshot.activeMode");
  }
  if (!["always-ask", "write", "yolo"].includes(input.approvalMode as string)) {
    throw new ContractValidationError("unsupported approval mode", "$snapshot.snapshot.approvalMode");
  }
  nonNegativeInteger(input.pendingMessages, "$snapshot.snapshot.pendingMessages");
  nonNegativeInteger(input.agentsRevision, "$snapshot.snapshot.agentsRevision");
  nonNegativeInteger(input.jobsRevision, "$snapshot.snapshot.jobsRevision");
  for (const [field, raw] of [
    ["activeCommandIds", input.activeCommandIds],
    ["agents", input.agents],
    ["jobs", input.jobs],
  ] as const) {
    if (!Array.isArray(raw)) throw new ContractValidationError("expected an array", `$snapshot.snapshot.${field}`);
  }
  if ((input.activeCommandIds as unknown[]).some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ContractValidationError("expected non-empty string ids", "$snapshot.snapshot.activeCommandIds");
  }

  if (input.plan !== undefined) {
    const plan = record(input.plan, "$snapshot.snapshot.plan");
    exactKeys(plan, ["status", "planReference", "title", "body"], "$snapshot.snapshot.plan");
    if (!["off", "active", "paused", "review"].includes(plan.status as string)) {
      throw new ContractValidationError("unsupported plan status", "$snapshot.snapshot.plan.status");
    }
    optionalString(plan.planReference, "$snapshot.snapshot.plan.planReference");
    if (plan.title !== undefined) boundedInteractionString(plan.title, "$snapshot.snapshot.plan.title", INTERACTION_LIMITS.TITLE_MAX_CHARS);
    if (plan.body !== undefined) boundedInteractionString(plan.body, "$snapshot.snapshot.plan.body", 32 * 1024);
  }
  if (input.goal !== undefined) {
    const goal = record(input.goal, "$snapshot.snapshot.goal");
    exactKeys(goal, ["status", "objective", "tokenBudget", "tokensUsed"], "$snapshot.snapshot.goal");
    if (!["off", "active", "paused", "complete"].includes(goal.status as string)) {
      throw new ContractValidationError("unsupported goal status", "$snapshot.snapshot.goal.status");
    }
    optionalString(goal.objective, "$snapshot.snapshot.goal.objective");
    if (goal.tokenBudget !== undefined) nonNegativeInteger(goal.tokenBudget, "$snapshot.snapshot.goal.tokenBudget");
    if (goal.tokensUsed !== undefined) nonNegativeInteger(goal.tokensUsed, "$snapshot.snapshot.goal.tokensUsed");
  }
  if (input.vibe !== undefined) {
    const vibe = record(input.vibe, "$snapshot.snapshot.vibe");
    exactKeys(vibe, ["enabled", "workerAgentIds"], "$snapshot.snapshot.vibe");
    booleanValue(vibe.enabled, "$snapshot.snapshot.vibe.enabled");
    if (!Array.isArray(vibe.workerAgentIds) || vibe.workerAgentIds.some((item) => typeof item !== "string")) {
      throw new ContractValidationError("expected a string array", "$snapshot.snapshot.vibe.workerAgentIds");
    }
  }
  if (input.loop !== undefined) {
    const loop = record(input.loop, "$snapshot.snapshot.loop");
    exactKeys(loop, ["status", "prompt", "iterations"], "$snapshot.snapshot.loop");
    if (!["waiting", "running", "paused"].includes(loop.status as string)) {
      throw new ContractValidationError("unsupported loop status", "$snapshot.snapshot.loop.status");
    }
    optionalString(loop.prompt, "$snapshot.snapshot.loop.prompt");
    if (loop.iterations !== undefined) nonNegativeInteger(loop.iterations, "$snapshot.snapshot.loop.iterations");
  }
  if (input.model !== undefined) {
    const model = record(input.model, "$snapshot.snapshot.model");
    exactKeys(model, ["selector", "provider", "id", "thinking", "configuredThinking"], "$snapshot.snapshot.model");
    nonEmptyString(model.selector, "$snapshot.snapshot.model.selector");
    nonEmptyString(model.provider, "$snapshot.snapshot.model.provider");
    nonEmptyString(model.id, "$snapshot.snapshot.model.id");
    if (model.thinking !== undefined && !THINKING_LEVEL_SET.has(model.thinking as string)) {
      throw new ContractValidationError("unsupported thinking level", "$snapshot.snapshot.model.thinking");
    }
    if (model.configuredThinking !== undefined) {
      assertThinkingSelector(model.configuredThinking, "$snapshot.snapshot.model.configuredThinking");
    }
  }
  if (input.fast !== undefined) {
    const fast = record(input.fast, "$snapshot.snapshot.fast");
    exactKeys(fast, ["enabled", "active"], "$snapshot.snapshot.fast");
    booleanValue(fast.enabled, "$snapshot.snapshot.fast.enabled");
    if (fast.active !== undefined) booleanValue(fast.active, "$snapshot.snapshot.fast.active");
  }
  if (input.prewalk !== undefined) {
    const prewalk = record(input.prewalk, "$snapshot.snapshot.prewalk");
    exactKeys(prewalk, ["status", "target"], "$snapshot.snapshot.prewalk");
    if (!["off", "armed", "active"].includes(prewalk.status as string)) {
      throw new ContractValidationError("unsupported prewalk status", "$snapshot.snapshot.prewalk.status");
    }
    optionalString(prewalk.target, "$snapshot.snapshot.prewalk.target");
  }
  if (input.pause !== undefined) {
    const pause = record(input.pause, "$snapshot.snapshot.pause");
    exactKeys(pause, ["paused", "pauseEpoch", "pausedAt"], "$snapshot.snapshot.pause");
    booleanValue(pause.paused, "$snapshot.snapshot.pause.paused");
    if (pause.pauseEpoch !== undefined) nonNegativeInteger(pause.pauseEpoch, "$snapshot.snapshot.pause.pauseEpoch");
    optionalString(pause.pausedAt, "$snapshot.snapshot.pause.pausedAt");
  }
  if (input.live !== undefined) {
    const live = record(input.live, "$snapshot.snapshot.live");
    exactKeys(live, ["status", "deviceId"], "$snapshot.snapshot.live");
    if (!["off", "connecting", "active", "stopping", "failed"].includes(live.status as string)) {
      throw new ContractValidationError("unsupported live status", "$snapshot.snapshot.live.status");
    }
    optionalString(live.deviceId, "$snapshot.snapshot.live.deviceId");
  }
  if (input.pendingInteraction !== undefined) {
    const interaction = record(input.pendingInteraction, "$snapshot.snapshot.pendingInteraction");
    exactKeys(
      interaction,
      ["request", "owner", "leaseGeneration"],
      "$snapshot.snapshot.pendingInteraction",
    );
    if (interaction.owner !== "gui" && interaction.owner !== "tui") {
      throw new ContractValidationError("unsupported interaction owner", "$snapshot.snapshot.pendingInteraction.owner");
    }
    positiveInteger(interaction.leaseGeneration, "$snapshot.snapshot.pendingInteraction.leaseGeneration");
    validateRemoteInteractionRequest(
      record(interaction.request, "$snapshot.snapshot.pendingInteraction.request"),
      "$snapshot.snapshot.pendingInteraction.request",
    );
  }
  if (input.telemetry !== undefined) parseSessionTelemetrySnapshot(input.telemetry, "$snapshot.snapshot.telemetry");
  if (input.runtimeSettings !== undefined) {
    validateRuntimeSettingsSnapshot(input.runtimeSettings, "$snapshot.snapshot.runtimeSettings");
  }
  if (input.compactionSpeculation !== undefined) {
    oneOf(input.compactionSpeculation, ["idle", "running", "armed"], "$snapshot.snapshot.compactionSpeculation");
  }
  return input as unknown as OperatorStateSnapshot;
}

export function parseStudioSnapshotResponse(value: unknown): StudioSnapshotResponse {
  const input = record(value, "$snapshot");
  exactKeys(
    input,
    [
      "type",
      "requestId",
      "snapshot",
      "commandManifestHash",
      "capabilityHash",
      "lastEventSeq",
      "messagesCursor",
      "terminalReceipts",
    ],
    "$snapshot",
  );
  if (input.type !== "studio.snapshot") {
    throw new ContractValidationError("expected studio.snapshot", "$snapshot.type");
  }
  nonEmptyString(input.requestId, "$snapshot.requestId");
  const snapshot = parseOperatorStateSnapshot(input.snapshot);
  nonEmptyString(input.commandManifestHash, "$snapshot.commandManifestHash");
  nonEmptyString(input.capabilityHash, "$snapshot.capabilityHash");
  nonNegativeInteger(input.lastEventSeq, "$snapshot.lastEventSeq");
  optionalString(input.messagesCursor, "$snapshot.messagesCursor");
  if (!Array.isArray(input.terminalReceipts)) {
    throw new ContractValidationError("expected an array", "$snapshot.terminalReceipts");
  }
  for (const receipt of input.terminalReceipts) parseStudioReceipt(receipt);
  if ((input.terminalReceipts as StudioReceipt[]).some((receipt) => receipt.runtimeEpoch !== snapshot.runtimeEpoch)) {
    throw new ContractValidationError("receipt epoch mismatch", "$snapshot.terminalReceipts");
  }
  return input as unknown as StudioSnapshotResponse;
}

export function parseStudioEventEnvelope(value: unknown): StudioEventEnvelope {
  const input = record(value, "$event");
  exactKeys(input, ["type", "runtimeEpoch", "eventSeq", "stateVersion", "occurredAt", "event"], "$event");
  if (input.type !== "studio.event") throw new ContractValidationError("expected studio.event", "$event.type");
  positiveInteger(input.runtimeEpoch, "$event.runtimeEpoch");
  positiveInteger(input.eventSeq, "$event.eventSeq");
  nonNegativeInteger(input.stateVersion, "$event.stateVersion");
  nonEmptyString(input.occurredAt, "$event.occurredAt");
  const event = record(input.event, "$event.event");
  nonEmptyString(event.kind, "$event.event.kind");
  if (event.kind === "state.changed") {
    exactKeys(event, ["kind", "snapshot"], "$event.event");
    const snapshot = parseOperatorStateSnapshot(event.snapshot);
    if (snapshot.runtimeEpoch !== input.runtimeEpoch || snapshot.stateVersion !== input.stateVersion) {
      throw new ContractValidationError("state event identity mismatch", "$event.event.snapshot");
    }
  } else if (event.kind === "interaction.required") {
    exactKeys(event, ["kind", "request", "owner", "leaseGeneration"], "$event.event");
    if (event.owner !== "gui" && event.owner !== "tui") {
      throw new ContractValidationError("unsupported interaction owner", "$event.event.owner");
    }
    positiveInteger(event.leaseGeneration, "$event.event.leaseGeneration");
    validateRemoteInteractionRequest(record(event.request, "$event.event.request"), "$event.event.request");
  } else if (event.kind === "interaction.resolved") {
    exactKeys(event, ["kind", "interactionId", "commandId", "leaseGeneration", "outcome"], "$event.event");
    nonEmptyString(event.interactionId, "$event.event.interactionId");
    nonEmptyString(event.commandId, "$event.event.commandId");
    positiveInteger(event.leaseGeneration, "$event.event.leaseGeneration");
    if (!["submitted", "cancelled", "aborted", "expired"].includes(event.outcome as string)) {
      throw new ContractValidationError("unsupported interaction outcome", "$event.event.outcome");
    }
  } else if (event.kind === "progress") {
    exactKeys(event, ["kind", "commandId", "stage", "percent"], "$event.event");
    nonEmptyString(event.commandId, "$event.event.commandId");
    nonEmptyString(event.stage, "$event.event.stage");
    if (
      event.percent !== undefined &&
      (typeof event.percent !== "number" || !Number.isFinite(event.percent) || event.percent < 0 || event.percent > 100)
    ) {
      throw new ContractValidationError("expected percent from 0 to 100", "$event.event.percent");
    }
  } else if (event.kind === "notify") {
    exactKeys(event, ["kind", "severity", "title", "message"], "$event.event");
    if (event.severity !== "info" && event.severity !== "warning" && event.severity !== "error") {
      throw new ContractValidationError("unsupported notification severity", "$event.event.severity");
    }
    nonEmptyString(event.title, "$event.event.title");
    if (event.message !== undefined) nonEmptyString(event.message, "$event.event.message");
  } else if (
    event.kind === "runtime.ready" ||
    event.kind === "runtime.quiescing" ||
    event.kind === "runtime.shutdownComplete"
  ) {
    exactKeys(event, ["kind"], "$event.event");
  } else if (event.kind === "runtime.resyncRequired") {
    exactKeys(event, ["kind", "reason"], "$event.event");
    nonEmptyString(event.reason, "$event.event.reason");
  } else if (event.kind === "command.started") {
    exactKeys(event, ["kind", "commandId", "operationKind"], "$event.event");
    nonEmptyString(event.commandId, "$event.event.commandId");
    nonEmptyString(event.operationKind, "$event.event.operationKind");
  } else if (event.kind === "command.interactionRequired" || event.kind === "command.completed") {
    exactKeys(event, ["kind", "commandId"], "$event.event");
    nonEmptyString(event.commandId, "$event.event.commandId");
  } else if (event.kind === "command.failed") {
    exactKeys(event, ["kind", "commandId", "error"], "$event.event");
    nonEmptyString(event.commandId, "$event.event.commandId");
    const error = record(event.error, "$event.event.error");
    exactKeys(error, ["code", "message", "retryable", "details"], "$event.event.error");
    nonEmptyString(error.code, "$event.event.error.code");
    if (typeof error.message !== "string") {
      throw new ContractValidationError("expected a string", "$event.event.error.message");
    }
    booleanValue(error.retryable, "$event.event.error.retryable");
    if (error.details !== undefined) record(error.details, "$event.event.error.details");
  } else if (event.kind === "btw.changed") {
    exactKeys(event, ["kind", "snapshot"], "$event.event");
    parseBtwSnapshot(event.snapshot, "$event.event.snapshot");
  } else if (isSessionTelemetryEventKind(event.kind)) {
    parseSessionTelemetryEvent(event, "$event.event");
  } else if (isConversationRuntimeEventKind(event.kind)) {
    parseConversationRuntimeEvent(event, "$event.event");
  } else {
    throw new ContractValidationError("unsupported event kind", "$event.event.kind");
  }
  return input as unknown as StudioEventEnvelope;
}

function validateAskOption(value: unknown, path: string): void {
  const option = record(value, path);
  exactKeys(option, ["id", "label", "description", "preview"], path);
  boundedInteractionString(option.id, `${path}.id`, INTERACTION_LIMITS.ID_MAX_CHARS);
  boundedInteractionString(option.label, `${path}.label`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
  if (option.description !== undefined) {
    boundedOptionalInteractionString(option.description, `${path}.description`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
  }
  if (option.preview !== undefined) {
    boundedOptionalInteractionString(option.preview, `${path}.preview`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
  }
}

function validateAskQuestions(value: unknown, path: string): void {
  if (!Array.isArray(value) || value.length === 0 || value.length > INTERACTION_LIMITS.QUESTION_COUNT_MAX) {
    throw new ContractValidationError("expected a non-empty question list", path);
  }
  for (const [index, entry] of value.entries()) {
    const question = record(entry, `${path}[${index}]`);
    exactKeys(question, ["id", "question", "header", "options", "multiple", "recommended"], `${path}[${index}]`);
    boundedInteractionString(question.id, `${path}[${index}].id`, INTERACTION_LIMITS.ID_MAX_CHARS);
    boundedInteractionString(question.question, `${path}[${index}].question`, INTERACTION_LIMITS.TITLE_MAX_CHARS);
    if (question.header !== undefined) {
      boundedOptionalInteractionString(question.header, `${path}[${index}].header`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
    }
    if (!Array.isArray(question.options) || question.options.length > INTERACTION_LIMITS.OPTION_COUNT_MAX) {
      throw new ContractValidationError("expected options", `${path}[${index}].options`);
    }
    for (const [optionIndex, option] of question.options.entries()) {
      validateAskOption(option, `${path}[${index}].options[${optionIndex}]`);
    }
    if (question.multiple !== undefined && typeof question.multiple !== "boolean") {
      throw new ContractValidationError("expected a boolean", `${path}[${index}].multiple`);
    }
    if (question.recommended !== undefined) {
      if (typeof question.recommended !== "number" || !Number.isSafeInteger(question.recommended) || question.recommended < 0) {
        throw new ContractValidationError("expected a non-negative integer", `${path}[${index}].recommended`);
      }
    }
  }
}

function validateRemoteInteractionRequest(request: Record<string, unknown>, path: string): void {
  const kind = nonEmptyString(request.kind, `${path}.kind`);
  const baseKeys = ["kind", "interactionId", "commandId", "title"];
  boundedInteractionString(request.interactionId, `${path}.interactionId`, INTERACTION_LIMITS.ID_MAX_CHARS);
  boundedInteractionString(request.commandId, `${path}.commandId`, INTERACTION_LIMITS.ID_MAX_CHARS);
  boundedInteractionString(request.title, `${path}.title`, INTERACTION_LIMITS.TITLE_MAX_CHARS);
  switch (kind) {
    case "confirm":
      exactKeys(request, [...baseKeys, "message", "destructive"], path);
      boundedInteractionString(request.message, `${path}.message`, INTERACTION_LIMITS.MESSAGE_MAX_CHARS);
      if (request.destructive !== undefined && typeof request.destructive !== "boolean") {
        throw new ContractValidationError("expected a boolean", `${path}.destructive`);
      }
      return;
    case "select": {
      exactKeys(request, [...baseKeys, "options", "multiple"], path);
      if (!Array.isArray(request.options) || request.options.length === 0 || request.options.length > INTERACTION_LIMITS.OPTION_COUNT_MAX) {
        throw new ContractValidationError("expected non-empty options", `${path}.options`);
      }
      for (const [index, value] of request.options.entries()) {
        const option = record(value, `${path}.options[${index}]`);
        exactKeys(option, ["id", "label", "description"], `${path}.options[${index}]`);
        boundedInteractionString(option.id, `${path}.options[${index}].id`, INTERACTION_LIMITS.ID_MAX_CHARS);
        boundedInteractionString(option.label, `${path}.options[${index}].label`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
        if (option.description !== undefined) {
          boundedOptionalInteractionString(option.description, `${path}.options[${index}].description`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
        }
      }
      if (request.multiple !== undefined && typeof request.multiple !== "boolean") {
        throw new ContractValidationError("expected a boolean", `${path}.multiple`);
      }
      return;
    }
    case "input":
      exactKeys(request, [...baseKeys, "placeholder", "secret"], path);
      if (request.placeholder !== undefined) boundedOptionalInteractionString(request.placeholder, `${path}.placeholder`, INTERACTION_LIMITS.OPTION_TEXT_MAX_CHARS);
      if (request.secret !== undefined && typeof request.secret !== "boolean") {
        throw new ContractValidationError("expected a boolean", `${path}.secret`);
      }
      return;
    case "editor":
      exactKeys(request, [...baseKeys, "content", "language", "promptStyle"], path);
      if (request.content !== undefined) boundedOptionalInteractionString(request.content, `${path}.content`, INTERACTION_LIMITS.EDITOR_CONTENT_MAX_CHARS);
      if (request.language !== undefined) boundedOptionalInteractionString(request.language, `${path}.language`, 128);
      if (request.promptStyle !== undefined && typeof request.promptStyle !== "boolean") {
        throw new ContractValidationError("expected a boolean", `${path}.promptStyle`);
      }
      return;
    case "approval":
      exactKeys(request, [...baseKeys, "approvalType", "details"], path);
      boundedInteractionString(request.approvalType, `${path}.approvalType`, INTERACTION_LIMITS.ID_MAX_CHARS);
      boundedInteractionJson(request.details, `${path}.details`, INTERACTION_LIMITS.DETAILS_MAX_BYTES);
      return;
    case "ask": {
      exactKeys(request, [...baseKeys, "questions"], path);
      validateAskQuestions(request.questions, `${path}.questions`);
      return;
    }
    default:
      throw new ContractValidationError("unsupported interaction kind", `${path}.kind`);
  }
}

type OperationShape = {
  readonly keys: readonly string[];
  readonly validate?: (operation: Record<string, unknown>) => void;
};

function optionalImageArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) {
    throw new ContractValidationError("expected an array", path);
  }
  for (const [index, image] of value.entries()) {
    if (image === null || typeof image !== "object" || Array.isArray(image)) {
      throw new ContractValidationError("expected an image object", `${path}[${index}]`);
    }
  }
}

const MAX_COMMAND_ID_LENGTH = 1024;
const MAX_AGENT_ID_LENGTH = 512;
const MAX_AGENT_DEFINITION_LENGTH = 256;
const MAX_AGENT_TEXT_LENGTH = 64 * 1024;
const MAX_MODEL_SELECTOR_LENGTH = 256;
const MAX_TRANSCRIPT_PAGE = CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX;
const THINKING_LEVEL_SET = new Set<string>(SESSION_THINKING_LEVELS);
const THINKING_SELECTOR_SET = new Set<string>(SESSION_THINKING_SELECTORS);

function assertThinkingSelector(value: unknown, path: string): void {
  if (typeof value !== "string" || !THINKING_SELECTOR_SET.has(value)) {
    throw new ContractValidationError("unsupported thinking selector", path);
  }
}

function jsonValue(value: unknown, path: string, seen: Set<object> = new Set()): void {
  if (value === null) return;
  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (Number.isFinite(value)) return;
      throw new ContractValidationError("expected a finite JSON number", path);
    case "object": {
      if (seen.has(value)) {
        throw new ContractValidationError("cyclic value is not JSON-safe", path);
      }
      seen.add(value);
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) {
          jsonValue(item, `${path}[${index}]`, seen);
        }
        seen.delete(value);
        return;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        seen.delete(value);
        throw new ContractValidationError("expected a plain object", path);
      }
      for (const [key, item] of Object.entries(value)) {
        jsonValue(item, `${path}.${key}`, seen);
      }
      seen.delete(value);
      return;
    }
    default:
      throw new ContractValidationError("expected a JSON-safe value", path);
  }
}

function validateGoalMutation(operation: Record<string, unknown>): void {
  nonEmptyString(operation.objective, "$request.operation.objective");
  if (operation.tokenBudget !== undefined) {
    positiveInteger(operation.tokenBudget, "$request.operation.tokenBudget");
  }
}

function validateAgentLifecycleMutation(operation: Record<string, unknown>): void {
  const agentId = nonEmptyString(operation.agentId, "$request.operation.agentId");
  if (agentId.length > MAX_AGENT_ID_LENGTH) {
    throw new ContractValidationError("agentId is too long", "$request.operation.agentId");
  }
  positiveInteger(operation.expectedGeneration, "$request.operation.expectedGeneration");
}

const FOUNDATION_OPERATIONS: Readonly<Record<string, OperationShape>> = {
  "runtime.snapshot": { keys: ["kind"] },
  "runtime.pause": { keys: ["kind"] },
  "runtime.resume": {
    keys: ["kind", "expectedPauseEpoch"],
    validate: (operation) => {
      nonNegativeInteger(operation.expectedPauseEpoch, "$request.operation.expectedPauseEpoch");
    },
  },
  "runtime.settings.get": {
    keys: ["kind", "keys"],
    validate: (operation) => {
      if (operation.keys !== undefined) validateRuntimeSettingsSelection(operation.keys, "$request.operation.keys");
    },
  },
  "runtime.settings.set": {
    keys: ["kind", "key", "value", "persist"],
    validate: (operation) => {
      if (!STUDIO_RUNTIME_SETTING_KEYS.includes(operation.key as StudioRuntimeSettingKey)) {
        throw new ContractValidationError("unsupported Runtime setting key", "$request.operation.key");
      }
      validateRuntimeSettingValue(operation.key as StudioRuntimeSettingKey, operation.value, "$request.operation.value");
      booleanValue(operation.persist, "$request.operation.persist");
    },
  },
  "runtime.shutdown": {
    keys: ["kind", "drain"],
    validate: (operation) => {
      if (operation.drain !== true) {
        throw new ContractValidationError("drain must be true", "$request.operation.drain");
      }
    },
  },
  "live.start": {
    keys: ["kind", "deviceId"],
    validate: (operation) => {
      if (operation.deviceId !== undefined) nonEmptyString(operation.deviceId, "$request.operation.deviceId");
    },
  },
  "live.stop": { keys: ["kind"] },
  "queue.enqueue": {
    keys: ["kind", "text"],
    validate: (operation) => {
      nonEmptyString(operation.text, "$request.operation.text");
    },
  },
  "session.clearContext": { keys: ["kind"] },
  "session.drop": { keys: ["kind"] },
  "turn.retry": { keys: ["kind"] },
  "core.prompt": {
    keys: ["kind", "text", "images"],
    validate: (operation) => {
      nonEmptyString(operation.text, "$request.operation.text");
      if (operation.images !== undefined) {
        optionalImageArray(operation.images, "$request.operation.images");
      }
    },
  },
  "core.steer": {
    keys: ["kind", "text", "images"],
    validate: (operation) => {
      nonEmptyString(operation.text, "$request.operation.text");
      if (operation.images !== undefined) {
        optionalImageArray(operation.images, "$request.operation.images");
      }
    },
  },
  "core.followUp": {
    keys: ["kind", "text", "images"],
    validate: (operation) => {
      nonEmptyString(operation.text, "$request.operation.text");
      if (operation.images !== undefined) {
        optionalImageArray(operation.images, "$request.operation.images");
      }
    },
  },
  "core.abort": { keys: ["kind"] },
  "loop.enable": {
    keys: ["kind", "prompt", "limit"],
    validate: (operation) => {
      if (operation.prompt !== undefined) {
        nonEmptyString(operation.prompt, "$request.operation.prompt");
      }
      if (operation.limit !== undefined) {
        const limit = record(operation.limit, "$request.operation.limit");
        exactKeys(limit, ["turns", "minutes", "tokens"], "$request.operation.limit");
        const defined = [limit.turns, limit.minutes, limit.tokens].filter((value) => value !== undefined);
        if (defined.length > 1) {
          throw new ContractValidationError("expected at most one loop limit", "$request.operation.limit");
        }
        for (const [key, value] of Object.entries(limit)) {
          positiveInteger(value, `$request.operation.limit.${key}`);
        }
      }
    },
  },
  "loop.pause": { keys: ["kind"] },
  "loop.disable": { keys: ["kind"] },
  "session.fast.set": {
    keys: ["kind", "enabled"],
    validate: (operation) => {
      booleanValue(operation.enabled, "$request.operation.enabled");
    },
  },
  "session.prewalk.arm": {
    keys: ["kind", "target"],
    validate: (operation) => {
      if (operation.target !== undefined) nonEmptyString(operation.target, "$request.operation.target");
    },
  },
  "session.prewalk.disarm": { keys: ["kind"] },
  "session.fork": { keys: ["kind"] },
  "session.handoff": {
    keys: ["kind", "customInstructions"],
    validate: (operation) => {
      if (operation.customInstructions !== undefined) {
        nonEmptyString(operation.customInstructions, "$request.operation.customInstructions");
      }
    },
  },
  "session.model.set": {
    keys: ["kind", "selector", "thinking"],
    validate: (operation) => {
      const selector = nonEmptyString(operation.selector, "$request.operation.selector");
      if (selector.length > MAX_MODEL_SELECTOR_LENGTH) {
        throw new ContractValidationError(
          `selector must be at most ${MAX_MODEL_SELECTOR_LENGTH} characters`,
          "$request.operation.selector",
        );
      }
      if (operation.thinking !== undefined) {
        assertThinkingSelector(operation.thinking, "$request.operation.thinking");
      }
    },
  },
  "session.thinking.set": {
    keys: ["kind", "level"],
    validate: (operation) => assertThinkingSelector(operation.level, "$request.operation.level"),
  },
  "session.tree.get": { keys: ["kind"] },
  [SESSION_TRANSCRIPT_READ_KIND]: {
    keys: ["kind", "cursor", "limit"],
    validate: (operation) => {
      if (operation.cursor !== undefined) {
        parseOpaqueConversationCursor(operation.cursor, "$request.operation.cursor");
      }
      if (operation.limit !== undefined) {
        parseSessionTranscriptReadLimit(operation.limit, "$request.operation.limit");
      }
    },
  },
  "session.tree.navigate": {
    keys: ["kind", "targetId", "summarize", "customInstructions", "reanswer"],
    validate: (operation) => {
      nonEmptyString(operation.targetId, "$request.operation.targetId");
      if (operation.summarize !== undefined && typeof operation.summarize !== "boolean") {
        throw new ContractValidationError("expected a boolean", "$request.operation.summarize");
      }
      if (operation.customInstructions !== undefined) {
        nonEmptyString(operation.customInstructions, "$request.operation.customInstructions");
      }
    },
  },
  "session.tree.branch": {
    keys: ["kind", "targetId"],
    validate: (operation) => {
      nonEmptyString(operation.targetId, "$request.operation.targetId");
    },
  },
  "mode.plan.enter": {
    keys: ["kind", "initialPrompt"],
    validate: (operation) => {
      if (operation.initialPrompt !== undefined) nonEmptyString(operation.initialPrompt, "$request.operation.initialPrompt");
    },
  },
  "mode.plan.exit": {
    keys: ["kind", "discardDraft"],
    validate: (operation) => {
      if (operation.discardDraft !== undefined && typeof operation.discardDraft !== "boolean") {
        throw new ContractValidationError("expected a boolean", "$request.operation.discardDraft");
      }
    },
  },
  "mode.plan.review.open": { keys: ["kind"] },
  "mode.plan.review.respond": {
    keys: ["kind", "decision", "feedback"],
    validate: (operation) => {
      if (
        !new Set(["execute", "compact", "keep", "approve", "refine", "dismiss"]).has(
          operation.decision as string,
        )
      ) {
        throw new ContractValidationError("invalid plan decision", "$request.operation.decision");
      }
      if (operation.feedback !== undefined) nonEmptyString(operation.feedback, "$request.operation.feedback");
    },
  },
  "mode.plan.review.saveAndQuit": {
    keys: ["kind", "path"],
    validate: (operation) => validatePlanSavePath(operation.path, "$request.operation.path"),
  },
  "mode.vibe.enter": {
    keys: ["kind", "initialPrompt"],
    validate: (operation) => {
      if (operation.initialPrompt !== undefined) nonEmptyString(operation.initialPrompt, "$request.operation.initialPrompt");
    },
  },
  "mode.vibe.exit": { keys: ["kind"] },
  "goal.create": {
    keys: ["kind", "objective", "tokenBudget"],
    validate: validateGoalMutation,
  },
  "goal.replace": {
    keys: ["kind", "objective", "tokenBudget"],
    validate: validateGoalMutation,
  },
  "goal.show": { keys: ["kind"] },
  "goal.setBudget": {
    keys: ["kind", "tokenBudget"],
    validate: (operation) => {
      if (operation.tokenBudget !== undefined) positiveInteger(operation.tokenBudget, "$request.operation.tokenBudget");
    },
  },
  "goal.pause": { keys: ["kind"] },
  "goal.resume": { keys: ["kind"] },
  "goal.drop": { keys: ["kind"] },
  "goal.guided.start": {
    keys: ["kind", "initial"],
    validate: (operation) => {
      if (operation.initial !== undefined) nonEmptyString(operation.initial, "$request.operation.initial");
    },
  },
  "btw.ask": {
    keys: ["kind", "question"],
    validate: (operation) => nonEmptyString(operation.question, "$request.operation.question"),
  },
  "btw.abort": {
    keys: ["kind", "ephemeralId"],
    validate: (operation) => nonEmptyString(operation.ephemeralId, "$request.operation.ephemeralId"),
  },
  "btw.branch": {
    keys: ["kind", "branchToken"],
    validate: (operation) => nonEmptyString(operation.branchToken, "$request.operation.branchToken"),
  },
  "tan.start": {
    keys: ["kind", "work"],
    validate: (operation) => nonEmptyString(operation.work, "$request.operation.work"),
  },
  "omfg.generate": {
    keys: ["kind", "complaint"],
    validate: (operation) => nonEmptyString(operation.complaint, "$request.operation.complaint"),
  },
  "omfg.amend": {
    keys: ["kind", "candidateId", "feedback"],
    validate: (operation) => {
      nonEmptyString(operation.candidateId, "$request.operation.candidateId");
      nonEmptyString(operation.feedback, "$request.operation.feedback");
    },
  },
  "omfg.commit": {
    keys: ["kind", "candidateId", "scope", "overwrite"],
    validate: (operation) => {
      nonEmptyString(operation.candidateId, "$request.operation.candidateId");
      if (operation.scope !== "project" && operation.scope !== "user") {
        throw new ContractValidationError("unsupported OMFG scope", "$request.operation.scope");
      }
      if (typeof operation.overwrite !== "boolean") {
        throw new ContractValidationError("expected a boolean", "$request.operation.overwrite");
      }
    },
  },
  "agent.list": {
    keys: ["kind", "includeTerminal", "includePersisted"],
    validate: (operation) => {
      if (operation.includeTerminal !== undefined) {
        booleanValue(operation.includeTerminal, "$request.operation.includeTerminal");
      }
      if (operation.includePersisted !== undefined) {
        booleanValue(operation.includePersisted, "$request.operation.includePersisted");
      }
    },
  },
  "agent.get": {
    keys: ["kind", "agentId"],
    validate: (operation) => {
      const agentId = nonEmptyString(operation.agentId, "$request.operation.agentId");
      if (agentId.length > MAX_AGENT_ID_LENGTH) {
        throw new ContractValidationError("agentId is too long", "$request.operation.agentId");
      }
    },
  },
  "agent.spawn": {
    keys: ["kind", "definition", "assignment", "context", "async", "isolation", "effort"],
    validate: (operation) => {
      const definition = nonEmptyString(operation.definition, "$request.operation.definition");
      const assignment = nonEmptyString(operation.assignment, "$request.operation.assignment");
      if (definition.length > MAX_AGENT_DEFINITION_LENGTH) {
        throw new ContractValidationError("definition is too long", "$request.operation.definition");
      }
      if (assignment.length > MAX_AGENT_TEXT_LENGTH) {
        throw new ContractValidationError("assignment is too long", "$request.operation.assignment");
      }
      if (operation.context !== undefined) {
        const context = nonEmptyString(operation.context, "$request.operation.context");
        if (context.length > MAX_AGENT_TEXT_LENGTH) {
          throw new ContractValidationError("context is too long", "$request.operation.context");
        }
      }
      if (operation.async !== undefined) booleanValue(operation.async, "$request.operation.async");
      if (operation.isolation !== undefined && operation.isolation !== "patch" && operation.isolation !== "branch") {
        throw new ContractValidationError("unsupported isolation", "$request.operation.isolation");
      }
      if (operation.effort !== undefined && !new Set(["lo", "med", "hi"]).has(operation.effort as string)) {
        throw new ContractValidationError("unsupported effort", "$request.operation.effort");
      }
    },
  },
  "agent.send": {
    keys: ["kind", "agentId", "expectedGeneration", "text", "mode", "images"],
    validate: (operation) => {
      const agentId = nonEmptyString(operation.agentId, "$request.operation.agentId");
      const text = nonEmptyString(operation.text, "$request.operation.text");
      if (agentId.length > MAX_AGENT_ID_LENGTH) {
        throw new ContractValidationError("agentId is too long", "$request.operation.agentId");
      }
      if (text.length > MAX_AGENT_TEXT_LENGTH) {
        throw new ContractValidationError("text is too long", "$request.operation.text");
      }
      positiveInteger(operation.expectedGeneration, "$request.operation.expectedGeneration");
      if (!new Set(["prompt", "steer", "followUp"]).has(operation.mode as string)) {
        throw new ContractValidationError("unsupported delivery mode", "$request.operation.mode");
      }
      if (operation.images !== undefined) {
        optionalImageArray(operation.images, "$request.operation.images");
      }
    },
  },
  "agent.kill": {
    keys: ["kind", "agentId", "expectedGeneration"],
    validate: validateAgentLifecycleMutation,
  },
  "agent.revive": {
    keys: ["kind", "agentId", "expectedGeneration"],
    validate: validateAgentLifecycleMutation,
  },
  "agent.release": {
    keys: ["kind", "agentId", "expectedGeneration"],
    validate: validateAgentLifecycleMutation,
  },
  "agent.transcript.read": {
    keys: ["kind", "agentId", "cursor", "limit"],
    validate: (operation) => {
      const agentId = nonEmptyString(operation.agentId, "$request.operation.agentId");
      if (agentId.length > MAX_AGENT_ID_LENGTH) {
        throw new ContractValidationError("agentId is too long", "$request.operation.agentId");
      }
      if (operation.cursor !== undefined) nonEmptyString(operation.cursor, "$request.operation.cursor");
      if (operation.limit !== undefined) {
        const limit = positiveInteger(operation.limit, "$request.operation.limit");
        if (limit > MAX_TRANSCRIPT_PAGE) {
          throw new ContractValidationError("limit must be at most 100", "$request.operation.limit");
        }
      }
    },
  },
  "agent.conversation.read": {
    keys: ["kind", "agentId", "cursor", "limit"],
    validate: (operation) => {
      const agentId = nonEmptyString(operation.agentId, "$request.operation.agentId");
      if (agentId.length > MAX_AGENT_ID_LENGTH) {
        throw new ContractValidationError("agentId is too long", "$request.operation.agentId");
      }
      if (operation.cursor !== undefined) {
        const cursor = nonEmptyString(operation.cursor, "$request.operation.cursor");
        if (cursor.length > CONVERSATION_LIMITS.CURSOR_MAX_CHARS) {
          throw new ContractValidationError("cursor exceeds the protocol limit", "$request.operation.cursor");
        }
      }
      if (operation.limit !== undefined) {
        parseSessionTranscriptReadLimit(operation.limit, "$request.operation.limit");
      }
    },
  },
  "agent.subscribe": {
    keys: ["kind", "level"],
    validate: (operation) => {
      if (operation.level !== "progress" && operation.level !== "events") {
        throw new ContractValidationError("unsupported subscription level", "$request.operation.level");
      }
    },
  },
  "job.list": {
    keys: ["kind", "ownerAgentId", "includeRecent"],
    validate: (operation) => {
      if (operation.ownerAgentId !== undefined) {
        const ownerAgentId = nonEmptyString(operation.ownerAgentId, "$request.operation.ownerAgentId");
        if (ownerAgentId.length > MAX_AGENT_ID_LENGTH) {
          throw new ContractValidationError("ownerAgentId is too long", "$request.operation.ownerAgentId");
        }
      }
      if (operation.includeRecent !== undefined) {
        booleanValue(operation.includeRecent, "$request.operation.includeRecent");
      }
    },
  },
  "job.get": {
    keys: ["kind", "jobId"],
    validate: (operation) => nonEmptyString(operation.jobId, "$request.operation.jobId"),
  },
  "job.cancel": {
    keys: ["kind", "jobId", "expectedGeneration"],
    validate: (operation) => {
      nonEmptyString(operation.jobId, "$request.operation.jobId");
      positiveInteger(operation.expectedGeneration, "$request.operation.expectedGeneration");
    },
  },
  "job.subscribe": { keys: ["kind"] },
  "operator.manifest.get": { keys: ["kind"] },
  "operator.invoke": {
    keys: ["kind", "commandId", "arguments"],
    validate: (operation) => {
      const commandId = nonEmptyString(operation.commandId, "$request.operation.commandId");
      if (commandId.length > MAX_COMMAND_ID_LENGTH) {
        throw new ContractValidationError(
          `commandId must be at most ${MAX_COMMAND_ID_LENGTH} characters`,
          "$request.operation.commandId",
        );
      }
      if ("arguments" in operation) {
        jsonValue(operation.arguments, "$request.operation.arguments");
      }
    },
  },
  "permissions.mode.set": {
    keys: ["kind", "mode", "persist"],
    validate: (operation) => {
      if (operation.mode !== "always-ask" && operation.mode !== "write" && operation.mode !== "yolo") {
        throw new ContractValidationError("unsupported approval mode", "$request.operation.mode");
      }
      if (typeof operation.persist !== "boolean") {
        throw new ContractValidationError("expected a boolean", "$request.operation.persist");
      }
    },
  },
  "interaction.respond": {
    keys: ["kind", "interactionId", "commandId", "decision", "value"],
    validate: (operation) => {
      const interactionId = nonEmptyString(operation.interactionId, "$request.operation.interactionId");
      const commandId = nonEmptyString(operation.commandId, "$request.operation.commandId");
      if (interactionId.length > MAX_COMMAND_ID_LENGTH || commandId.length > MAX_COMMAND_ID_LENGTH) {
        throw new ContractValidationError("interaction identity is too long", "$request.operation");
      }
      if (operation.decision !== "submit" && operation.decision !== "cancel") {
        throw new ContractValidationError("unsupported interaction decision", "$request.operation.decision");
      }
      if ("value" in operation) jsonValue(operation.value, "$request.operation.value");
    },
  },
  "tui.transfer": {
    keys: ["kind", "commandId", "interactionId"],
    validate: (operation) => {
      const commandId = nonEmptyString(operation.commandId, "$request.operation.commandId");
      if (commandId.length > MAX_COMMAND_ID_LENGTH) {
        throw new ContractValidationError("commandId is too long", "$request.operation.commandId");
      }
      if (operation.interactionId !== undefined) {
        const interactionId = nonEmptyString(operation.interactionId, "$request.operation.interactionId");
        if (interactionId.length > MAX_COMMAND_ID_LENGTH) {
          throw new ContractValidationError("interactionId is too long", "$request.operation.interactionId");
        }
      }
    },
  },
};

export function parseFoundationStudioRequest(value: unknown): StudioRequest {
  const input = record(value, "$request");
  exactKeys(
    input,
    ["type", "requestId", "runtimeEpoch", "expectedStateVersion", "idempotencyKey", "operation"],
    "$request",
  );
  if (input.type !== "studio.request") {
    throw new ContractValidationError("expected studio.request", "$request.type");
  }
  nonEmptyString(input.requestId, "$request.requestId");
  positiveInteger(input.runtimeEpoch, "$request.runtimeEpoch");
  if (input.expectedStateVersion !== undefined) {
    nonNegativeInteger(input.expectedStateVersion, "$request.expectedStateVersion");
  }
  if (input.idempotencyKey !== undefined) {
    nonEmptyString(input.idempotencyKey, "$request.idempotencyKey");
  }

  const operation = record(input.operation, "$request.operation");
  const kind = nonEmptyString(operation.kind, "$request.operation.kind");
  const shape = FOUNDATION_OPERATIONS[kind];
  if (shape === undefined) {
    throw new ContractValidationError(`unsupported foundation operation ${JSON.stringify(kind)}`, "$request.operation.kind");
  }
  exactKeys(operation, shape.keys, "$request.operation");
  shape.validate?.(operation);
  return input as unknown as StudioRequest;
}

const RECEIPT_STATUSES = new Set(["accepted", "completed", "rejected", "failed", "outcome_unknown"]);
const ERROR_CODES = new Set([
  "UNAUTHENTICATED",
  "PROTOCOL_UNSUPPORTED",
  "RUNTIME_EPOCH_STALE",
  "STATE_VERSION_CONFLICT",
  "CURSOR_STALE",
  "CAPABILITY_UNAVAILABLE",
  "COMMAND_UNKNOWN",
  "COMMAND_BLOCKED",
  "INVALID_ARGUMENT",
  "INTERACTION_REQUIRED",
  "INTERACTION_STALE",
  "AGENT_GENERATION_CONFLICT",
  "JOB_GENERATION_CONFLICT",
  "NOT_OWNER",
  "BUSY_STREAMING",
  "BUSY_COMPACTING",
  "MODE_CONFLICT",
  "TERMINAL_REQUIRED",
  "OUTCOME_UNKNOWN",
  "INTERNAL_ERROR",
]);

export function parseStudioReceipt(value: unknown): StudioReceipt {
  const input = record(value, "$receipt");
  exactKeys(
    input,
    ["type", "requestId", "commandId", "runtimeEpoch", "stateVersion", "status", "result", "error"],
    "$receipt",
  );
  if (input.type !== "studio.receipt") {
    throw new ContractValidationError("expected studio.receipt", "$receipt.type");
  }
  nonEmptyString(input.requestId, "$receipt.requestId");
  if (input.commandId !== undefined) nonEmptyString(input.commandId, "$receipt.commandId");
  positiveInteger(input.runtimeEpoch, "$receipt.runtimeEpoch");
  nonNegativeInteger(input.stateVersion, "$receipt.stateVersion");
  if (!RECEIPT_STATUSES.has(input.status as string)) {
    throw new ContractValidationError("unsupported receipt status", "$receipt.status");
  }
  if (input.error !== undefined) {
    const error = record(input.error, "$receipt.error");
    exactKeys(error, ["code", "message", "retryable", "details"], "$receipt.error");
    if (!ERROR_CODES.has(error.code as string)) {
      throw new ContractValidationError("unsupported error code", "$receipt.error.code");
    }
    if (typeof error.message !== "string") {
      throw new ContractValidationError("expected a string", "$receipt.error.message");
    }
    if (typeof error.retryable !== "boolean") {
      throw new ContractValidationError("expected a boolean", "$receipt.error.retryable");
    }
    if (error.details !== undefined) record(error.details, "$receipt.error.details");
  }
  return input as unknown as StudioReceipt;
}

const AGENT_TRANSCRIPT_ROLES = new Set(["user", "assistant", "custom", "system"]);

/** Structural parser for the Runtime Agent Hub transcript page result. */
export function parseAgentTranscriptPage(value: unknown): AgentTranscriptPage {
  const input = record(value, "$agentPage");
  exactKeys(input, ["agentId", "generation", "cursor", "nextCursor", "messages", "eof"], "$agentPage");
  nonEmptyString(input.agentId, "$agentPage.agentId");
  positiveInteger(input.generation, "$agentPage.generation");
  nonEmptyString(input.cursor, "$agentPage.cursor");
  if (input.nextCursor !== undefined) nonEmptyString(input.nextCursor, "$agentPage.nextCursor");
  if (typeof input.eof !== "boolean") {
    throw new ContractValidationError("expected a boolean", "$agentPage.eof");
  }
  if (!Array.isArray(input.messages)) {
    throw new ContractValidationError("expected an array", "$agentPage.messages");
  }
  const messages = input.messages.map((message, index) => {
    const path = `$agentPage.messages[${index}]`;
    const record_ = record(message, path);
    exactKeys(record_, ["id", "role", "ts", "text"], path);
    nonEmptyString(record_.id, `${path}.id`);
    if (!AGENT_TRANSCRIPT_ROLES.has(record_.role as string)) {
      throw new ContractValidationError("unsupported transcript role", `${path}.role`);
    }
    nonNegativeInteger(record_.ts, `${path}.ts`);
    if (typeof record_.text !== "string") {
      throw new ContractValidationError("expected a string", `${path}.text`);
    }
    return { id: record_.id, role: record_.role, ts: record_.ts, text: record_.text } as AgentTranscriptMessage;
  });
  return {
    agentId: input.agentId as AgentId,
    generation: input.generation as Generation,
    cursor: input.cursor as OpaqueCursor,
    ...(input.nextCursor !== undefined ? { nextCursor: input.nextCursor as OpaqueCursor } : {}),
    messages,
    eof: input.eof as boolean,
  };
}
