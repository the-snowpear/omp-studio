import { StudioSessionTitlesService } from "./session-titles-service";
import { isSessionTitlesKind, type SessionTitlesOperation } from "../session-titles-protocol";
import { StudioPredictionService } from "./prediction-service";
import { isPredictionKind, type PredictionOperation } from "../prediction-protocol";
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
import { StudioSkillshareService } from "./skillshare-service";
import { StudioLiveAudioService } from "./live-audio-service";
import { StudioMediaService } from "./media-service";
import { StudioBenchmarkService } from "./benchmark-service";
import { StudioRuntimeCatalogService } from "./runtime-catalog-service";
import { StudioJudgmentService } from "./judgment-service";
import { StudioSessionOptionsService } from "./session-options-service";
import { StudioIdaService } from "./ida-service";
import { StudioBrowserObservationService } from "./browser-observation-service";
import { StudioComputerObservationService } from "./computer-observation-service";
import { isComputerObservationKind, type ComputerObservationOperation } from "../computer-observation-protocol";
import { isBrowserObservationKind, type BrowserObservationOperation } from "../browser-observation-protocol";
import { isIdaOperationKind, type StudioIdaOperation } from "../ida-protocol";
import { isSessionOptionsKind, type SessionOptionsOperation } from "../session-options-protocol";
import { type JudgmentOperation } from "../judgments-protocol";
import { StudioAnnotationService } from "./annotation-service";
import { StudioAccountStatusService } from "./account-status-service";
import * as path from "node:path";
import { realpath } from "node:fs/promises";
import { Encoding, countTokens } from "@oh-my-pi/pi-natives";
import type { DaemonSnapshot } from "@oh-my-pi/pi-tui/tools/daemon";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { listServices, requestService, startService } from "../../launch/services";
import type { AgentSession } from "../../session/agent-session";
import type { StudioServiceRow, WorkbenchOperation } from "../workbench-protocol";
import { validateWorkbenchOperation, validateWorkbenchResult } from "../workbench-protocol";
import { SessionControlError } from "./session-control-service";

function isSessionTitlesOperation(operation: WorkbenchOperation): operation is SessionTitlesOperation {
	return isSessionTitlesKind(operation.kind);
}
function isPredictionOperation(operation: WorkbenchOperation): operation is PredictionOperation {
	return isPredictionKind(operation.kind);
}
function isMaintenanceOperation(operation: WorkbenchOperation): operation is MaintenanceOperation {
	return isMaintenanceKind(operation.kind);
}
function isArchiveOperation(operation: WorkbenchOperation): operation is ArchiveOperation {
	return isArchiveOperationKind(operation.kind);
}
function isSessionOptionsOperation(operation: WorkbenchOperation): operation is SessionOptionsOperation {
	return isSessionOptionsKind(operation.kind);
}
function isIdaOperation(operation: WorkbenchOperation): operation is StudioIdaOperation {
	return isIdaOperationKind(operation.kind);
}
function isBrowserObservationOperation(operation: WorkbenchOperation): operation is BrowserObservationOperation {
	return isBrowserObservationKind(operation.kind);
}
function isComputerObservationOperation(operation: WorkbenchOperation): operation is ComputerObservationOperation {
	return isComputerObservationKind(operation.kind);
}

function isRatchetOperation(operation: WorkbenchOperation): operation is RatchetOperation {
	return isRatchetKind(operation.kind);
}

function isNativePreferenceOperation(operation: WorkbenchOperation): operation is NativePreferenceOperation {
	return isNativePreferenceKind(operation.kind);
}
export function projectService(daemon: DaemonSnapshot): StudioServiceRow {
	return {
		name: daemon.name,
		instanceId: daemon.id + ":" + daemon.startedAt,
		state: daemon.state,
		startedAt: daemon.startedAt,
		...(daemon.readyAt === undefined ? {} : { readyAt: daemon.readyAt }),
		...(daemon.exitedAt === undefined ? {} : { exitedAt: daemon.exitedAt }),
		...(daemon.exitCode === undefined ? {} : { exitCode: daemon.exitCode }),
		restartCount: daemon.restartCount,
		outputBytes: daemon.outputBytes,
		...(daemon.owner ? { ownerAgentId: daemon.owner } : {}),
		mode: daemon.detached ? "detached" : daemon.persist ? "persist" : "session",
	};
}

/** Uses the current worker's native ToolSession and its lifecycle/owner subscriptions. */
export class StudioWorkbenchService {
	readonly titles: StudioSessionTitlesService;
	readonly prediction: StudioPredictionService;
	readonly maintenance: StudioMaintenanceService;
	readonly archive: StudioArchiveService;
	readonly agentModels: StudioAgentModelService;
	readonly sessionRestore: StudioSessionRestoreService;
	readonly runtimeQueue: StudioRuntimeQueueService;
	readonly nativePreferences: StudioNativePreferencesService;
	readonly ratchet: StudioRatchetService;
	readonly skillshare: StudioSkillshareService;
	readonly media: StudioMediaService;
	readonly benchmarks: StudioBenchmarkService;
	readonly catalog: StudioRuntimeCatalogService;
	readonly judgments: StudioJudgmentService;
	readonly accounts: StudioAccountStatusService;
	readonly annotations: StudioAnnotationService;
	readonly sessionOptions: StudioSessionOptionsService;
	readonly ida: StudioIdaService;
	readonly browserObservation: StudioBrowserObservationService;
	readonly computerObservation: StudioComputerObservationService;
	constructor(
		readonly session: AgentSession,
		readonly liveAudio = new StudioLiveAudioService(session),
	) {
		this.titles = new StudioSessionTitlesService(session);
		this.prediction = new StudioPredictionService(session);
		this.maintenance = new StudioMaintenanceService(session);
		this.archive = new StudioArchiveService(session);
		this.agentModels = new StudioAgentModelService(session);
		this.sessionRestore = new StudioSessionRestoreService(session);
		this.runtimeQueue = new StudioRuntimeQueueService(session);
		this.nativePreferences = new StudioNativePreferencesService(session);
		this.ratchet = new StudioRatchetService(session);
		this.skillshare = new StudioSkillshareService(session);
		this.accounts = new StudioAccountStatusService(session);
		this.judgments = new StudioJudgmentService(session);
		this.catalog = new StudioRuntimeCatalogService(session);
		this.benchmarks = new StudioBenchmarkService(session);
		this.media = new StudioMediaService(session);
		this.annotations = new StudioAnnotationService(session);
		this.sessionOptions = new StudioSessionOptionsService(session);
		this.ida = new StudioIdaService(session);
		this.browserObservation = new StudioBrowserObservationService(session);
		this.computerObservation = new StudioComputerObservationService(session);
	}
	dispose(): void {
		this.prediction.dispose();
		this.maintenance.dispose();
		this.ratchet.dispose();
		this.computerObservation.dispose();
		this.browserObservation.dispose();
		this.ida.dispose();
		this.skillshare.dispose();
		this.accounts.dispose();
		this.benchmarks.dispose();
		this.media.dispose();
		this.liveAudio.dispose();
	}
	async execute(operation: WorkbenchOperation): Promise<unknown> {
		validateWorkbenchOperation(operation);
		const result = await this.#execute(operation);
		validateWorkbenchResult(operation.kind, result);
		return result;
	}
	async #execute(operation: WorkbenchOperation): Promise<unknown> {
		if (isSessionTitlesOperation(operation)) return this.titles.execute(operation);
		if (isPredictionOperation(operation)) return this.prediction.execute(operation);
		if (isMaintenanceOperation(operation)) return this.maintenance.execute(operation);
		if (isArchiveOperation(operation)) return this.archive.execute(operation);
		if (operation.kind === "agent.model.inspect") return this.agentModels.execute(operation);
		if (operation.kind === "session.restore.inspect") return this.sessionRestore.execute(operation);
		if (isRuntimeQueueOperation(operation)) return this.runtimeQueue.execute(operation);
		if (isNativePreferenceOperation(operation)) return this.nativePreferences.execute(operation);
		if (operation.kind === "accounts.logout") return this.accounts.logout(operation.sessionId, operation.accountId);
		if (isRatchetOperation(operation)) return this.ratchet.execute(operation);
		if (isComputerObservationOperation(operation)) return this.computerObservation.execute(operation);
		if (isBrowserObservationOperation(operation)) return this.browserObservation.execute(operation);
		if (isIdaOperation(operation)) return this.ida.execute(operation);
		if (isSessionOptionsOperation(operation)) return this.sessionOptions.execute(operation);
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
		const session = this.session.studioToolSession;
		if (!session) throw new SessionControlError("COMMAND_BLOCKED", "Service context is unavailable");
		const enabled = cfgLaunchEnabled.get(session.settings);
		if (operation.kind === "services.list")
			return { enabled, services: (await listServices(session)).slice(0, 500).map(projectService) };
		// An older broker silently ignores unknown fence fields. Never send it a GUI mutation.
		const ping = await requestService(session, { op: "ping" });
		if (ping.op !== "ping" || !ping.instanceFencing)
			throw new SessionControlError(
				"COMMAND_BLOCKED",
				"This project broker needs to be restarted with the updated Runtime before controlling services",
			);
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
				waitForReady: false,
				...(spec.ready ? { ready: { ...spec.ready, timeout: spec.ready.timeoutMs / 1000 } } : {}),
			});
			return { service: projectService(result.daemon), readyTimedOut: result.readyTimedOut };
		}
		const named = { name: operation.name, expectedInstanceId: operation.instanceId };
		if (operation.kind === "services.logs") {
			const result = await requestService(session, {
				op: "logs",
				...named,
				lines: operation.lines ?? 200,
				head: false,
				follow: false,
				timeoutMs: 1000,
				cursor: operation.cursor,
				renderTerminalRows: true,
			});
			if (result.op !== "logs") throw new Error("Unexpected service logs response");
			return {
				instanceId: operation.instanceId,
				text: sanitizeText(result.terminalRows?.join("\n") ?? result.text).slice(-65536),
				cursor: result.cursor,
				state: result.state,
			};
		}
		const result = await requestService(
			session,
			operation.kind === "services.stop"
				? { op: "stop", ...named, timeoutMs: 5000 }
				: operation.kind === "services.restart"
					? { op: "restart", ...named }
					: operation.kind === "services.mode.set"
						? { op: "mode", ...named, mode: operation.mode }
						: { op: "send", ...named, data: operation.text },
		);
		if (!("daemon" in result)) throw new Error("Unexpected service response");
		return { service: projectService(result.daemon) };
	}
}

function isRuntimeQueueOperation(operation: WorkbenchOperation): operation is RuntimeQueueOperation {
	return isRuntimeQueueKind(operation.kind);
}

/** Public model facts only; endpoints, headers and credential material stay in Runtime. */
export function projectRuntimeModel(model: Model, includeExecution = false): RuntimeModelChoice {
	return {
		selector: model.provider + "/" + model.id,
		name: model.name,
		provider: model.provider,
		kind: model.kind ?? "chat",
		image: model.input.includes("image"),
		reasoning: model.reasoning,
		...(model.contextWindow === null ? {} : { contextWindow: model.contextWindow }),
		...(model.maxTokens === null ? {} : { maxTokens: model.maxTokens }),
		...(model.webSearch ? { webSearch: model.webSearch } : {}),
		...(includeExecution
			? {
					...(model.serviceTiers ? { serviceTiers: [...model.serviceTiers] } : {}),
					...(model.promptCache ? { promptCache: { ...model.promptCache } } : {}),
					...(model.promptCacheConfig ? { promptCacheConfig: { ...model.promptCacheConfig } } : {}),
					compatibility: {
						...(model.preferWebsockets === undefined ? {} : { preferWebsockets: model.preferWebsockets }),
						...(model.useResponsesLite === undefined ? {} : { useResponsesLite: model.useResponsesLite }),
						...(model.toolMode === undefined ? {} : { toolMode: model.toolMode }),
					},
				}
			: {}),
	};
}
