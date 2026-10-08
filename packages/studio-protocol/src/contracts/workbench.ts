import { SESSION_TITLES_KINDS, isSessionTitlesKind, validateSessionTitlesOperation, validateSessionTitlesResult, type SessionTitlesOperation, type SessionTitlesResultMap } from "./session-titles.js";
import { PREDICTION_KINDS, isPredictionKind, validatePredictionOperation, validatePredictionResult, type PredictionOperation, type PredictionResultMap } from "./prediction.js";
import { MAINTENANCE_OPERATION_KINDS, MAINTENANCE_READ_KINDS, isMaintenanceKind, validateMaintenanceOperation, validateMaintenanceResult, type MaintenanceOperation, type MaintenanceResultMap } from "./maintenance.js";
import { ARCHIVE_OPERATION_KINDS, isArchiveOperationKind, validateArchiveOperation, validateArchiveResult, type ArchiveOperation, type ArchiveResultMap } from "./archive.js";
import { AGENT_MODEL_KINDS, isAgentModelKind, validateAgentModelOperation, validateAgentModelResult, type AgentModelOperation, type AgentModelResultMap } from "./agent-model.js";
import { SESSION_RESTORE_KINDS, isSessionRestoreKind, validateSessionRestoreOperation, validateSessionRestoreResult, type SessionRestoreOperation, type SessionRestoreResultMap } from "./session-restore.js";
import { RUNTIME_QUEUE_KINDS, isRuntimeQueueKind, validateRuntimeQueueOperation, validateRuntimeQueueResult, type RuntimeQueueOperation, type RuntimeQueueResultMap } from "./runtime-queue.js";
import { NATIVE_PREFERENCE_KINDS, isNativePreferenceKind, validateNativePreferenceOperation, validateNativePreferenceResult, type NativePreferenceOperation, type NativePreferenceResultMap } from "./native-preferences.js";
import { RATCHET_OPERATION_KINDS, isRatchetKind, validateRatchetOperation, validateRatchetResult, type RatchetOperation, type RatchetResultMap } from "./ratchet.js";
import { COMPUTER_OBSERVATION_KINDS, isComputerObservationKind, validateComputerObservationOperation, validateComputerObservationResult, type ComputerObservationOperation, type ComputerObservationResultMap } from "./computer-observation.js";
import { BROWSER_OBSERVATION_KINDS, isBrowserObservationKind, validateBrowserObservationOperation, validateBrowserObservationResult, type BrowserObservationOperation, type BrowserObservationResultMap } from "./browser-observation.js";
import { IDA_OPERATION_KINDS, isIdaOperationKind, validateIdaOperation, validateIdaResult, type StudioIdaOperation, type StudioIdaResultMap } from "./ida.js";
import { SESSION_OPTIONS_KINDS, isSessionOptionsKind, validateSessionOptionsOperation, validateSessionOptionsResult, type SessionOptionsOperation, type SessionOptionsResultMap } from "./session-options.js";
import { SKILLSHARE_OPERATION_KINDS, isSkillshareOperationKind, validateSkillshareOperation, validateSkillshareResult, type SkillshareOperation, type SkillshareResultMap } from "./skillshare.js";
import { LIVE_AUDIO_OPERATION_KINDS, isLiveAudioOperationKind, validateLiveAudioOperation, validateLiveAudioResult, type LiveAudioOperation, type LiveAudioResultMap } from "./live-audio.js";
import { MEDIA_OPERATION_KINDS, isMediaOperationKind, validateMediaOperation, validateMediaResult, type MediaOperation, type MediaResultMap } from "./media.js";
import { BENCHMARK_OPERATION_KINDS, isBenchmarkOperationKind, validateBenchmarkOperation, validateBenchmarkResult, type BenchmarkOperation, type BenchmarkResultMap } from "./benchmarks.js";
import { RUNTIME_CATALOG_OPERATION_KINDS, isRuntimeCatalogOperationKind, validateRuntimeCatalogOperation, validateRuntimeCatalogResult, type RuntimeCatalogOperation, type RuntimeCatalogResultMap } from "./runtime-catalog.js";
import { JUDGMENT_OPERATION_KINDS, isJudgmentOperationKind, validateJudgmentOperation, validateJudgmentResult, type JudgmentOperation, type JudgmentResultMap } from "./judgments.js";
import { ANNOTATION_OPERATION_KINDS, validateAnnotationOperation, validateAnnotationResult, type AnnotationOperation, type AnnotationResultMap } from "./annotations.js";
import { validateAccountStatus, type AccountStatusResult } from "./accounts.js";
/** Shared, presentation-neutral tools added with OMP 18.3.0. */
export interface StudioServiceSpec {
  name: string;
  command: string;
  cwd?: string | undefined;
  env?: Record<string, string> | undefined;
  pty?: boolean | undefined;
  ready?: { log?: string | undefined; port?: number | undefined; host?: string | undefined; timeoutMs: number } | undefined;
  restart?: "no" | "on-failure" | "always" | undefined;
  mode?: "session" | "persist" | "detached" | undefined;
}
export interface StudioServiceRow {
  name: string;
  instanceId: string;
  state: "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";
  startedAt: number;
  readyAt?: number;
  exitedAt?: number;
  exitCode?: number;
  restartCount: number;
  outputBytes: number;
  ownerAgentId?: string;
  mode: "session" | "persist" | "detached";
}
export interface RuntimeModelChoice {
  serviceTiers?: string[];
  promptCache?: { short?: number; long?: number };
  promptCacheConfig?: { short?: number; long?: number };
  compatibility?: { preferWebsockets?: boolean; useResponsesLite?: boolean; toolMode?: "code_mode_only" };
  selector: string;
  name: string;
  provider: string;
  kind: string;
  image: boolean;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  webSearch?: string;
}
export interface TokenCountResult {
  bytes: number;
  chars: number;
  lines: number;
  encodings: Array<{ encoding: string; tokens: number }>;
}

export type WorkbenchOperation =
 | SessionTitlesOperation
 | PredictionOperation
 | MaintenanceOperation
 | ArchiveOperation
  | AgentModelOperation
 | SessionRestoreOperation
 | RuntimeQueueOperation
 | NativePreferenceOperation
  | RatchetOperation
  | ComputerObservationOperation
  | BrowserObservationOperation
  | StudioIdaOperation
  | SessionOptionsOperation
  | SkillshareOperation
  | LiveAudioOperation
  | MediaOperation
  | BenchmarkOperation
  | RuntimeCatalogOperation
  | JudgmentOperation
  | AnnotationOperation
  | { kind: "accounts.logout"; sessionId: string; accountId: string }
  | { kind: "accounts.status"; refresh?: boolean }
 | { kind: "accounts.status.details"; refresh?: boolean }
  | { kind: "services.list" }
  | { kind: "services.start"; spec: StudioServiceSpec }
  | { kind: "services.stop"; name: string; instanceId: string }
  | { kind: "services.restart"; name: string; instanceId: string }
  | { kind: "services.mode.set"; name: string; instanceId: string; mode: "session" | "persist" | "detached" }
  | { kind: "services.send"; name: string; instanceId: string; text: string }
  | { kind: "services.logs"; name: string; instanceId: string; cursor?: number; lines?: number }
  | { kind: "tokens.count"; text: string }
  | { kind: "runtime.models.describe"; selector: string }
 | { kind: "runtime.models.list"; modelKind?: string; cursor?: string; limit?: number };

export interface WorkbenchResultMap extends SessionTitlesResultMap, PredictionResultMap, MaintenanceResultMap, ArchiveResultMap, AgentModelResultMap, SessionRestoreResultMap, RuntimeQueueResultMap, NativePreferenceResultMap, RatchetResultMap, ComputerObservationResultMap, BrowserObservationResultMap, StudioIdaResultMap, SessionOptionsResultMap, SkillshareResultMap, LiveAudioResultMap, AnnotationResultMap, JudgmentResultMap, RuntimeCatalogResultMap, BenchmarkResultMap, MediaResultMap {
  "accounts.status": AccountStatusResult;
 "accounts.status.details": AccountStatusResult;
  "accounts.logout": { loggedOut: true };
  "services.list": { enabled: boolean; services: StudioServiceRow[] };
  "services.start": { service: StudioServiceRow; readyTimedOut: boolean };
  "services.stop": { service: StudioServiceRow };
  "services.restart": { service: StudioServiceRow };
  "services.mode.set": { service: StudioServiceRow };
  "services.send": { service: StudioServiceRow };
  "services.logs": { instanceId: string; text: string; cursor: number; state: StudioServiceRow["state"] };
  "tokens.count": TokenCountResult;
  "runtime.models.describe": { model: RuntimeModelChoice };
 "runtime.models.list": { models: RuntimeModelChoice[]; total: number; nextCursor?: string };
}
export const WORKBENCH_OPERATION_KINDS = [
...SESSION_TITLES_KINDS,
 ...PREDICTION_KINDS,
...MAINTENANCE_OPERATION_KINDS,
...ARCHIVE_OPERATION_KINDS,
...AGENT_MODEL_KINDS,
...SESSION_RESTORE_KINDS,
...RUNTIME_QUEUE_KINDS,
...NATIVE_PREFERENCE_KINDS,
...RATCHET_OPERATION_KINDS,
...COMPUTER_OBSERVATION_KINDS,
...BROWSER_OBSERVATION_KINDS,
...IDA_OPERATION_KINDS,
...SESSION_OPTIONS_KINDS,...SKILLSHARE_OPERATION_KINDS, ...LIVE_AUDIO_OPERATION_KINDS, ...MEDIA_OPERATION_KINDS, ...BENCHMARK_OPERATION_KINDS, ...RUNTIME_CATALOG_OPERATION_KINDS, ...JUDGMENT_OPERATION_KINDS, ...ANNOTATION_OPERATION_KINDS, "accounts.status", "accounts.status.details", "accounts.logout", "services.list", "services.start", "services.stop", "services.restart", "services.mode.set", "services.send", "services.logs", "tokens.count", "runtime.models.list", "runtime.models.describe"] as const;
export const WORKBENCH_READ_KINDS: readonly WorkbenchOperation["kind"][] = [
"prediction.status","prediction.prepare","prediction.release",
...MAINTENANCE_READ_KINDS,
...ARCHIVE_OPERATION_KINDS,
 "agent.model.inspect",
 "session.restore.inspect",
 "session.queue.get",
"preferences.native.get",
"ratchet.list", "ratchet.read", "ratchet.stop",
"computer.status", "computer.capture", "computer.stop", "computer.observe.release",
"browser.tabs.get", "browser.observe.prepare",
"ida.status", "ida.cancel",
"session.speed.get", "session.warming.get", "models.presets.list","skillshare.status", "skillshare.home", "skillshare.search", "skillshare.package", "skillshare.installed", "skillshare.tokens", "skillshare.action", "live.audio.status", "live.audio.mute", "live.audio.release", "media.models", "media.list", "media.read", "benchmarks.list", "benchmarks.read", ...RUNTIME_CATALOG_OPERATION_KINDS, "judgments.list", "judgments.read", ...ANNOTATION_OPERATION_KINDS, "accounts.status", "accounts.status.details", "services.list", "services.logs", "tokens.count", "runtime.models.list", "runtime.models.describe"];
export function isWorkbenchOperationKind(value: string): value is WorkbenchOperation["kind"] {
  return (WORKBENCH_OPERATION_KINDS as readonly string[]).includes(value);
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a workbench object");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error("Unknown workbench field");
  return row;
}
function text(value: unknown, max = 512, empty = false): void {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || value.length > max) throw new Error("Invalid workbench text");
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid workbench number");
}
function mode(value: unknown): void { if (!["session", "persist", "detached"].includes(value as string)) throw new Error("Invalid service mode"); }
export function validateServiceSpec(value: unknown): asserts value is StudioServiceSpec {
  const spec = record(value, ["name", "command", "cwd", "env", "pty", "ready", "restart", "mode"]);
  text(spec.name, 48); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(spec.name as string)) throw new Error("Invalid service name");
  text(spec.command, 32768);
  if (spec.cwd !== undefined) {
    text(spec.cwd, 4096);
    if (/^(?:[A-Za-z]:|[\\/])/u.test(spec.cwd as string) || (spec.cwd as string).split(/[\\/]/u).includes("..")) throw new Error("Service cwd must be workspace-relative");
  }
  if (spec.env !== undefined) {
    if (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.keys(spec.env).length > 128) throw new Error("Invalid service environment");
    for (const [key, value] of Object.entries(spec.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid environment name");
      text(value, 4096, true);
    }
  }
  if (spec.pty !== undefined && typeof spec.pty !== "boolean") throw new Error("Invalid service PTY option");
  if (spec.ready !== undefined) {
    const ready = record(spec.ready, ["log", "port", "host", "timeoutMs"]);
    if (ready.log === undefined && ready.port === undefined) throw new Error("A readiness condition is required");
    if (ready.log !== undefined) { text(ready.log, 1024); new RegExp(ready.log as string, "u"); }
    if (ready.port !== undefined) integer(ready.port, 1, 65535);
    if (ready.host !== undefined) text(ready.host, 253);
    integer(ready.timeoutMs, 50, 3_600_000);
  }
  if (spec.restart !== undefined && !["no", "on-failure", "always"].includes(spec.restart as string)) throw new Error("Invalid restart policy");
  if (spec.mode !== undefined) mode(spec.mode);
}
export function validateWorkbenchOperation(value: unknown): asserts value is WorkbenchOperation {
  if (!value || typeof value !== "object") throw new Error("Invalid workbench operation");
  const kind = (value as Record<string, unknown>).kind;
  if (typeof kind !== "string" || !isWorkbenchOperationKind(kind)) throw new Error("Unknown workbench operation");
  if (isSessionTitlesKind(kind)) { validateSessionTitlesOperation(value); return; }
 if (isPredictionKind(kind)) { validatePredictionOperation(value); return; }
 if (isMaintenanceKind(kind)) { validateMaintenanceOperation(value); return; }
 if (isArchiveOperationKind(kind)) { validateArchiveOperation(value); return; }
 if (isAgentModelKind(kind)) { validateAgentModelOperation(value); return; }

  if (isSessionRestoreKind(kind)) { validateSessionRestoreOperation(value); return; }

  if (isRuntimeQueueKind(kind)) { validateRuntimeQueueOperation(value); return; }

  if (isNativePreferenceKind(kind)) { validateNativePreferenceOperation(value); return; }
  if (kind === "accounts.logout") { const row = record(value, ["kind", "sessionId", "accountId"]); text(row.sessionId); text(row.accountId); if (!row.sessionId || !/^account-[a-f0-9]{32}$/u.test(String(row.accountId))) throw new Error("Invalid logout target"); return; }
  if (kind === "annotations.capture" || kind === "annotations.prepare") { validateAnnotationOperation(value); return; }
  if (isRatchetKind(kind)) { validateRatchetOperation(value); return; }
  if (isComputerObservationKind(kind)) { validateComputerObservationOperation(value); return; }
  if (isBrowserObservationKind(kind)) { validateBrowserObservationOperation(value); return; }
  if (isIdaOperationKind(kind)) { validateIdaOperation(value); return; }
  if (isSessionOptionsKind(kind)) { validateSessionOptionsOperation(value); return; }
  if (isSkillshareOperationKind(kind)) { validateSkillshareOperation(value); return; }
  if (isLiveAudioOperationKind(kind)) { validateLiveAudioOperation(value); return; }
  if (isMediaOperationKind(kind)) { validateMediaOperation(value); return; }
  if (isBenchmarkOperationKind(kind)) { validateBenchmarkOperation(value); return; }
  if (isRuntimeCatalogOperationKind(kind)) { validateRuntimeCatalogOperation(value); return; }
  if (isJudgmentOperationKind(kind)) { validateJudgmentOperation(value); return; }
  const fields: Record<Exclude<WorkbenchOperation["kind"], SessionTitlesOperation["kind"] | PredictionOperation["kind"] | MaintenanceOperation["kind"] | ArchiveOperation["kind"] | AgentModelOperation["kind"] | SessionRestoreOperation["kind"] | RuntimeQueueOperation["kind"] | NativePreferenceOperation["kind"] | RatchetOperation["kind"] | ComputerObservationOperation["kind"] | BrowserObservationOperation["kind"] | StudioIdaOperation["kind"] | SessionOptionsOperation["kind"] | SkillshareOperation["kind"] | LiveAudioOperation["kind"] | AnnotationOperation["kind"] | JudgmentOperation["kind"] | RuntimeCatalogOperation["kind"] | BenchmarkOperation["kind"] | MediaOperation["kind"]>, readonly string[]> = {
    "accounts.status": ["refresh"],
 "accounts.status.details": ["refresh"],
    "accounts.logout": ["sessionId", "accountId"], "services.list": [], "services.start": ["spec"], "services.stop": ["name", "instanceId"], "services.restart": ["name", "instanceId"],
    "services.mode.set": ["name", "instanceId", "mode"], "services.send": ["name", "instanceId", "text"], "services.logs": ["name", "instanceId", "cursor", "lines"],
    "tokens.count": ["text"], "runtime.models.describe": ["selector"],
 "runtime.models.list": ["modelKind", "cursor", "limit"],
  };
  const input = record(value, ["kind", ...fields[kind]]);
  if ((kind === "accounts.status" || kind === "accounts.status.details") && input.refresh !== undefined && typeof input.refresh !== "boolean") throw new Error("Invalid account refresh flag");
  if (kind === "services.start") validateServiceSpec(input.spec);
  if (fields[kind].includes("name")) { text(input.name, 48); text(input.instanceId); }
  if (kind === "services.mode.set") mode(input.mode);
  if (kind === "services.send") text(input.text, 65536, true);
  if (kind === "tokens.count") text(input.text, 262144, true);
  if (kind === "runtime.models.describe") text(input.selector);
  if (kind === "runtime.models.list" && input.modelKind !== undefined) text(input.modelKind, 32);
  if (input.cursor !== undefined) { if (kind === "runtime.models.list") text(input.cursor); else integer(input.cursor); }
  if (input.limit !== undefined) integer(input.limit, 1, 200);
  if (input.lines !== undefined) integer(input.lines, 1, 1000);
}

function serviceRow(value: unknown): void {
  const row = record(value, ["name", "instanceId", "state", "startedAt", "readyAt", "exitedAt", "exitCode", "restartCount", "outputBytes", "ownerAgentId", "mode"]);
  text(row.name, 48); text(row.instanceId); mode(row.mode);
  if (!["starting", "running", "ready", "restarting", "stopping", "exited", "failed"].includes(row.state as string)) throw new Error("Invalid service state");
  for (const key of ["startedAt", "restartCount", "outputBytes"]) integer(row[key]);
  for (const key of ["readyAt", "exitedAt"]) if (row[key] !== undefined) integer(row[key]);
  if (row.exitCode !== undefined) integer(row.exitCode, -2147483648, 2147483647);
  if (row.ownerAgentId !== undefined) text(row.ownerAgentId);
}
export function validateWorkbenchResult(kind: WorkbenchOperation["kind"], value: unknown): void {
 if (isSessionTitlesKind(kind)) { validateSessionTitlesResult(kind,value); return; }
 if (isPredictionKind(kind)) { validatePredictionResult(kind,value); return; }
 if (isMaintenanceKind(kind)) { validateMaintenanceResult(kind,value); return; }
 if (isArchiveOperationKind(kind)) { validateArchiveResult(kind,value); return; }
 if (isAgentModelKind(kind)) { validateAgentModelResult(kind,value); return; }

 if (isSessionRestoreKind(kind)) { validateSessionRestoreResult(kind,value); return; }

 if (isRuntimeQueueKind(kind)) { validateRuntimeQueueResult(kind,value); return; }

 if (isNativePreferenceKind(kind)) { validateNativePreferenceResult(kind,value); return; }
  if (kind === "accounts.logout") { if (record(value, ["loggedOut"]).loggedOut !== true) throw new Error("Logout did not complete"); return; }
  if (isRatchetKind(kind)) { validateRatchetResult(kind, value); return; }
  if (isComputerObservationKind(kind)) { validateComputerObservationResult(kind, value); return; }
  if (isBrowserObservationKind(kind)) { validateBrowserObservationResult(kind, value); return; }
  if (isIdaOperationKind(kind)) { validateIdaResult(kind, value); return; }
  if (isSessionOptionsKind(kind)) { validateSessionOptionsResult(kind, value); return; }
  if (isSkillshareOperationKind(kind)) { validateSkillshareResult(kind, value); return; }
  if (isLiveAudioOperationKind(kind)) { validateLiveAudioResult(kind, value); return; }
  if (isMediaOperationKind(kind)) { validateMediaResult(kind, value); return; }
  if (isBenchmarkOperationKind(kind)) { validateBenchmarkResult(kind, value); return; }
  if (isRuntimeCatalogOperationKind(kind)) { validateRuntimeCatalogResult(kind, value); return; }
  if (isJudgmentOperationKind(kind)) { validateJudgmentResult(kind, value); return; }
  if (kind === "annotations.capture" || kind === "annotations.prepare") { validateAnnotationResult(kind, value); return; }
  if ((kind === "accounts.status" || kind === "accounts.status.details")) { validateAccountStatus(value); return; }
  if (kind === "runtime.models.describe") { const described = record(value, ["model"]); validateWorkbenchResult("runtime.models.list", { models: [described.model], total: 1 }); return; }
  if (kind === "services.list") {
    const result = record(value, ["enabled", "services"]);
    if (typeof result.enabled !== "boolean" || !Array.isArray(result.services) || result.services.length > 500) throw new Error("Invalid service list");
    result.services.forEach(serviceRow);
  } else if (kind === "services.logs") {
    const result = record(value, ["instanceId", "text", "cursor", "state"]);
    text(result.instanceId); text(result.text, 65536, true); integer(result.cursor); text(result.state, 32);
  } else if (kind.startsWith("services.")) {
    const result = record(value, kind === "services.start" ? ["service", "readyTimedOut"] : ["service"]);
    serviceRow(result.service);
    if (kind === "services.start" && typeof result.readyTimedOut !== "boolean") throw new Error("Invalid readiness result");
  } else if (kind === "tokens.count") {
    const result = record(value, ["bytes", "chars", "lines", "encodings"]);
    for (const key of ["bytes", "chars", "lines"]) integer(result[key]);
    if (!Array.isArray(result.encodings) || result.encodings.length > 64) throw new Error("Invalid encoding list");
    for (const item of result.encodings) { const row = record(item, ["encoding", "tokens"]); text(row.encoding); integer(row.tokens); }
  } else {
    const result = record(value, ["models", "total", "nextCursor"]);
    integer(result.total);
    if (result.nextCursor !== undefined) text(result.nextCursor);
    if (!Array.isArray(result.models) || result.models.length > 200) throw new Error("Invalid model list");
    for (const item of result.models) {
      const row = record(item, ["selector", "name", "provider", "kind", "image", "reasoning", "contextWindow", "maxTokens", "webSearch", "serviceTiers", "promptCache", "promptCacheConfig", "compatibility"]);
      for (const key of ["selector", "name", "provider", "kind"]) text(row[key]);
      if (typeof row.reasoning !== "boolean") throw new Error("Invalid model reasoning capability");
      for (const key of ["contextWindow", "maxTokens"]) if (row[key] !== undefined) integer(row[key]);
      if (typeof row.image !== "boolean") throw new Error("Invalid model image capability");
      if (row.webSearch !== undefined) text(row.webSearch);
      if (row.serviceTiers !== undefined) { if (!Array.isArray(row.serviceTiers) || row.serviceTiers.length > 32) throw new Error("Invalid service tiers"); row.serviceTiers.forEach(value => text(value,128)); }
      for (const field of ["promptCache", "promptCacheConfig"]) if (row[field] !== undefined) { const cache = record(row[field], ["short", "long"]); for (const key of ["short", "long"]) if (cache[key] !== undefined && (typeof cache[key] !== "number" || !Number.isFinite(cache[key]) || (cache[key] as number) < 0)) throw new Error("Invalid prompt cache lifetime"); }
      if (row.compatibility !== undefined) { const compat = record(row.compatibility, ["preferWebsockets", "useResponsesLite", "toolMode"]); for (const field of ["preferWebsockets", "useResponsesLite"]) if (compat[field] !== undefined && typeof compat[field] !== "boolean") throw new Error("Invalid model compatibility flag"); if (compat.toolMode !== undefined && compat.toolMode !== "code_mode_only") throw new Error("Invalid model tool mode"); }

    }
  }
}
