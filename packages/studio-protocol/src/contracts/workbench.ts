import { SEARCH_CREDENTIAL_KINDS, type SearchCredentialsOperation, type SearchCredentialsResultMap } from "./search-credentials.js";
import { EXTENSION_LINK_KINDS, type ExtensionLinkOperation, type ExtensionLinkResultMap } from "./extension-links.js";
import { WEBMCP_KINDS, type WebMcpOperation, type WebMcpResultMap } from "./webmcp.js";
import { EVALUATION_WORKSPACE_KINDS, type EvaluationWorkspaceOperation, type EvaluationWorkspaceResultMap } from "./evaluation-workspace.js";
import { ADVISOR_CONFIG_KINDS, type AdvisorConfigOperation, type AdvisorConfigResultMap } from "./advisor-config.js";
import { LOCAL_RESOURCE_KINDS, type LocalResourceOperation, type LocalResourceResultMap } from "./local-resources.js";
import { DICTATION_KINDS, type DictationOperation, type DictationResultMap } from "./dictation.js";
import { NATIVE_PLAN_REVIEW_KINDS, type NativePlanReviewOperation, type NativePlanReviewResultMap } from "./plan-review.js";
import { SESSION_WORKTREE_KINDS, type SessionWorktreeOperation, type SessionWorktreeResultMap } from "./session-worktrees.js";
import { SESSION_COMPRESSION_KINDS, type SessionCompressionOperation, type SessionCompressionResultMap } from "./session-compression.js";
import { SESSION_PORTABILITY_KINDS, type SessionPortabilityOperation, type SessionPortabilityResultMap } from "./session-portability.js";
import { FEATURE_SETTINGS_KINDS, FEATURE_SETTINGS_READ_KINDS, type FeatureSettingsOperation, type FeatureSettingsResultMap } from "./feature-settings.js";
import { SESSION_TITLES_KINDS, type SessionTitlesOperation, type SessionTitlesResultMap } from "./session-titles.js";
import { PREDICTION_KINDS, type PredictionChannelOperation, type PredictionResultMap } from "./prediction-channel.js";
import { MAINTENANCE_OPERATION_KINDS, MAINTENANCE_READ_KINDS, type MaintenanceOperation, type MaintenanceResultMap } from "./maintenance.js";
import { ARCHIVE_OPERATION_KINDS, type ArchiveOperation, type ArchiveResultMap } from "./archive.js";
import { AGENT_MODEL_KINDS, type AgentModelOperation, type AgentModelResultMap } from "./agent-model.js";
import { SESSION_RESTORE_KINDS, type SessionRestoreOperation, type SessionRestoreResultMap } from "./session-restore.js";
import { RUNTIME_QUEUE_KINDS, type RuntimeQueueOperation, type RuntimeQueueResultMap } from "./runtime-queue.js";
import { NATIVE_PREFERENCE_KINDS, type NativePreferenceOperation, type NativePreferenceResultMap } from "./native-preferences.js";
import { RATCHET_OPERATION_KINDS, type RatchetOperation, type RatchetResultMap } from "./ratchet.js";
import { COMPUTER_WORKSPACE_COMMAND_KINDS, type ComputerWorkspaceCommand, type ComputerWorkspaceResultMap } from "./computer-workspace.js";
import { COMPUTER_OBSERVATION_KINDS, type ComputerObservationOperation, type ComputerObservationResultMap } from "./computer-observation.js";
import { BROWSER_OBSERVATION_KINDS, type BrowserObservationOperation, type BrowserObservationResultMap } from "./browser-observation.js";
import { IDA_OPERATION_KINDS, type StudioIdaOperation, type StudioIdaResultMap } from "./ida-details.js";
import { SESSION_OPTIONS_KINDS, type SessionOptionsOperation, type SessionOptionsResultMap } from "./session-options.js";
import { SESSION_GUI_KINDS, SESSION_GUI_READ_KINDS, type SessionGuiOperation, type SessionGuiResultMap } from "./session-gui.js";
import { SKILLSHARE_OPERATION_KINDS, type SkillshareOperation, type SkillshareResultMap } from "./skillshare.js";
import { LIVE_AUDIO_OPERATION_KINDS, type LiveAudioOperation, type LiveAudioResultMap } from "./live-audio.js";
import { MEDIA_OPERATION_KINDS, type MediaOperation, type MediaResultMap } from "./media.js";
import { BENCHMARK_OPERATION_KINDS, type BenchmarkOperation, type BenchmarkResultMap } from "./benchmarks.js";
import { RUNTIME_CATALOG_OPERATION_KINDS, type RuntimeCatalogOperation, type RuntimeCatalogResultMap } from "./runtime-catalog.js";
import { JUDGMENT_OPERATION_KINDS, type JudgmentOperation, type JudgmentResultMap } from "./judgments.js";
import { RUNTIME_FEATURE_KINDS, RUNTIME_FEATURE_READ_KINDS, type RuntimeFeatureOperation, type RuntimeFeatureResultMap } from "./runtime-features.js";
import { ANNOTATION_OPERATION_KINDS, type AnnotationOperation, type AnnotationResultMap } from "./annotations.js";
import { type AccountStatusResult } from "./accounts.js";
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
  /** Agent-declared canonical HTTP(S) preview URL, when this is a web service. */
  previewUrl?: string;
  pid?: number;
  /** Raw native owner: normally a session ID, or a legacy agent ID. */
  ownerId?: string;
  /** Compatibility alias for ownerId; not necessarily an agent ID. */
  ownerAgentId?: string;
  mode: "session" | "persist" | "detached";
}
export interface RuntimeModelChoice {
  serviceTiers?: string[];
  promptCache?: { short?: number; long?: number };
  promptCacheConfig?: { short?: number; long?: number };
  compatibility?: { supportsMessageThreads?: boolean; toolNamePrefix?: string; statefulResponses?: boolean; preferWebsockets?: boolean; useResponsesLite?: boolean; toolMode?: "code_mode_only" };
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
 | SearchCredentialsOperation
 | ExtensionLinkOperation
 | WebMcpOperation
 | EvaluationWorkspaceOperation
 | AdvisorConfigOperation
 | LocalResourceOperation
 | DictationOperation
 | SessionTitlesOperation
 | PredictionChannelOperation
 | MaintenanceOperation
 | ArchiveOperation
  | AgentModelOperation
 | SessionRestoreOperation
 | RuntimeQueueOperation
 | NativePreferenceOperation
  | FeatureSettingsOperation
  | SessionPortabilityOperation
  | SessionCompressionOperation
  | SessionWorktreeOperation
  | NativePlanReviewOperation
  | RatchetOperation
  | ComputerObservationOperation
  | ComputerWorkspaceCommand
  | BrowserObservationOperation
  | StudioIdaOperation
  | SessionOptionsOperation
 | SessionGuiOperation
  | SkillshareOperation
  | LiveAudioOperation
  | MediaOperation
  | BenchmarkOperation
  | RuntimeCatalogOperation
  | JudgmentOperation
  | AnnotationOperation
  | RuntimeFeatureOperation
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

export interface WorkbenchResultMap extends SearchCredentialsResultMap, ExtensionLinkResultMap, WebMcpResultMap, EvaluationWorkspaceResultMap, AdvisorConfigResultMap, LocalResourceResultMap, DictationResultMap,SessionGuiResultMap, SessionTitlesResultMap, PredictionResultMap, MaintenanceResultMap, ArchiveResultMap, AgentModelResultMap, SessionRestoreResultMap, RuntimeQueueResultMap, NativePreferenceResultMap, FeatureSettingsResultMap, SessionPortabilityResultMap, SessionCompressionResultMap, SessionWorktreeResultMap, NativePlanReviewResultMap, RatchetResultMap, ComputerObservationResultMap, Pick<ComputerWorkspaceResultMap, ComputerWorkspaceCommand["kind"]>, BrowserObservationResultMap, StudioIdaResultMap, SessionOptionsResultMap, SkillshareResultMap, LiveAudioResultMap, AnnotationResultMap, JudgmentResultMap, RuntimeCatalogResultMap, BenchmarkResultMap, MediaResultMap, RuntimeFeatureResultMap {
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
 ...SEARCH_CREDENTIAL_KINDS,
 ...EXTENSION_LINK_KINDS, ...WEBMCP_KINDS,
 ...EVALUATION_WORKSPACE_KINDS,...ADVISOR_CONFIG_KINDS, ...LOCAL_RESOURCE_KINDS,...DICTATION_KINDS,...SESSION_GUI_KINDS,
...SESSION_TITLES_KINDS,
 ...PREDICTION_KINDS,
...MAINTENANCE_OPERATION_KINDS,
...ARCHIVE_OPERATION_KINDS,
...AGENT_MODEL_KINDS,
...SESSION_RESTORE_KINDS,
...RUNTIME_QUEUE_KINDS,
...NATIVE_PREFERENCE_KINDS, ...FEATURE_SETTINGS_KINDS, ...SESSION_PORTABILITY_KINDS, ...SESSION_COMPRESSION_KINDS, ...SESSION_WORKTREE_KINDS, ...NATIVE_PLAN_REVIEW_KINDS,
...RATCHET_OPERATION_KINDS,
...COMPUTER_OBSERVATION_KINDS,
...COMPUTER_WORKSPACE_COMMAND_KINDS,
...BROWSER_OBSERVATION_KINDS,
...IDA_OPERATION_KINDS,
...SESSION_OPTIONS_KINDS,...SKILLSHARE_OPERATION_KINDS, ...LIVE_AUDIO_OPERATION_KINDS, ...MEDIA_OPERATION_KINDS, ...BENCHMARK_OPERATION_KINDS, ...RUNTIME_CATALOG_OPERATION_KINDS, ...JUDGMENT_OPERATION_KINDS, ...ANNOTATION_OPERATION_KINDS, ...RUNTIME_FEATURE_KINDS, "accounts.status", "accounts.status.details", "accounts.logout", "services.list", "services.start", "services.stop", "services.restart", "services.mode.set", "services.send", "services.logs", "tokens.count", "runtime.models.list", "runtime.models.describe"] as const;
export const WORKBENCH_READ_KINDS: readonly WorkbenchOperation["kind"][] = [
 "search.credentials.list",
 "evaluation.runtime.plan", "evaluation.runtime.read", "evaluation.runtime.rows", "evaluation.runtime.report", "evaluation.runtime.patch", "evaluation.runtime.control",...SESSION_GUI_READ_KINDS,
"dictation.inspect",
"prediction.status","prediction.prepare","prediction.release",
...MAINTENANCE_READ_KINDS,
...ARCHIVE_OPERATION_KINDS,
 "agent.model.inspect",
 "session.restore.inspect",
 "session.queue.get", "session.compaction.enqueue", "session.compaction.cancel", "session.compaction.status",
"preferences.native.get", ...FEATURE_SETTINGS_READ_KINDS, "session.portability.status", "maintenance.compression.status", "worktrees.session.list", "worktrees.session.startPolicy", "worktrees.session.resume.list", "mode.plan.review.details",
"ratchet.list", "ratchet.read", "ratchet.stop",
"computer.status", "computer.capture", "computer.stop", "computer.observe.release",
"browser.tabs.get", "browser.observe.prepare", "browser.managed.prepare",
"ida.status.details", "ida.database.cancel",
"session.speed.get", "session.budget.get", "session.warming.get", "models.presets.list","skillshare.status", "skillshare.home", "skillshare.search", "skillshare.package", "skillshare.installed", "skillshare.tokens", "skillshare.action", "live.audio.status", "live.audio.mute", "live.audio.release", "media.models", "media.list", "media.read", "benchmarks.list", "benchmarks.read", ...RUNTIME_CATALOG_OPERATION_KINDS, "judgments.list", "judgments.read", ...ANNOTATION_OPERATION_KINDS, ...RUNTIME_FEATURE_READ_KINDS, "accounts.status", "accounts.status.details", "services.list", "services.logs", "tokens.count", "runtime.models.list", "runtime.models.describe"];
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
