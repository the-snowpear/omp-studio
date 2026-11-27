import { StudioChromeRelayHostService } from "./chrome-relay-host-service";
import { isChromeRelayHostKind, type ChromeRelayHostOperation } from "../chrome-relay-host-protocol";
import { isMcpAuthKind, type McpAuthOperation } from "../mcp-auth-protocol";
import { StudioTodoBackendService } from "./todo-backend-service";
import { isTodoBackendKind, type TodoBackendOperation } from "../todo-backend-protocol";
import { StudioSearchCredentialsService } from "./search-credentials-service";
import { inspectStudioAntigravity } from "./antigravity-readiness";
import { StudioCommitService } from "./commit-service";
import { StudioPromptHistoryService } from "./prompt-history-service";
import { StudioModelSystemTemplatesService } from "./model-system-templates-service";
import { StudioModelAuthService } from "./model-auth-service";
import { StudioModelRosterService } from "./model-roster-service";
import type { ModelServicesOperation } from "../model-services-protocol";
import { StudioQueuedCompactionService } from "./queued-compaction-service";
import { StudioRuntimeViews } from "./runtime-view-service";
import type { MCPManager } from "../../mcp/manager";
import { StudioEvaluationWorkspaceService } from "./evaluation-workspace-service";
import { isEvaluationWorkspaceKind, type EvaluationWorkspaceOperation } from "../evaluation-workspace-protocol";
import { StudioAdvisorConfigService } from "./advisor-config-service";
import { isAdvisorConfigKind, type AdvisorConfigOperation } from "../advisor-config-protocol";
import { isLocalResourceKind, type LocalResourceOperation } from "../local-resources-protocol";
import { isDictationKind, type DictationOperation } from "../dictation-protocol";
import { StudioContextViewService } from "./context-view-service";
import type { StudioModeControlService } from "./mode-control-service";
import { isNativePlanReviewKind, type NativePlanReviewOperation } from "../plan-review-protocol";
import { StudioSessionWorktreesService } from "./session-worktrees-service";
import { isSessionWorktreeKind, type SessionWorktreeOperation } from "../session-worktrees-protocol";
import { StudioSessionCompressionService } from "./session-compression-service";
import { isSessionCompressionKind, type SessionCompressionOperation } from "../session-compression-protocol";
import { StudioSessionPortabilityService } from "./session-portability-service";
import { isSessionPortabilityKind, type SessionPortabilityOperation } from "../session-portability-protocol";
import { StudioFeatureSettingsService } from "./feature-settings-service";
import { isFeatureSettingsKind, type FeatureSettingsOperation } from "../feature-settings-protocol";
import { StudioDisassemblerService } from "./disassembler-service";
import { StudioSessionTitlesService } from "./session-titles-service";
import { isSessionTitlesKind, type SessionTitlesOperation } from "../session-titles-protocol";
import { StudioPredictionService } from "./prediction-service";
import { isPredictionKind, type PredictionChannelOperation } from "../prediction-channel-protocol";
import { StudioMaintenanceService } from "./maintenance-service";
import { isMaintenanceKind, type MaintenanceOperation } from "../maintenance-protocol";
import { StudioArchiveService } from "./archive-service";
import { isArchiveOperationKind, type ArchiveOperation } from "../archive-protocol";
import { StudioAgentModelService } from "./agent-model-service";
import type { Model } from "@oh-my-pi/pi-ai";
import type { RuntimeModelChoice } from "../workbench-protocol";
import { StudioSessionRestoreService } from "./session-restore-service";
import { StudioRuntimeQueueService } from "./runtime-queue-service";
import { isRuntimeQueueKind, type RuntimeQueueOperation } from "../runtime-queue-protocol";
import { StudioNativePreferencesService } from "./native-preferences-service";
import { isNativePreferenceKind, type NativePreferenceOperation } from "../native-preferences-protocol";
import { StudioRatchetService } from "./ratchet-service";
import { isRatchetKind, type RatchetOperation } from "../ratchet-protocol";
import { cfgLaunchEnabled } from "../../tools/settings";
import { StudioSessionGuiService } from "./session-gui-service";
import { StudioAgentBtwService } from "./agent-btw-service";
import { StudioResourceService } from "./resource-service";
import { StudioSkillshareService } from "./skillshare-service";
import { StudioLiveAudioService } from "./live-audio-service";
import { StudioMediaService } from "./media-service";
import { StudioBenchmarkService } from "./benchmark-service";
import { StudioRuntimeCatalogService } from "./runtime-catalog-service";
import { StudioJudgmentService } from "./judgment-service";
import { StudioRuntimeFeatureService } from "./runtime-feature-service";
import { StudioSessionOptionsService } from "./session-options-service";
import { StudioBrowserObservationService } from "./browser-observation-service";
import { StudioManagedBrowserService } from "./managed-browser-service";
import { activateStudioExtensionLink } from "./extension-links-service";
import { StudioComputerObservationService } from "./computer-observation-service";
import { StudioComputerWorkspaceService } from "./computer-workspace-service";
import { isComputerWorkspaceCommand, type ComputerWorkspaceCommand } from "../computer-workspace-protocol";
import { isComputerObservationKind, type ComputerObservationOperation } from "../computer-observation-protocol";
import { isBrowserObservationKind, type BrowserObservationOperation } from "../browser-observation-protocol";
import { isDisassemblerKind, type DisassemblerOperation } from "../disassembler-protocol";
import { isSessionOptionsKind, type SessionOptionsOperation } from "../session-options-protocol";
import { type JudgmentOperation } from "../judgments-protocol";
import { isRuntimeFeatureKind, type RuntimeFeatureOperation } from "../runtime-features-protocol";

function isChromeRelayHostOperation(
	operation: WorkbenchOperation,
): operation is Exclude<ChromeRelayHostOperation, { kind: "browser.relayHost.status" }> {
	return isChromeRelayHostKind(operation.kind);
}

function isMcpAuthOperation(operation: WorkbenchOperation): operation is McpAuthOperation {
	return isMcpAuthKind(operation.kind);
}

function isTodoBackendOperation(operation: WorkbenchOperation): operation is TodoBackendOperation {
	return isTodoBackendKind(operation.kind);
}

function isAgentModelOperation(operation: WorkbenchOperation): operation is AgentModelOperation {
	return isAgentModelKind(operation.kind);
}

function isRuntimeFeatureOperation(operation: { kind: string }): operation is RuntimeFeatureOperation {
	return isRuntimeFeatureKind(operation.kind);
}
import { StudioAnnotationService } from "./annotation-service";
import { StudioAccountStatusService } from "./account-status-service";
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { Encoding, countTokens, killProcessFamily } from "@oh-my-pi/pi-natives";
import type { UnitSnapshot } from "../../daemon/protocol";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { heldShellProcesses } from "../../exec/bash-executor";
import { killLeftoverProcesses, listLeftoverProcesses, type LeftoverProcess } from "../../exec/session-processes";
import { cfgBashReapBackground } from "../../exec/settings";
import { adoptService, listServices, modeService, requestService, startService } from "../../launch/services";
import type { AgentSession } from "../../session/agent-session";
import type { ToolSession } from "../../tools";
import { isAgentModelKind, type AgentModelOperation } from "../agent-model-protocol";
import type { StudioLeftoverProcess, StudioServiceRow, WorkbenchOperation } from "../workbench-protocol";
import { SessionControlError } from "./session-control-service";

function isAdvisorConfigOperation(operation: WorkbenchOperation): operation is AdvisorConfigOperation {
	return isAdvisorConfigKind(operation.kind);
}
function isLocalResourceOperation(operation: WorkbenchOperation): operation is LocalResourceOperation {
	return isLocalResourceKind(operation.kind);
}
function isDictationOperation(operation: WorkbenchOperation): operation is DictationOperation {
	return isDictationKind(operation.kind);
}

function isSessionTitlesOperation(operation: WorkbenchOperation): operation is SessionTitlesOperation {
	return isSessionTitlesKind(operation.kind);
}
function isPredictionChannelOperation(operation: WorkbenchOperation): operation is PredictionChannelOperation {
	return isPredictionKind(operation.kind);
}
function isMaintenanceOperation(operation: WorkbenchOperation): operation is MaintenanceOperation {
	return isMaintenanceKind(operation.kind);
}
function isArchiveOperation(operation: WorkbenchOperation): operation is ArchiveOperation {
	return isArchiveOperationKind(operation.kind);
}
function isDisassemblerOperation(operation: WorkbenchOperation): operation is DisassemblerOperation {
	return isDisassemblerKind(operation.kind);
}
function isSessionOptionsOperation(operation: WorkbenchOperation): operation is SessionOptionsOperation {
	return isSessionOptionsKind(operation.kind);
}
function isBrowserObservationOperation(operation: WorkbenchOperation): operation is BrowserObservationOperation {
	return isBrowserObservationKind(operation.kind);
}
function isComputerWorkspaceOperation(operation: WorkbenchOperation): operation is ComputerWorkspaceCommand {
	return isComputerWorkspaceCommand(operation.kind);
}
function isComputerObservationOperation(operation: WorkbenchOperation): operation is ComputerObservationOperation {
	return isComputerObservationKind(operation.kind);
}

function isEvaluationWorkspaceOperation(operation: WorkbenchOperation): operation is EvaluationWorkspaceOperation {
	return isEvaluationWorkspaceKind(operation.kind);
}

function isRatchetOperation(operation: WorkbenchOperation): operation is RatchetOperation {
	return isRatchetKind(operation.kind);
}

function isNativePreferenceOperation(operation: WorkbenchOperation): operation is NativePreferenceOperation {
	return isNativePreferenceKind(operation.kind);
}
export function projectService(daemon: UnitSnapshot, sessionId?: string): StudioServiceRow {
	return {
		name: daemon.key,
		scope:
			daemon.scope.kind === "project" && daemon.owner === sessionId && sessionId !== undefined
				? "session"
				: daemon.scope.kind,
		instanceId: daemon.id + ":" + daemon.generation,
		state: daemon.state,
		startedAt: daemon.startedAt,
		previewUrl: daemon.previewUrl,
		pid: daemon.pids[0],
		readyAt: daemon.readyAt,
		exitedAt: daemon.exitedAt,
		exitCode: daemon.exitCode,
		restartCount: daemon.restartCount,
		outputBytes: daemon.outputBytes,
		...(daemon.owner === undefined ? {} : { ownerId: daemon.owner, ownerAgentId: daemon.owner }),
		mode:
			daemon.policy.survive === "detached" ? "detached" : daemon.policy.hold === "persist" ? "persist" : "session",
		manageable: daemon.kind === "proc" && daemon.scope.kind !== "global",
		...(daemon.adopted === undefined ? {} : { adopted: daemon.adopted }),
	};
}

export function projectLeftoverProcess(proc: LeftoverProcess): StudioLeftoverProcess {
	const cwd = (proc as LeftoverProcess & { cwd?: string }).cwd;
	return {
		pid: proc.pid,
		command: sanitizeText(proc.command).slice(0, 4096),
		kind: proc.kind,
		ignoresSighup: proc.kind === "nohup",
		startedAt: proc.startedAt,
		...(typeof cwd === "string" && cwd.trim().length > 0 ? { cwd } : {}),
	};
}

/** Uses the current worker's native ToolSession and its lifecycle/owner subscriptions. */
export class StudioWorkbenchService {
	readonly advisorConfig: StudioAdvisorConfigService;
	readonly contextView: StudioContextViewService;
	readonly titles: StudioSessionTitlesService;
	readonly prediction: StudioPredictionService;
	readonly maintenance: StudioMaintenanceService;
	readonly archive: StudioArchiveService;
	readonly agentModels: StudioAgentModelService;
	readonly sessionRestore: StudioSessionRestoreService;
	readonly runtimeQueue: StudioRuntimeQueueService;
	readonly queuedCompaction: StudioQueuedCompactionService;
	readonly nativePreferences: StudioNativePreferencesService;
	readonly featureSettings: StudioFeatureSettingsService;
	readonly portability: StudioSessionPortabilityService;
	readonly compression: StudioSessionCompressionService;
	readonly worktrees: StudioSessionWorktreesService;
	planControl: StudioModeControlService | undefined;
	readonly evaluations: StudioEvaluationWorkspaceService;
	readonly ratchet: StudioRatchetService;
	readonly resources: StudioResourceService;
	readonly agentBtw: StudioAgentBtwService;
	readonly sessionGui: StudioSessionGuiService;
	readonly skillshare: StudioSkillshareService;
	readonly media: StudioMediaService;
	readonly benchmarks: StudioBenchmarkService;
	readonly modelSystemTemplates: StudioModelSystemTemplatesService;
	readonly modelAuth: StudioModelAuthService;
	readonly modelRoster: StudioModelRosterService;
	readonly promptHistory: StudioPromptHistoryService;
	#commit: StudioCommitService | undefined;
	readonly views: StudioRuntimeViews;
	readonly catalog: StudioRuntimeCatalogService;
	readonly judgments: StudioJudgmentService;
	readonly runtimeFeatures: StudioRuntimeFeatureService;
	readonly accounts: StudioAccountStatusService;
	readonly annotations: StudioAnnotationService;
	readonly sessionOptions: StudioSessionOptionsService;
	readonly disassembler: StudioDisassemblerService;
	readonly browserObservation: StudioBrowserObservationService;
	readonly managedBrowser: StudioManagedBrowserService;
	readonly relayHost: StudioChromeRelayHostService;
	readonly todoBackend: StudioTodoBackendService;
	readonly computerObservation: StudioComputerObservationService;
	readonly computerWorkspace: StudioComputerWorkspaceService;
	constructor(
		readonly session: AgentSession,
		readonly liveAudio = new StudioLiveAudioService(session),
		mcpManager?: MCPManager,
		readonly runtimeEpoch: () => number = () => 0,
	) {
		this.advisorConfig = new StudioAdvisorConfigService(session);
		this.contextView = new StudioContextViewService(session);
		this.titles = new StudioSessionTitlesService(session);
		this.prediction = new StudioPredictionService(session);
		if (typeof session.runEphemeralTurn === "function") this.prediction.enableMessagePrediction(session);
		this.maintenance = new StudioMaintenanceService(session);
		this.archive = new StudioArchiveService(session);
		this.agentModels = new StudioAgentModelService(session);
		this.sessionRestore = new StudioSessionRestoreService(session);
		this.queuedCompaction = new StudioQueuedCompactionService(session);
		this.runtimeQueue = new StudioRuntimeQueueService(session, this.queuedCompaction);
		this.nativePreferences = new StudioNativePreferencesService(session);
		this.computerWorkspace = new StudioComputerWorkspaceService(session);
		this.featureSettings = new StudioFeatureSettingsService(session, this.computerWorkspace);
		this.portability = new StudioSessionPortabilityService(session);
		this.compression = new StudioSessionCompressionService(session);
		this.worktrees = new StudioSessionWorktreesService(session);
		this.ratchet = new StudioRatchetService(session);
		this.evaluations = new StudioEvaluationWorkspaceService(session);
		this.skillshare = new StudioSkillshareService(session);
		this.sessionGui = new StudioSessionGuiService(session);
		this.agentBtw = new StudioAgentBtwService(session);
		this.resources = new StudioResourceService(session);
		this.accounts = new StudioAccountStatusService(session);
		this.judgments = new StudioJudgmentService(session);
		this.runtimeFeatures = new StudioRuntimeFeatureService(session, mcpManager);
		this.catalog = new StudioRuntimeCatalogService(session, mcpManager, this.runtimeFeatures.mcpAuth);
		this.modelSystemTemplates = new StudioModelSystemTemplatesService(session);
		this.modelAuth = new StudioModelAuthService(session);
		this.modelRoster = new StudioModelRosterService(session);
		this.promptHistory = new StudioPromptHistoryService(session);
		this.views = new StudioRuntimeViews(session, liveAudio);
		this.views.modelServicesReader = operation => this.executeModelServices(operation);
		this.views.commitReader = operation => this.commit.execute(operation);
		this.views.promptHistoryReader = operation => this.promptHistory.execute(operation);
		this.benchmarks = new StudioBenchmarkService(session);
		this.media = new StudioMediaService(session);
		this.annotations = new StudioAnnotationService(session);
		this.sessionOptions = new StudioSessionOptionsService(session);
		this.disassembler = new StudioDisassemblerService(session);
		this.browserObservation = new StudioBrowserObservationService(session);
		this.managedBrowser = new StudioManagedBrowserService(session);
		this.relayHost = new StudioChromeRelayHostService(session);
		this.todoBackend = new StudioTodoBackendService(session);
		this.views.relayHostReader = operation => this.relayHost.execute(operation);
		this.computerObservation = new StudioComputerObservationService(session, undefined, this.computerWorkspace);
	}
	get commit(): StudioCommitService {
		return (this.#commit ??= new StudioCommitService(this.session, this.runtimeEpoch));
	}
	dispose(): void {
		this.#commit?.dispose();
		this.modelAuth.dispose();
		this.modelRoster.dispose();
		this.views.dispose();
		this.queuedCompaction.dispose();
		this.contextView.dispose();
		this.prediction.dispose();
		this.portability.dispose();
		this.compression.dispose();
		this.worktrees.dispose();
		this.maintenance.dispose();
		this.ratchet.dispose();
		this.evaluations.dispose();
		this.computerObservation.dispose();
		void this.computerWorkspace.dispose().catch(() => {});
		this.browserObservation.dispose();
		this.managedBrowser.dispose();
		this.runtimeFeatures.mcpAuth.dispose();
		this.disassembler.dispose();
		this.agentBtw.dispose();
		this.skillshare.dispose();
		this.accounts.dispose();
		this.benchmarks.dispose();
		this.media.dispose();
		this.liveAudio.dispose();
	}
	async executeModelServices(operation: ModelServicesOperation): Promise<unknown> {
		if (operation.kind === "models.available.refresh") return this.modelRoster.refreshAll(operation.sessionId);
		if (operation.kind === "models.available.read" || operation.kind === "models.available.release")
			return this.modelRoster.available(operation);
		if (operation.kind === "models.antigravity.readiness")
			return inspectStudioAntigravity(this.session, operation.sessionId);
		if (operation.kind.startsWith("models.systemTemplates."))
			return this.modelSystemTemplates.execute(
				operation as Extract<ModelServicesOperation, { kind: `models.systemTemplates.${string}` }>,
			);
		if (operation.kind.startsWith("models.auth."))
			return this.modelAuth.execute(operation as Extract<ModelServicesOperation, { kind: `models.auth.${string}` }>);
		if (operation.kind === "models.provider.roster.refresh")
			return this.modelRoster.refresh(operation.sessionId, operation.providerId);
		if (operation.kind === "models.accounts.resetPolicy.set")
			return this.accounts.setResetPolicy(operation.sessionId, operation.key, operation.mode);
		throw new SessionControlError("COMMAND_BLOCKED", "Unknown native model operation");
	}
	async execute(operation: WorkbenchOperation): Promise<unknown> {
		const result = await this.#execute(operation);
		return result;
	}
	async #execute(operation: WorkbenchOperation): Promise<unknown> {
		if (operation.kind === "commit.draft.select" || operation.kind === "commit.draft.execute")
			return this.commit.execute(operation);
		if (operation.kind === "history.prompts.delete") return this.promptHistory.execute(operation);
		if (
			operation.kind === "search.credentials.list" ||
			operation.kind === "search.credentials.set" ||
			operation.kind === "search.credentials.remove"
		)
			return new StudioSearchCredentialsService(this.session).execute(operation);
		if (isEvaluationWorkspaceOperation(operation)) return this.evaluations.execute(operation);
		if (isAdvisorConfigOperation(operation)) return this.advisorConfig.execute(operation);
		if (isLocalResourceOperation(operation)) return this.resources.local(operation);
		if (isDictationOperation(operation)) return this.liveAudio.dictation(operation);
		if (isSessionTitlesOperation(operation)) return this.titles.execute(operation);
		if (isPredictionChannelOperation(operation)) return this.prediction.execute(operation);
		if (isMaintenanceOperation(operation)) return this.maintenance.execute(operation);
		if (isChromeRelayHostOperation(operation)) return this.relayHost.execute(operation as ChromeRelayHostOperation);
		if (isMcpAuthOperation(operation)) return this.runtimeFeatures.mcpAuth.execute(operation as McpAuthOperation);
		if (isTodoBackendOperation(operation)) return this.todoBackend.execute(operation as TodoBackendOperation);
		if (isArchiveOperation(operation)) return this.archive.execute(operation);
		if (isAgentModelOperation(operation)) return this.agentModels.execute(operation);
		if (operation.kind === "session.restore.inspect") return this.sessionRestore.execute(operation);
		if (isRuntimeQueueOperation(operation)) return this.runtimeQueue.execute(operation);
		if (isNativePreferenceOperation(operation)) return this.nativePreferences.execute(operation);
		if (isFeatureSettingsOperation(operation)) return this.featureSettings.execute(operation);
		if (isSessionPortabilityOperation(operation)) return this.portability.execute(operation);
		if (isSessionCompressionOperation(operation)) return this.compression.execute(operation);
		if (isSessionWorktreeOperation(operation)) return this.worktrees.execute(operation);
		if (isNativePlanReviewOperation(operation)) {
			if (!this.planControl) throw new Error("Plan review host unavailable");
			return this.planControl.executeReview(operation);
		}
		if (operation.kind === "accounts.logout") return this.accounts.logout(operation.sessionId, operation.accountId);
		if (isRatchetOperation(operation)) return this.ratchet.execute(operation);
		if (isComputerWorkspaceOperation(operation)) return this.computerWorkspace.execute(operation);
		if (isComputerObservationOperation(operation)) return this.computerObservation.execute(operation);
		if (operation.kind === "browser.managed.prepare") return this.managedBrowser.prepare(operation.sessionId);
		if (operation.kind === "browser.webmcp.invoke") return this.managedBrowser.webMcpInvoke(operation);
		if (operation.kind === "extensions.links.activate") return activateStudioExtensionLink(this.session, operation);
		if (isBrowserObservationOperation(operation)) return this.browserObservation.execute(operation);
		if (isDisassemblerOperation(operation)) return this.disassembler.execute(operation);
		if (isSessionOptionsOperation(operation)) return this.sessionOptions.execute(operation);
		if (operation.kind === "resource.read") return this.resources.read(operation);
		if (
			operation.kind === "agent.btw.read" ||
			operation.kind === "agent.btw.ask" ||
			operation.kind === "agent.btw.abort"
		)
			return this.agentBtw.execute(operation);
		if (operation.kind === "prediction.control") {
			if (operation.sessionId !== this.session.sessionId)
				throw new SessionControlError("COMMAND_BLOCKED", "Prediction session changed");
			return this.prediction.control(operation.action);
		}
		if (
			operation.kind === "session.queue.ack" ||
			operation.kind === "session.queue.steer" ||
			operation.kind === "session.queue.list" ||
			operation.kind === "session.queue.remove" ||
			operation.kind === "session.queue.takeback" ||
			operation.kind === "session.tier.get" ||
			operation.kind === "session.tier.set" ||
			operation.kind === "session.skills.list"
		)
			return this.sessionGui.execute(operation);
		if (
			operation.kind === "skillshare.status" ||
			operation.kind === "skillshare.home" ||
			operation.kind === "skillshare.search" ||
			operation.kind === "skillshare.package" ||
			operation.kind === "skillshare.installed" ||
			operation.kind === "skillshare.tokens" ||
			operation.kind === "skillshare.prepare" ||
			operation.kind === "skillshare.execute" ||
			operation.kind === "skillshare.action" ||
			operation.kind === "skillshare.discard"
		)
			return this.skillshare.execute(operation);
		if (
			operation.kind === "live.audio.prepare" ||
			operation.kind === "live.audio.start" ||
			operation.kind === "live.audio.status" ||
			operation.kind === "live.audio.mute" ||
			operation.kind === "live.audio.release"
		)
			return this.liveAudio.execute(operation);
		if (
			operation.kind === "media.models" ||
			operation.kind === "media.list" ||
			operation.kind === "media.start" ||
			operation.kind === "media.read" ||
			operation.kind === "media.cancel" ||
			operation.kind === "media.resume" ||
			operation.kind === "media.close"
		)
			return this.media.execute(operation);
		if (
			operation.kind === "benchmarks.accounts.read" ||
			operation.kind === "benchmarks.list" ||
			operation.kind === "benchmarks.start" ||
			operation.kind === "benchmarks.read" ||
			operation.kind === "benchmarks.cancel" ||
			operation.kind === "benchmarks.close"
		)
			return this.benchmarks.execute(operation);
		if (
			operation.kind === "templates.list" ||
			operation.kind === "templates.get" ||
			operation.kind === "templates.prepare" ||
			operation.kind === "mcp.runtime.status"
		)
			return this.catalog.execute(operation);
		if (
			operation.kind === "judgments.list" ||
			operation.kind === "judgments.create" ||
			operation.kind === "judgments.read" ||
			operation.kind === "judgments.cancel" ||
			operation.kind === "judgments.close" ||
			operation.kind === "judgments.retry"
		)
			return this.judgments.execute(operation as JudgmentOperation);
		if (isRuntimeFeatureOperation(operation)) return this.runtimeFeatures.execute(operation);
		if (operation.kind === "annotations.capture" || operation.kind === "annotations.prepare")
			return this.annotations.execute(operation);
		if (operation.kind === "accounts.status") return this.accounts.get(operation.refresh);
		if (operation.kind === "accounts.status.details") return this.accounts.get(operation.refresh, true);
		if (operation.kind === "tokens.count") {
			const text = operation.text;
			return {
				bytes: Buffer.byteLength(text, "utf8"),
				chars: [...text].length,
				lines: text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
				encodings: Object.values(Encoding).map(encoding => ({ encoding, tokens: countTokens(text, encoding) })),
			};
		}
		if (operation.kind === "runtime.models.describe") {
			const model = this.session.modelRegistry
				.getAvailable("all")
				.find(model => model.provider + "/" + model.id === operation.selector);
			if (!model) throw new SessionControlError("INVALID_ARGUMENT", "The selected model is unavailable");
			return { model: projectRuntimeModel(model, true) };
		}
		if (operation.kind === "runtime.models.list") {
			const models = this.session.modelRegistry
				.getAvailable("all")
				.filter(model => !operation.modelKind || (model.kind ?? "chat") === operation.modelKind)
				.map(model => projectRuntimeModel(model))
				.sort((left, right) => left.selector.localeCompare(right.selector));
			const start = operation.cursor ? models.findIndex(model => model.selector === operation.cursor) + 1 : 0;
			if (operation.cursor && start === 0)
				throw new SessionControlError("INVALID_ARGUMENT", "Model catalog changed; refresh the list");
			const page = models.slice(start, start + (operation.limit ?? 200));
			return {
				models: page,
				total: models.length,
				...(start + page.length < models.length && page.length
					? { nextCursor: page[page.length - 1]!.selector }
					: {}),
			};
		}
		if (operation.kind === "services.leftovers.list") {
			const enabled = cfgLaunchEnabled.get(this.session.settings);
			const leftovers = await this.#listLeftovers();
			return {
				enabled,
				reapBackground: cfgBashReapBackground.get(this.session.settings),
				leftovers: leftovers.map(projectLeftoverProcess),
			};
		}
		if (operation.kind === "services.leftovers.terminate") {
			const leftovers = await this.#listLeftovers();
			const selected = this.#selectLeftovers(leftovers, operation.pids, operation.includeNohup === true);
			let killed = killLeftoverProcesses(selected);
			if (operation.includeNohup === true) {
				const nohupPids = selected.filter(proc => proc.kind === "nohup").map(proc => proc.pid);
				if (nohupPids.length > 0) killed += killProcessFamily(nohupPids);
			}
			const remaining = await this.#listLeftovers();
			return { killed, remaining: remaining.map(projectLeftoverProcess) };
		}
		const session = this.session.studioToolSession;
		if (!session) throw new SessionControlError("COMMAND_BLOCKED", "Service context is unavailable");
		const enabled = cfgLaunchEnabled.get(session.settings);
		if (operation.kind === "services.leftovers.adopt") {
			const leftovers = await this.#listLeftovers();
			if (!leftovers.some(proc => proc.pid === operation.pid)) {
				throw new SessionControlError(
					"INVALID_ARGUMENT",
					`Process ${operation.pid} is not a leftover process of this session`,
				);
			}
			try {
				const unit = await adoptService(session, operation.name, operation.pid);
				return { service: projectService(unit, this.session.sessionId) };
			} catch (error) {
				throw new SessionControlError("COMMAND_BLOCKED", error instanceof Error ? error.message : String(error));
			}
		}
		if (operation.kind === "services.list") {
			const [project, global] = await Promise.all([
				listServices(session),
				requestService(session, { op: "list", scope: { kind: "global" } }),
			]);
			return {
				enabled,
				services: [...project, ...global.units]
					.slice(0, 500)
					.map(unit => projectService(unit, this.session.sessionId)),
			};
		}
		if (operation.kind === "services.start") {
			const spec = operation.spec;
			const root = await realpath(session.cwd);
			const cwd = await realpath(path.resolve(root, spec.cwd ?? "."));
			const relative = path.relative(root, cwd);
			if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
				throw new SessionControlError("INVALID_ARGUMENT", "Service directory must stay inside the workspace");
			const result = await startService(session, {
				...spec,
				cwd,
				replace: false,
				awaitReady: false,
				...(spec.ready ? { ready: { ...spec.ready, timeout: spec.ready.timeoutMs / 1000 } } : {}),
			});
			return { service: projectService(result.daemon, this.session.sessionId), readyTimedOut: result.readyTimedOut };
		}
		const target = (await listServices(session)).find(
			unit => unit.key === operation.name && projectService(unit).instanceId === operation.instanceId,
		);
		if (!target)
			throw new SessionControlError("COMMAND_BLOCKED", "Service instance changed; refresh before trying again");
		const named = { unit: target.id, generation: target.generation };
		if (operation.kind === "services.logs") {
			const result = await requestService(session, {
				op: "logs",
				...named,
				lines: operation.lines ?? 200,
				head: false,
				follow: false,
				timeoutMs: 1000,
				cursor: operation.cursor,
			});
			return {
				instanceId: operation.instanceId,
				text: sanitizeText(result.terminalOutput || result.text).slice(-65536),
				cursor: result.cursor,
				state: result.unit.state,
			};
		}
		const unit =
			operation.kind === "services.mode.set"
				? await modeService(session, operation.name, operation.mode, undefined, named)
				: (
						await requestService(
							session,
							operation.kind === "services.stop"
								? { op: "stop", ...named, timeoutMs: 5000 }
								: operation.kind === "services.restart"
									? { op: "restart", ...named }
									: { op: "send", ...named, data: operation.text },
						)
					).unit;
		if (operation.kind === "services.stop" && unit.generation !== named.generation)
			throw new SessionControlError("COMMAND_BLOCKED", "Service instance changed; refresh before trying again");
		return { service: projectService(unit, this.session.sessionId) };
	}

	async #listLeftovers(): Promise<LeftoverProcess[]> {
		const sessionId = this.session.sessionManager.getSessionId();
		const excluded: number[] = [];
		for (const job of this.session.asyncJobManager?.getAllJobs() ?? []) {
			if (job.status === "running" && job.process) excluded.push(...job.process.pids());
		}
		const held = heldShellProcesses(sessionId);
		const initial = listLeftoverProcesses(sessionId, held, excluded);
		if (initial.length === 0) return [];
		if (cfgLaunchEnabled.get(this.session.settings)) {
			const toolSession = this.session.studioToolSession;
			if (!toolSession) {
				throw new SessionControlError("COMMAND_BLOCKED", "Service context is unavailable");
			}
			try {
				const [project, global] = await Promise.all([
					listServices(toolSession, AbortSignal.timeout(5_000)),
					requestService(toolSession, { op: "list", scope: { kind: "global" } }, AbortSignal.timeout(5_000)).catch(
						() => ({ units: [] }),
					),
				]);
				for (const unit of [...project, ...global.units]) excluded.push(...unit.pids);
			} catch {
				throw new SessionControlError(
					"COMMAND_BLOCKED",
					"Service registry could not be queried; refusing to inspect or modify leftover processes",
				);
			}
		}
		return listLeftoverProcesses(sessionId, held, excluded);
	}

	#selectLeftovers(
		leftovers: readonly LeftoverProcess[],
		pids: readonly number[] | undefined,
		includeNohup: boolean,
	): LeftoverProcess[] {
		if (pids === undefined) return [...leftovers];
		const byPid = new Map(leftovers.map(proc => [proc.pid, proc]));
		const selected: LeftoverProcess[] = [];
		for (const pid of new Set(pids)) {
			const match = byPid.get(pid);
			if (!match) {
				throw new SessionControlError(
					"INVALID_ARGUMENT",
					`Process ${pid} is not a leftover process of this session`,
				);
			}
			selected.push(match);
		}
		if (!includeNohup && selected.some(proc => proc.kind === "nohup")) {
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"Selected leftover process ignores SIGHUP (nohup); pass includeNohup to terminate it",
			);
		}
		return selected;
	}
}

function isRuntimeQueueOperation(operation: WorkbenchOperation): operation is RuntimeQueueOperation {
	return isRuntimeQueueKind(operation.kind);
}

/** Public model facts only; endpoints, headers and credential material stay in Runtime. */
export function projectRuntimeModel(model: Model, includeExecution = false): RuntimeModelChoice {
	const compat = model.compat as Record<string, unknown> | undefined;
	return {
		selector: model.provider + "/" + model.id,
		name: model.name,
		provider: model.provider,
		kind: model.kind ?? "chat",
		image: model.input.includes("image"),
		reasoning: model.reasoning,
		snapcompactShape: model.snapcompactShape,
		...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
		...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens }),
		...(model.webSearch ? { webSearch: model.webSearch } : {}),
		...(includeExecution
			? {
					...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}),
					...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
					...(model.promptCacheConfig ? { promptCacheConfig: { ...model.promptCacheConfig } } : {}),
					compatibility: {
						...(typeof compat?.supportsMessageThreads === "boolean"
							? { supportsMessageThreads: compat.supportsMessageThreads }
							: {}),
						...(typeof compat?.toolNamePrefix === "string" ? { toolNamePrefix: compat.toolNamePrefix } : {}),
						...(typeof compat?.statefulResponses === "boolean"
							? { statefulResponses: compat.statefulResponses }
							: {}),
						...(model.preferWebsockets === undefined ? {} : { preferWebsockets: model.preferWebsockets }),
						...(model.useResponsesLite === undefined ? {} : { useResponsesLite: model.useResponsesLite }),
					},
				}
			: {}),
	};
}

function isFeatureSettingsOperation(operation: WorkbenchOperation): operation is FeatureSettingsOperation {
	return isFeatureSettingsKind(operation.kind);
}

function isSessionPortabilityOperation(operation: WorkbenchOperation): operation is SessionPortabilityOperation {
	return isSessionPortabilityKind(operation.kind);
}

function isSessionCompressionOperation(operation: WorkbenchOperation): operation is SessionCompressionOperation {
	return isSessionCompressionKind(operation.kind);
}

function isSessionWorktreeOperation(operation: WorkbenchOperation): operation is SessionWorktreeOperation {
	return isSessionWorktreeKind(operation.kind);
}

function isNativePlanReviewOperation(operation: WorkbenchOperation): operation is NativePlanReviewOperation {
	return isNativePlanReviewKind(operation.kind);
}
