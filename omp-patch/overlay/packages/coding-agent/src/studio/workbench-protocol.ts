import {
	SEARCH_CREDENTIAL_KINDS,
	isSearchCredentialsKind,
	type SearchCredentialsOperation,
	type SearchCredentialsResultMap,
} from "./search-credentials-protocol";
import { EXTENSION_LINK_KINDS, type ExtensionLinkOperation } from "./extension-links-protocol";
import { WEBMCP_KINDS, type WebMcpOperation } from "./webmcp-protocol";
import {
	EVALUATION_WORKSPACE_KINDS,
	isEvaluationWorkspaceKind,
	type EvaluationWorkspaceOperation,
	type EvaluationWorkspaceResultMap,
} from "./evaluation-workspace-protocol";
import {
	ADVISOR_CONFIG_KINDS,
	isAdvisorConfigKind,
	type AdvisorConfigOperation,
	type AdvisorConfigResultMap,
} from "./advisor-config-protocol";
import {
	LOCAL_RESOURCE_KINDS,
	isLocalResourceKind,
	type LocalResourceOperation,
	type LocalResourceResultMap,
} from "./local-resources-protocol";
import {
	DICTATION_KINDS,
	isDictationKind,
	type DictationOperation,
	type DictationResultMap,
} from "./dictation-protocol";
import {
	NATIVE_PLAN_REVIEW_KINDS,
	isNativePlanReviewKind,
	validateNativePlanReviewOperation,
	type NativePlanReviewOperation,
	type NativePlanReviewResultMap,
} from "./plan-review-protocol";
import {
	SESSION_WORKTREE_KINDS,
	isSessionWorktreeKind,
	validateSessionWorktreeOperation,
	type SessionWorktreeOperation,
	type SessionWorktreeResultMap,
} from "./session-worktrees-protocol";
import {
	SESSION_COMPRESSION_KINDS,
	isSessionCompressionKind,
	validateSessionCompressionOperation,
	type SessionCompressionOperation,
	type SessionCompressionResultMap,
} from "./session-compression-protocol";
import {
	SESSION_PORTABILITY_KINDS,
	isSessionPortabilityKind,
	validateSessionPortabilityOperation,
	type SessionPortabilityOperation,
	type SessionPortabilityResultMap,
} from "./session-portability-protocol";
import {
	FEATURE_SETTINGS_KINDS,
	FEATURE_SETTINGS_READ_KINDS,
	isFeatureSettingsKind,
	validateFeatureSettingsOperation,
	type FeatureSettingsOperation,
	type FeatureSettingsResultMap,
} from "./feature-settings-protocol";
import {
	SESSION_TITLES_KINDS,
	isSessionTitlesKind,
	validateSessionTitlesOperation,
	type SessionTitlesOperation,
	type SessionTitlesResultMap,
} from "./session-titles-protocol";
import {
	PREDICTION_KINDS,
	isPredictionKind,
	validatePredictionChannelOperation,
	type PredictionChannelOperation,
	type PredictionResultMap,
} from "./prediction-channel-protocol";
import {
	MAINTENANCE_OPERATION_KINDS,
	MAINTENANCE_READ_KINDS,
	isMaintenanceKind,
	validateMaintenanceOperation,
	type MaintenanceOperation,
	type MaintenanceResultMap,
} from "./maintenance-protocol";
import {
	ARCHIVE_OPERATION_KINDS,
	isArchiveOperationKind,
	validateArchiveOperation,
	type ArchiveOperation,
	type ArchiveResultMap,
} from "./archive-protocol";
import {
	AGENT_MODEL_KINDS,
	isAgentModelKind,
	validateAgentModelOperation,
	type AgentModelOperation,
	type AgentModelResultMap,
} from "./agent-model-protocol";
import {
	SESSION_RESTORE_KINDS,
	isSessionRestoreKind,
	validateSessionRestoreOperation,
	type SessionRestoreOperation,
	type SessionRestoreResultMap,
} from "./session-restore-protocol";
import {
	RUNTIME_QUEUE_KINDS,
	isRuntimeQueueKind,
	validateRuntimeQueueOperation,
	type RuntimeQueueOperation,
	type RuntimeQueueResultMap,
} from "./runtime-queue-protocol";
import {
	NATIVE_PREFERENCE_KINDS,
	isNativePreferenceKind,
	validateNativePreferenceOperation,
	type NativePreferenceOperation,
	type NativePreferenceResultMap,
} from "./native-preferences-protocol";
import {
	RATCHET_OPERATION_KINDS,
	isRatchetKind,
	validateRatchetOperation,
	type RatchetOperation,
	type RatchetResultMap,
} from "./ratchet-protocol";
import {
	COMPUTER_WORKSPACE_COMMAND_KINDS,
	isComputerWorkspaceCommand,
	type ComputerWorkspaceCommand,
	type ComputerWorkspaceResultMap,
} from "./computer-workspace-protocol";
import {
	COMPUTER_OBSERVATION_KINDS,
	isComputerObservationKind,
	validateComputerObservationOperation,
	type ComputerObservationOperation,
	type ComputerObservationResultMap,
} from "./computer-observation-protocol";
import {
	BROWSER_OBSERVATION_KINDS,
	isBrowserObservationKind,
	validateBrowserObservationOperation,
	type BrowserObservationOperation,
	type BrowserObservationResultMap,
} from "./browser-observation-protocol";
import {
	IDA_OPERATION_KINDS,
	isIdaOperationKind,
	validateStudioIdaOperation,
	type StudioIdaOperation,
	type StudioIdaResultMap,
} from "./ida-details-protocol";
import {
	SESSION_OPTIONS_KINDS,
	isSessionOptionsKind,
	validateSessionOptionsOperation,
	type SessionOptionsOperation,
	type SessionOptionsResultMap,
} from "./session-options-protocol";
import {
	SESSION_GUI_KINDS,
	SESSION_GUI_READ_KINDS,
	isSessionGuiKind,
	validateSessionGuiOperation,
	type SessionGuiOperation,
	type SessionGuiResultMap,
} from "./session-gui-protocol";
import {
	SKILLSHARE_OPERATION_KINDS,
	isSkillshareOperationKind,
	validateSkillshareOperation,
	type SkillshareOperation,
	type SkillshareResultMap,
} from "./skillshare-protocol";
import {
	LIVE_AUDIO_OPERATION_KINDS,
	isLiveAudioOperationKind,
	validateLiveAudioOperation,
	type LiveAudioOperation,
	type LiveAudioResultMap,
} from "./live-audio-protocol";
import {
	MEDIA_OPERATION_KINDS,
	isMediaOperationKind,
	validateMediaOperation,
	type MediaOperation,
	type MediaResultMap,
} from "./media-protocol";
import {
	BENCHMARK_OPERATION_KINDS,
	isBenchmarkOperationKind,
	validateBenchmarkOperation,
	type BenchmarkOperation,
	type BenchmarkResultMap,
} from "./benchmarks-protocol";
import {
	RUNTIME_CATALOG_OPERATION_KINDS,
	isRuntimeCatalogOperationKind,
	validateRuntimeCatalogOperation,
	type RuntimeCatalogOperation,
	type RuntimeCatalogResultMap,
} from "./runtime-catalog-protocol";
import {
	JUDGMENT_OPERATION_KINDS,
	isJudgmentOperationKind,
	validateJudgmentOperation,
	type JudgmentOperation,
	type JudgmentResultMap,
} from "./judgments-protocol";
import {
	RUNTIME_FEATURE_KINDS,
	RUNTIME_FEATURE_READ_KINDS,
	isRuntimeFeatureKind,
	validateRuntimeFeatureOperation,
	type RuntimeFeatureOperation,
	type RuntimeFeatureResultMap,
} from "./runtime-features-protocol";
import {
	ANNOTATION_OPERATION_KINDS,
	validateAnnotationOperation,
	type AnnotationOperation,
	type AnnotationResultMap,
} from "./annotations-protocol";
import { type AccountStatusResult } from "./accounts-protocol";
/** Shared, presentation-neutral tools added with OMP 18.3.0. */
export interface StudioServiceSpec {
	name: string;
	command: string;
	cwd?: string | undefined;
	env?: Record<string, string> | undefined;
	pty?: boolean | undefined;
	ready?:
		| { log?: string | undefined; port?: number | undefined; host?: string | undefined; timeoutMs: number }
		| undefined;
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
	compatibility?: {
		supportsMessageThreads?: boolean;
		toolNamePrefix?: string;
		statefulResponses?: boolean;
		preferWebsockets?: boolean;
		useResponsesLite?: boolean;
		toolMode?: "code_mode_only";
	};
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
	| RuntimeFeatureOperation
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

export interface WorkbenchResultMap
	extends
		SearchCredentialsResultMap,
		EvaluationWorkspaceResultMap,
		SessionTitlesResultMap,
		PredictionResultMap,
		MaintenanceResultMap,
		ArchiveResultMap,
		AgentModelResultMap,
		SessionRestoreResultMap,
		RuntimeQueueResultMap,
		NativePreferenceResultMap,
		FeatureSettingsResultMap,
		SessionPortabilityResultMap,
		SessionCompressionResultMap,
		SessionWorktreeResultMap,
		NativePlanReviewResultMap,
		RatchetResultMap,
		ComputerObservationResultMap,
		Pick<ComputerWorkspaceResultMap, ComputerWorkspaceCommand["kind"]>,
		BrowserObservationResultMap,
		StudioIdaResultMap,
		SessionOptionsResultMap,
		AdvisorConfigResultMap,
		LocalResourceResultMap,
		DictationResultMap,
		SessionGuiResultMap,
		SkillshareResultMap,
		LiveAudioResultMap,
		AnnotationResultMap,
		JudgmentResultMap,
		RuntimeCatalogResultMap,
		BenchmarkResultMap,
		MediaResultMap,
		RuntimeFeatureResultMap {
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
	...EXTENSION_LINK_KINDS,
	...WEBMCP_KINDS,
	...EVALUATION_WORKSPACE_KINDS,
	...ADVISOR_CONFIG_KINDS,
	...LOCAL_RESOURCE_KINDS,
	...DICTATION_KINDS,
	...SESSION_TITLES_KINDS,
	...PREDICTION_KINDS,
	...MAINTENANCE_OPERATION_KINDS,
	...ARCHIVE_OPERATION_KINDS,
	...AGENT_MODEL_KINDS,
	...SESSION_RESTORE_KINDS,
	...RUNTIME_QUEUE_KINDS,
	...NATIVE_PREFERENCE_KINDS,
	...FEATURE_SETTINGS_KINDS,
	...SESSION_PORTABILITY_KINDS,
	...SESSION_COMPRESSION_KINDS,
	...SESSION_WORKTREE_KINDS,
	...NATIVE_PLAN_REVIEW_KINDS,
	...RATCHET_OPERATION_KINDS,
	...COMPUTER_OBSERVATION_KINDS,
	...COMPUTER_WORKSPACE_COMMAND_KINDS,
	...BROWSER_OBSERVATION_KINDS,
	...IDA_OPERATION_KINDS,
	...SESSION_OPTIONS_KINDS,
	...SESSION_GUI_KINDS,
	...SKILLSHARE_OPERATION_KINDS,
	...LIVE_AUDIO_OPERATION_KINDS,
	...MEDIA_OPERATION_KINDS,
	...BENCHMARK_OPERATION_KINDS,
	...RUNTIME_CATALOG_OPERATION_KINDS,
	...JUDGMENT_OPERATION_KINDS,
	...RUNTIME_FEATURE_KINDS,
	...ANNOTATION_OPERATION_KINDS,
	"accounts.status",
	"accounts.status.details",
	"accounts.logout",
	"services.list",
	"services.start",
	"services.stop",
	"services.restart",
	"services.mode.set",
	"services.send",
	"services.logs",
	"tokens.count",
	"runtime.models.list",
	"runtime.models.describe",
] as const;
export const WORKBENCH_READ_KINDS: readonly WorkbenchOperation["kind"][] = [
	"search.credentials.list",
	...COMPUTER_WORKSPACE_COMMAND_KINDS,
	"evaluation.runtime.plan",
	"evaluation.runtime.read",
	"evaluation.runtime.rows",
	"evaluation.runtime.report",
	"evaluation.runtime.patch",
	"evaluation.runtime.control",
	"prediction.status",
	"dictation.inspect",
	"dictation.status",
	"dictation.cancel",
	"prediction.prepare",
	"prediction.release",
	...MAINTENANCE_READ_KINDS,
	...ARCHIVE_OPERATION_KINDS,
	"agent.model.inspect",
	"session.restore.inspect",
	"session.queue.get",
	"session.compaction.enqueue",
	"session.compaction.cancel",
	"session.compaction.status",
	"preferences.native.get",
	...FEATURE_SETTINGS_READ_KINDS,
	"session.portability.status",
	"maintenance.compression.status",
	"worktrees.session.list",
	"worktrees.session.startPolicy",
	"worktrees.session.resume.list",
	"mode.plan.review.details",
	"ratchet.list",
	"ratchet.read",
	"ratchet.stop",
	"computer.status",
	"computer.capture",
	"computer.stop",
	"computer.observe.release",
	"browser.tabs.get",
	"browser.observe.prepare",
	"browser.managed.prepare",
	"ida.status.details",
	"ida.database.cancel",
	"session.speed.get",
	"session.budget.get",
	"session.warming.get",
	"models.presets.list",
	...SESSION_GUI_READ_KINDS,
	"skillshare.status",
	"skillshare.home",
	"skillshare.search",
	"skillshare.package",
	"skillshare.installed",
	"skillshare.tokens",
	"skillshare.action",
	"live.audio.status",
	"live.audio.mute",
	"live.audio.release",
	"media.models",
	"media.list",
	"media.read",
	"benchmarks.list",
	"benchmarks.read",
	...RUNTIME_CATALOG_OPERATION_KINDS,
	"judgments.list",
	"judgments.read",
	...RUNTIME_FEATURE_READ_KINDS,
	...ANNOTATION_OPERATION_KINDS,
	"accounts.status",
	"accounts.status.details",
	"services.list",
	"services.logs",
	"tokens.count",
	"runtime.models.list",
	"runtime.models.describe",
];
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
	if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || value.length > max)
		throw new Error("Invalid workbench text");
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): void {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
		throw new Error("Invalid workbench number");
}
function mode(value: unknown): void {
	if (!["session", "persist", "detached"].includes(value as string)) throw new Error("Invalid service mode");
}
export function validateServiceSpec(value: unknown): asserts value is StudioServiceSpec {
	const spec = record(value, ["name", "command", "cwd", "env", "pty", "ready", "restart", "mode"]);
	text(spec.name, 48);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u.test(spec.name as string)) throw new Error("Invalid service name");
	text(spec.command, 32768);
	if (spec.cwd !== undefined) {
		text(spec.cwd, 4096);
		if (/^(?:[A-Za-z]:|[\\/])/u.test(spec.cwd as string) || (spec.cwd as string).split(/[\\/]/u).includes(".."))
			throw new Error("Service cwd must be workspace-relative");
	}
	if (spec.env !== undefined) {
		if (!spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.keys(spec.env).length > 128)
			throw new Error("Invalid service environment");
		for (const [key, value] of Object.entries(spec.env)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || ["__proto__", "constructor", "prototype"].includes(key))
				throw new Error("Invalid environment name");
			text(value, 4096, true);
		}
	}
	if (spec.pty !== undefined && typeof spec.pty !== "boolean") throw new Error("Invalid service PTY option");
	if (spec.ready !== undefined) {
		const ready = record(spec.ready, ["log", "port", "host", "timeoutMs"]);
		if (ready.log === undefined && ready.port === undefined) throw new Error("A readiness condition is required");
		if (ready.log !== undefined) {
			text(ready.log, 1024);
			new RegExp(ready.log as string, "u");
		}
		if (ready.port !== undefined) integer(ready.port, 1, 65535);
		if (ready.host !== undefined) text(ready.host, 253);
		integer(ready.timeoutMs, 50, 3_600_000);
	}
	if (spec.restart !== undefined && !["no", "on-failure", "always"].includes(spec.restart as string))
		throw new Error("Invalid restart policy");
	if (spec.mode !== undefined) mode(spec.mode);
}
export function validateWorkbenchOperation(value: unknown): asserts value is WorkbenchOperation {
	if (!value || typeof value !== "object") throw new Error("Invalid workbench operation");
	const kind = (value as Record<string, unknown>).kind;
	if (typeof kind !== "string" || !isWorkbenchOperationKind(kind)) throw new Error("Unknown workbench operation");
	if (isSearchCredentialsKind(kind)) return;
	if (kind === "extensions.links.activate" || kind === "browser.webmcp.invoke") return;
	if (isComputerWorkspaceCommand(kind)) return;
	if (isEvaluationWorkspaceKind(kind)) return;
	if (isAdvisorConfigKind(kind) || isLocalResourceKind(kind) || isDictationKind(kind)) return;
	if (isSessionTitlesKind(kind)) {
		validateSessionTitlesOperation(value);
		return;
	}
	if (isPredictionKind(kind)) {
		validatePredictionChannelOperation(value);
		return;
	}
	if (isMaintenanceKind(kind)) {
		validateMaintenanceOperation(value);
		return;
	}
	if (isArchiveOperationKind(kind)) {
		validateArchiveOperation(value);
		return;
	}
	if (isAgentModelKind(kind)) {
		validateAgentModelOperation(value);
		return;
	}

	if (isSessionRestoreKind(kind)) {
		validateSessionRestoreOperation(value);
		return;
	}

	if (isRuntimeQueueKind(kind)) {
		validateRuntimeQueueOperation(value);
		return;
	}

	if (isNativePlanReviewKind(kind)) {
		validateNativePlanReviewOperation(value);
		return;
	}
	if (isSessionWorktreeKind(kind)) {
		validateSessionWorktreeOperation(value);
		return;
	}
	if (isSessionCompressionKind(kind)) {
		validateSessionCompressionOperation(value);
		return;
	}
	if (isSessionPortabilityKind(kind)) {
		validateSessionPortabilityOperation(value);
		return;
	}
	if (isFeatureSettingsKind(kind)) {
		validateFeatureSettingsOperation(value);
		return;
	}
	if (isNativePreferenceKind(kind)) {
		validateNativePreferenceOperation(value);
		return;
	}
	if (kind === "accounts.logout") {
		const row = record(value, ["kind", "sessionId", "accountId"]);
		text(row.sessionId);
		text(row.accountId);
		if (!row.sessionId || !/^account-[a-f0-9]{32}$/u.test(String(row.accountId)))
			throw new Error("Invalid logout target");
		return;
	}
	if (kind === "annotations.capture" || kind === "annotations.prepare") {
		validateAnnotationOperation(value);
		return;
	}
	if (isRatchetKind(kind)) {
		validateRatchetOperation(value);
		return;
	}
	if (isComputerObservationKind(kind)) {
		validateComputerObservationOperation(value);
		return;
	}
	if (isBrowserObservationKind(kind)) {
		validateBrowserObservationOperation(value);
		return;
	}
	if (isIdaOperationKind(kind)) {
		validateStudioIdaOperation(value);
		return;
	}
	if (isSessionOptionsKind(kind)) {
		validateSessionOptionsOperation(value);
		return;
	}
	if (isSessionGuiKind(kind)) {
		validateSessionGuiOperation(value);
		return;
	}
	if (isSkillshareOperationKind(kind)) {
		validateSkillshareOperation(value);
		return;
	}
	if (isLiveAudioOperationKind(kind)) {
		validateLiveAudioOperation(value);
		return;
	}
	if (isMediaOperationKind(kind)) {
		validateMediaOperation(value);
		return;
	}
	if (isBenchmarkOperationKind(kind)) {
		validateBenchmarkOperation(value);
		return;
	}
	if (isRuntimeCatalogOperationKind(kind)) {
		validateRuntimeCatalogOperation(value);
		return;
	}
	if (isJudgmentOperationKind(kind)) {
		validateJudgmentOperation(value);
		return;
	}
	if (isRuntimeFeatureKind(kind)) {
		validateRuntimeFeatureOperation(value);
		return;
	}
	const fields: Record<
		Exclude<
			WorkbenchOperation["kind"],
			| SearchCredentialsOperation["kind"]
			| ExtensionLinkOperation["kind"]
			| WebMcpOperation["kind"]
			| EvaluationWorkspaceOperation["kind"]
			| AdvisorConfigOperation["kind"]
			| LocalResourceOperation["kind"]
			| DictationOperation["kind"]
			| SessionTitlesOperation["kind"]
			| PredictionChannelOperation["kind"]
			| MaintenanceOperation["kind"]
			| ArchiveOperation["kind"]
			| AgentModelOperation["kind"]
			| SessionRestoreOperation["kind"]
			| RuntimeQueueOperation["kind"]
			| NativePreferenceOperation["kind"]
			| FeatureSettingsOperation["kind"]
			| SessionPortabilityOperation["kind"]
			| SessionCompressionOperation["kind"]
			| SessionWorktreeOperation["kind"]
			| NativePlanReviewOperation["kind"]
			| RatchetOperation["kind"]
			| ComputerObservationOperation["kind"]
			| ComputerWorkspaceCommand["kind"]
			| BrowserObservationOperation["kind"]
			| StudioIdaOperation["kind"]
			| SessionOptionsOperation["kind"]
			| SessionGuiOperation["kind"]
			| SkillshareOperation["kind"]
			| LiveAudioOperation["kind"]
			| AnnotationOperation["kind"]
			| JudgmentOperation["kind"]
			| RuntimeFeatureOperation["kind"]
			| RuntimeCatalogOperation["kind"]
			| BenchmarkOperation["kind"]
			| MediaOperation["kind"]
		>,
		readonly string[]
	> = {
		"accounts.status": ["refresh"],
		"accounts.status.details": ["refresh"],
		"accounts.logout": ["sessionId", "accountId"],
		"services.list": [],
		"services.start": ["spec"],
		"services.stop": ["name", "instanceId"],
		"services.restart": ["name", "instanceId"],
		"services.mode.set": ["name", "instanceId", "mode"],
		"services.send": ["name", "instanceId", "text"],
		"services.logs": ["name", "instanceId", "cursor", "lines"],
		"tokens.count": ["text"],
		"runtime.models.describe": ["selector"],
		"runtime.models.list": ["modelKind", "cursor", "limit"],
	};
	const input = record(value, ["kind", ...fields[kind]]);
	if (
		(kind === "accounts.status" || kind === "accounts.status.details") &&
		input.refresh !== undefined &&
		typeof input.refresh !== "boolean"
	)
		throw new Error("Invalid account refresh flag");
	if (kind === "services.start") validateServiceSpec(input.spec);
	if (fields[kind].includes("name")) {
		text(input.name, 48);
		text(input.instanceId);
	}
	if (kind === "services.mode.set") mode(input.mode);
	if (kind === "services.send") text(input.text, 65536, true);
	if (kind === "tokens.count") text(input.text, 262144, true);
	if (kind === "runtime.models.describe") text(input.selector);
	if (kind === "runtime.models.list" && input.modelKind !== undefined) text(input.modelKind, 32);
	if (input.cursor !== undefined) {
		if (kind === "runtime.models.list") text(input.cursor);
		else integer(input.cursor);
	}
	if (input.limit !== undefined) integer(input.limit, 1, 200);
	if (input.lines !== undefined) integer(input.lines, 1, 1000);
}
