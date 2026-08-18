import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, logger, postmortem, prompt } from "@oh-my-pi/pi-utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { ExtensionUIContext, ToolDefinition } from "../extensibility/extensions";
import { IrcBus } from "../irc/bus";
import backgroundTanDispatchPrompt from "../prompts/system/background-tan-dispatch.md" with { type: "text" };
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { registerPersistedSubagents } from "../registry/persisted-agents";
import * as sdk from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../session/messages";
import type { SessionEntry } from "../session/session-entries";
import { loadEntriesFromFile } from "../session/session-loader";
import type { SessionManager } from "../session/session-manager";
import { SessionManager as NativeSessionManager } from "../session/session-manager";
import { TaskTool } from "../task";
import { runStructuredSubagent } from "../task/structured-subagent";
import type { TaskEffort } from "../thinking";
import type { ToolSession } from "../tools";
import type { ToolUiFactory } from "../tools/context";
import { StudioBridgeServer } from "./bridge-server";
import { createStudioRemoteUiFactory } from "./remote-extension-ui";
import { StudioAgentConversationService } from "./services/agent-conversation-service";
import {
	StudioAgentHubService,
	type StudioAgentTelemetryPort,
	type StudioAgentUsage,
} from "./services/agent-hub-service";
import { StudioBtwService } from "./services/btw-service";
import { StudioCommandManifestService } from "./services/command-manifest-service";
import { ConversationLiveProjector } from "./services/conversation-live-projector";
import { ConversationProjectorHub } from "./services/conversation-projector-hub";
import { StudioFastPrewalkService } from "./services/fast-prewalk-service";
import { StudioForkService } from "./services/fork-service";
import { StudioHandoffService } from "./services/handoff-service";
import { StudioInteractionGateway } from "./services/interaction-port";
import { StudioJobService, type StudioJobsPort } from "./services/job-service";
import { StudioLiveService, type StudioLiveSessionFactory } from "./services/live-service";
import { StudioLoopService } from "./services/loop-service";
import { StudioModeControlService } from "./services/mode-control-service";
import { StudioModelControlService } from "./services/model-control-service";
import { StudioPermissionControlService } from "./services/permission-control-service";
import { StudioOmfgService } from "./services/omfg-service";
import { type StudioPauseService, studioPauseService } from "./services/pause-service";
import { StudioSessionTranscriptService } from "./services/session-transcript-service";
import { StudioTanError, StudioTanService } from "./services/tan-service";
import { StudioTreeService } from "./services/tree-service";

export interface StudioBridgeConfiguration {
	endpoint?: string;
	tokenFile?: string;
	runtimeEpoch?: number;
}

export interface StudioHostRuntime {
	readonly runtimeId: string;
	readonly runtimeEpoch: number;
	readonly sessionId: string;
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	readonly services: Readonly<{
		pause: StudioPauseService;
		loop: StudioLoopService;
		live: StudioLiveService;
		modes: StudioModeControlService;
		models: StudioModelControlService;
		permissions?: StudioPermissionControlService;
		tree: StudioTreeService;
		fork: StudioForkService;
		handoff: StudioHandoffService;
		fastPrewalk: StudioFastPrewalkService;
		commands: StudioCommandManifestService;
		btw: StudioBtwService;
		interaction: StudioInteractionGateway;
		omfg: StudioOmfgService;
		tan: StudioTanService;
		agents: StudioAgentHubService;
		jobs: StudioJobService;
		transcript: StudioSessionTranscriptService;
		agentConversation: StudioAgentConversationService;
		conversation?: ConversationProjectorHub;
	}>;
	readonly bridgeConfig: Readonly<StudioBridgeConfiguration>;
	waitForShutdown(): Promise<void>;
	requestShutdown(): void;
	dispose(): void;
}

export interface StudioBridgeLifecycle {
	start(runtime: StudioHostRuntime): Promise<void>;
	stop(): Promise<void>;
}

export type StudioHostTuiRunner = (runtime: StudioHostRuntime) => Promise<void>;

export type RunStudioHostMode = (
	session: AgentSession,
	bridgeConfig: StudioBridgeConfiguration,
	runTui: StudioHostTuiRunner,
	dependencies?: StudioHostModeDependencies,
) => Promise<void>;

export interface StudioHostModeDependencies {
	createBridge?: () => StudioBridgeLifecycle;
	createRuntimeId?: () => string;
	tanCustomTools?: (CustomTool | ToolDefinition)[];
	liveSessionFactory?: StudioLiveSessionFactory;
	/**
	 * Tool UI context setter from session creation. When present, the
	 * Studio headless Runtime installs a per-tool-call Remote UI factory
	 * through it (plan §2.5) and invalidates it on dispose.
	 */
	setToolUIContext?: (uiContext: ExtensionUIContext | ToolUiFactory | undefined, hasUI: boolean) => void;
}

function sessionFileOf(session: AgentSession): string | null {
	const manager = session.sessionManager;
	if (typeof manager.getSessionFile !== "function") return null;
	return manager.getSessionFile() ?? null;
}

async function hydratePersistedStudioAgents(
	registry: AgentRegistry,
	sessionFile: string | null,
	shouldContinue?: () => boolean,
): Promise<void> {
	try {
		await registerPersistedSubagents(
			registry,
			sessionFile,
			shouldContinue === undefined ? {} : { shouldContinue },
		);
	} catch (error) {
		logger.warn("Failed to register persisted subagents", { error });
	}
}

function createConfiguredBridge(bridgeConfig: StudioBridgeConfiguration): StudioBridgeLifecycle {
	if (
		bridgeConfig.endpoint === undefined ||
		bridgeConfig.tokenFile === undefined ||
		!Number.isSafeInteger(bridgeConfig.runtimeEpoch) ||
		(bridgeConfig.runtimeEpoch as number) <= 0
	) {
		throw new Error("studio-host mode requires --bridge-endpoint, --bridge-token-file, and --bridge-runtime-epoch");
	}
	return new StudioBridgeServer(bridgeConfig.endpoint, bridgeConfig.tokenFile);
}

function transcriptText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const block = item as Record<string, unknown>;
		if (typeof block.text === "string") parts.push(block.text);
		else if (typeof block.thinking === "string") parts.push(block.thinking);
		else if (block.type === "toolCall" && typeof block.name === "string") {
			parts.push(`${block.name} ${JSON.stringify(block.arguments ?? {})}`);
		}
	}
	return parts.join("\n");
}

function studioTranscriptMessage(entry: SessionEntry): Array<{
	id: string;
	role: "user" | "assistant" | "custom" | "system";
	ts: number;
	text: string;
}> {
	if (entry.type === "message") {
		if (!("content" in entry.message)) return [];
		const role = entry.message.role === "user" ? "user" : entry.message.role === "assistant" ? "assistant" : "system";
		const text = transcriptText(entry.message.content).trim();
		return text.length === 0 ? [] : [{ id: entry.id, role, ts: Date.parse(entry.timestamp) || 0, text }];
	}
	if (entry.type === "custom_message" && entry.display) {
		const text = transcriptText(entry.content).trim();
		return text.length === 0 ? [] : [{ id: entry.id, role: "custom", ts: Date.parse(entry.timestamp) || 0, text }];
	}
	return [];
}

function studioToolSession(session: AgentSession): ToolSession {
	return new Proxy(session, {
		get(target, property) {
			if (property === "cwd") return target.sessionManager.getCwd();
			if (property === "hasUI") return false;
			if (property === "getSessionFile") return () => target.sessionManager.getSessionFile() ?? null;
			if (property === "getSessionSpawns") return () => "*";
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as unknown as ToolSession;
}

interface StudioAgentTelemetryCache {
	usage?: StudioAgentUsage;
	model?: string;
	summary?: string;
}

/**
 * Live per-agent telemetry port over AgentSession. Results are cached per
 * agent and invalidated by that agent's own session events, so roster
 * projections never rescan long transcripts on every state push.
 */
function createStudioAgentTelemetry(registry: AgentRegistry): StudioAgentTelemetryPort {
	const cache = new Map<string, StudioAgentTelemetryCache>();
	const listeners = new Map<string, Set<() => void>>();
	const attachedSessions = new Map<string, { session: AgentSession; unsubscribe: () => void }>();

	const notify = (agentId: string): void => {
		cache.delete(agentId);
		for (const listener of listeners.get(agentId) ?? []) {
			try {
				listener();
			} catch {
				// telemetry listeners must not break the session event path
			}
		}
	};

	const attach = (agentId: string): void => {
		const session = registry.get(agentId)?.session ?? null;
		const attached = attachedSessions.get(agentId);
		if (attached && attached.session === session) return;
		attached?.unsubscribe();
		attachedSessions.delete(agentId);
		if (!session) return;
		const unsubscribe = session.subscribe(() => notify(agentId));
		attachedSessions.set(agentId, { session, unsubscribe });
	};

	const telemetryFor = (agentId: string): StudioAgentTelemetryCache => {
		const cached = cache.get(agentId);
		if (cached) return cached;
		const result: StudioAgentTelemetryCache = {};
		const ref = registry.get(agentId);
		const session = ref?.session ?? null;
		if (ref && session) {
			try {
				const stats = session.getSessionStats();
				result.usage = {
					tokens: stats.tokens.total,
					requests: stats.assistantMessages,
					tools: stats.toolCalls,
					cost: stats.cost,
					durationMs: Math.max(0, ref.lastActivity - ref.createdAt),
					durationKind: "active",
					...(stats.contextUsage
						? { contextTokens: stats.contextUsage.tokens, contextWindow: stats.contextUsage.contextWindow }
						: {}),
				};
			} catch {
				// live usage stays unavailable
			}
			const model = session.model?.id;
			if (model !== undefined && model.length > 0) result.model = model;
			try {
				const entries = session.sessionManager.getEntries();
				for (let index = entries.length - 1; index >= 0; index -= 1) {
					const last = studioTranscriptMessage(entries[index]!).find(message => message.role === "assistant");
					if (last && last.text.length > 0) {
						result.summary = last.text.slice(0, 200);
						break;
					}
				}
			} catch {
				// latest assistant gist stays unavailable
			}
		}
		cache.set(agentId, result);
		return result;
	};

	return {
		liveUsage: agentId => telemetryFor(agentId).usage,
		liveModel: agentId => telemetryFor(agentId).model,
		liveSummary: agentId => telemetryFor(agentId).summary,
		refresh: agentId => {
			attach(agentId);
		},
		onChange: (agentId, listener) => {
			attach(agentId);
			let set = listeners.get(agentId);
			if (!set) {
				set = new Set();
				listeners.set(agentId, set);
			}
			set.add(listener);
			const currentSet = set;
			return () => {
				currentSet.delete(listener);
				if (currentSet.size === 0) {
					listeners.delete(agentId);
					attachedSessions.get(agentId)?.unsubscribe();
					attachedSessions.delete(agentId);
					cache.delete(agentId);
				}
			};
		},
	};
}

export function createStudioHostRuntime(
	session: AgentSession,
	bridgeConfig: StudioBridgeConfiguration,
	createRuntimeId: () => string = crypto.randomUUID,
	tanCustomTools?: (CustomTool | ToolDefinition)[],
	liveSessionFactory?: StudioLiveSessionFactory,
): StudioHostRuntime {
	if (!Number.isSafeInteger(bridgeConfig.runtimeEpoch) || (bridgeConfig.runtimeEpoch as number) <= 0) {
		throw new Error("Studio Host Runtime epoch must be a positive safe integer");
	}
	const loop = new StudioLoopService({
		action: () => session.settings.get("loop.mode"),
		isBlocked: () => session.isStreaming || session.isCompacting || session.hasPostPromptWork,
		isVibeActive: () => session.getVibeModeState()?.enabled === true,
		submitPrompt: async prompt => {
			await session.prompt(prompt);
		},
		compact: async () => {
			await session.compact();
		},
		reset: async () => {
			await session.resetSessionContext();
		},
		nowMs: Date.now,
		setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
		clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
	});
	const live = new StudioLiveService(liveSessionFactory);
	const modes = new StudioModeControlService(session);
	const models = new StudioModelControlService(session);
	const permissions = new StudioPermissionControlService(session);
	session.setBeforeNextUserTurn(async () => {
		await models.applyPending();
		await modes.applyPending();
		await permissions.applyPending();
	});
	const interaction = new StudioInteractionGateway();
	const tree = new StudioTreeService(session, interaction);
	const fork = new StudioForkService(session);
	const handoff = new StudioHandoffService(session);
	const fastPrewalk = new StudioFastPrewalkService(session);
	const commands = new StudioCommandManifestService(session);
	const btw = new StudioBtwService(session);
	let pendingRuleWrite: { filePath: string; previous: Uint8Array | undefined; existed: boolean } | undefined;
	const clearPendingRuleWrite = () => {
		pendingRuleWrite = undefined;
	};
	const omfg = new StudioOmfgService(
		{
			runEphemeralTurn: args => session.runEphemeralTurn(args),
			getMessages: () => session.messages,
		},
		{
			resolveRulePath: (scope, ruleName) =>
				path.join(
					scope === "user" ? session.settings.getAgentDir() : session.sessionManager.getCwd(),
					...(scope === "user" ? [] : [CONFIG_DIR_NAME]),
					"rules",
					`${ruleName}.md`,
				),
			exists: async filePath => await Bun.file(filePath).exists(),
			write: async (filePath, content) => {
				await Bun.write(filePath, content);
			},
			writeAtomic: async (filePath, content) => {
				await fs.mkdir(path.dirname(filePath), { recursive: true });
				const existing = Bun.file(filePath);
				const existed = await existing.exists();
				const previous = existed ? new Uint8Array(await existing.arrayBuffer()) : undefined;
				const temporary = path.join(
					path.dirname(filePath),
					`.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`,
				);
				try {
					await Bun.write(temporary, content);
					await fs.rename(temporary, filePath);
					pendingRuleWrite = { filePath, previous, existed };
				} finally {
					await fs.rm(temporary, { force: true }).catch(() => {});
				}
			},
		},
		{
			register: rule => session.ttsrManager?.addRule(rule) ?? false,
		},
		interaction,
		{
			rollback: async filePath => {
				if (pendingRuleWrite?.filePath !== filePath) return;
				if (pendingRuleWrite.existed && pendingRuleWrite.previous !== undefined) {
					await Bun.write(filePath, pendingRuleWrite.previous);
				} else {
					await fs.rm(filePath, { force: true });
				}
				clearPendingRuleWrite();
			},
			finalize: clearPendingRuleWrite,
		},
	);
	const registry = AgentRegistry.global();
	const lifecycle = AgentLifecycleManager.global();
	const irc = IrcBus.global();
	const tan = new StudioTanService({
		parent: {
			get sessionId() {
				return session.sessionId;
			},
			get promptCacheKey() {
				return session.agent.promptCacheKey ?? session.sessionId;
			},
			get ownerId() {
				return session.getAgentId() ?? MAIN_AGENT_ID;
			},
			get isStreaming() {
				return session.isStreaming;
			},
			get model() {
				return session.model;
			},
			get modelRegistry() {
				return session.modelRegistry;
			},
			get authStorage() {
				return session.modelRegistry.authStorage;
			},
			get systemPrompt() {
				return [...session.systemPrompt];
			},
			get toolNames() {
				return session.getActiveToolNames();
			},
			get thinkingLevel() {
				return session.configuredThinkingLevel() ?? "auto";
			},
			settings: session.settings,
			get enableLsp() {
				return session.settings.get("task.enableLsp") !== false;
			},
			customTools: tanCustomTools,
			get parentFile() {
				return session.sessionManager.getSessionFile() ?? undefined;
			},
			get cwd() {
				return session.sessionManager.getCwd();
			},
			get sessionDir() {
				const parentFile = session.sessionManager.getSessionFile();
				return parentFile ? parentFile.slice(0, -6) : session.sessionManager.getCwd();
			},
			get artifactsDir() {
				return session.sessionManager.getArtifactsDir();
			},
			get parentLocalSessionId() {
				return session.sessionManager.getSessionId();
			},
		},
		fork: async input => {
			await session.sessionManager.ensureOnDisk();
			await session.sessionManager.flush();
			return await NativeSessionManager.forkFrom(input.parentFile, input.cwd, input.sessionDir, undefined, {
				suppressBreadcrumb: true,
				sessionFile: input.cloneFile,
			});
		},
		createAgent: async options => {
			const created = await sdk.createAgentSession(options);
			return { session: created.session, sessionFile: created.session.sessionManager.getSessionFile() ?? null };
		},
		adopt: input => {
			const current = registry.get(input.agentId);
			if (current?.session === input.session) return true;
			if (current !== undefined) return false;
			registry.register({
				id: input.agentId,
				displayName: input.displayName,
				kind: "sub",
				parentId: input.parentId,
				session: input.session,
				sessionFile: input.sessionFile,
				status: "running",
			});
			return true;
		},
		jobManager: {
			register: (type, label, run, options) => {
				const manager = session.asyncJobManager;
				if (!manager) throw new StudioTanError("COMMAND_BLOCKED", "Background jobs are disabled");
				return manager.register(type, label, run, options);
			},
		},
		registry,
		deliver: async ({ jobId, work }) => {
			await session.sendCustomMessage(
				{
					customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
					content: prompt.render(backgroundTanDispatchPrompt, { jobId, work }),
					display: true,
					attribution: "user",
					details: { jobId, work },
				},
				{ triggerTurn: false, deliverAs: "nextTurn" },
			);
		},
		cleanup: {
			cancelJob: jobId => {
				session.asyncJobManager?.cancel(jobId, { ownerId: session.getAgentId() ?? MAIN_AGENT_ID });
			},
			unregisterAgent: agentId => {
				registry.unregister(agentId);
			},
			disposeSession: async child => {
				await child.dispose();
			},
			removeCloneFiles: async cloneFile => {
				await Promise.allSettled([
					fs.rm(cloneFile, { force: true }),
					fs.rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
				]);
			},
		},
	});
	const jobManager = session.asyncJobManager;
	const toolSession = studioToolSession(session);
	const jobsPort: StudioJobsPort = jobManager ?? {
		getJob: () => undefined,
		getRunningJobs: () => [],
		getRecentJobs: () => [],
		getAllJobs: () => [],
		cancel: () => false,
	};
	const jobs = new StudioJobService(jobsPort, registry, {
		confirmationGate: async action =>
			await interaction.confirm({
				commandId: `job.cancel:${action.jobId}`,
				title: "Cancel background job?",
				message: `Cancel job ${action.jobId}?`,
				destructive: true,
			}),
	});
	const agents = new StudioAgentHubService(
		registry,
		lifecycle,
		irc,
		{
			spawn: async request => {
				const effort = request.effort as TaskEffort | undefined;
				const isolation =
					request.isolation === undefined
						? undefined
						: { requested: true, merge: request.isolation as "patch" | "branch" };
				if (request.async === false) {
					const result = await runStructuredSubagent({
						session: toolSession,
						invocationKind: "task",
						assignment: request.assignment,
						agent: request.definition,
						...(request.context === undefined ? {} : { context: request.context }),
						...(effort === undefined ? {} : { effort }),
						...(isolation === undefined ? {} : { isolation }),
						keepAlive: true,
						shareEvalSession: true,
						enableLsp: session.settings.get("task.enableLsp") !== false,
					});
					return { agentId: result.result.id };
				}
				const task = await TaskTool.create(toolSession);
				const result = await task.execute(crypto.randomUUID(), {
					agent: request.definition,
					task: request.assignment,
					...(request.context === undefined ? {} : { context: request.context }),
					...(effort === undefined ? {} : { effort }),
					...(request.isolation === undefined ? {} : { isolated: true }),
				});
				const first = result.details?.progress?.[0] ?? result.details?.results?.[0];
				if (!first?.id) throw new Error("Task spawn did not return an agent identity");
				return {
					agentId: first.id,
					...(result.details?.async?.jobId === undefined ? {} : { jobId: result.details.async.jobId }),
				};
			},
		},
		{
			read: async ({ agentId, offset, limit }) => {
				const ref = registry.get(agentId);
				if (!ref) throw new Error("Unknown agent");
				const entries = ref.session
					? ref.session.sessionManager.getEntries()
					: ref.sessionFile
						? (await loadEntriesFromFile(ref.sessionFile)).filter(
								(entry): entry is SessionEntry => entry.type !== "session",
							)
						: [];
				const messages = entries.flatMap(entry => studioTranscriptMessage(entry));
				return { messages: messages.slice(offset, offset + limit), eof: offset + limit >= messages.length };
			},
		},
		{
			confirmationGate: async action =>
				await interaction.confirm({
					commandId: `agent.${action.kind}:${action.agentId}`,
					title: action.kind === "kill" ? "Kill agent?" : "Release agent?",
					message: `${action.kind === "kill" ? "Kill" : "Release"} agent ${action.agentId}?`,
					destructive: true,
				}),
			activeJobIdsFor: agentId =>
				jobsPort
					.getAllJobs()
					.filter(job => job.agentId === agentId && job.status === "running")
					.map(job => job.id),
			telemetry: createStudioAgentTelemetry(registry),
		},
	);
	const transcript = new StudioSessionTranscriptService(() => ({
		runtimeEpoch: bridgeConfig.runtimeEpoch as number,
		sessionId: session.sessionManager.getSessionId(),
		sessionManager: session.sessionManager,
	}));
	const createConversationProjector = (target: AgentSession, runtimeEpoch: number): ConversationLiveProjector => {
		const manager = target.sessionManager;
		const projector = new ConversationLiveProjector({
			sessionId: manager.getSessionId(),
			runtimeEpoch,
			reserveMessageId: input => {
				if (typeof manager.reserveMessageId === "function") return manager.reserveMessageId(input.role);
				return crypto.randomUUID().slice(-8);
			},
			reserveCompactionId: () => {
				if (typeof manager.reserveCompactionId === "function") return manager.reserveCompactionId();
				return crypto.randomUUID().slice(-8);
			},
			releaseCompactionId: id => {
				if (typeof manager.releaseCompactionId === "function") manager.releaseCompactionId(id);
			},
			lookupPersistedCompactionId: ({ summary }) => {
				if (typeof manager.getBranch !== "function") return undefined;
				const branch = manager.getBranch();
				for (let index = branch.length - 1; index >= 0; index--) {
					const entry = branch[index];
					if (entry.type === "compaction" && entry.summary === summary) return entry.id;
				}
				return undefined;
			},
		});
		projector.bind(target);
		return projector;
	};
	const mainConversation = createConversationProjector(session, bridgeConfig.runtimeEpoch as number);
	const conversation = new ConversationProjectorHub({
		main: mainConversation,
		registry,
		runtimeEpoch: () => bridgeConfig.runtimeEpoch as number,
		createChild: ref =>
			ref.session === null
				? undefined
				: createConversationProjector(ref.session, bridgeConfig.runtimeEpoch as number),
	});
	const agentConversation = new StudioAgentConversationService({
		registry,
		runtimeEpoch: () => bridgeConfig.runtimeEpoch as number,
	});
	const shutdownSignal = Promise.withResolvers<void>();
	let shutdownRequested = false;
	let disposed = false;
	const unsubscribeSessionChange =
		typeof session.registerSessionChangeCallback === "function"
			? session.registerSessionChangeCallback(() => {
					if (typeof session.sessionManager.clearReservedMessageIds === "function") {
						session.sessionManager.clearReservedMessageIds();
					}
					mainConversation.rebind(session, {
						sessionId: session.sessionManager.getSessionId(),
						runtimeEpoch: bridgeConfig.runtimeEpoch as number,
					});
					void hydratePersistedStudioAgents(registry, sessionFileOf(session), () => !disposed);
				})
			: () => {};
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_end") loop.scheduleNext();
	});
	return Object.freeze({
		runtimeId: createRuntimeId(),
		runtimeEpoch: bridgeConfig.runtimeEpoch as number,
		get sessionId() {
			return session.sessionManager.getSessionId();
		},
		session,
		sessionManager: session.sessionManager,
		services: Object.freeze({
			pause: studioPauseService,
			loop,
			live,
			modes,
			models,
			permissions,
			tree,
			fork,
			handoff,
			fastPrewalk,
			commands,
			btw,
			interaction,
			omfg,
			tan,
			agents,
			jobs,
			transcript,
			agentConversation,
			conversation,
		}),
		bridgeConfig: Object.freeze({ ...bridgeConfig }),
		waitForShutdown: () => shutdownSignal.promise,
		requestShutdown: () => {
			if (shutdownRequested) return;
			shutdownRequested = true;
			shutdownSignal.resolve();
		},
		dispose: () => {
			if (disposed) return;
			disposed = true;
			session.setBeforeNextUserTurn(undefined);
			unsubscribe();
			unsubscribeSessionChange();
			conversation.dispose();
			if (typeof session.sessionManager.clearReservedMessageIds === "function") {
				session.sessionManager.clearReservedMessageIds();
			}
			loop.dispose();
			live.dispose();
			modes.dispose();
			btw.dispose();
			agents.dispose();
		},
	});
}

export async function runStudioHostMode(
	session: AgentSession,
	bridgeConfig: StudioBridgeConfiguration,
	runTui: StudioHostTuiRunner,
	dependencies: StudioHostModeDependencies = {},
): Promise<void> {
	const bridge = dependencies.createBridge?.() ?? createConfiguredBridge(bridgeConfig);
	const runtime = createStudioHostRuntime(
		session,
		bridgeConfig,
		dependencies.createRuntimeId,
		dependencies.tanCustomTools,
		dependencies.liveSessionFactory,
	);
	const unregisterCleanup = postmortem.register(`studio-host-bridge:${runtime.runtimeId}`, () => bridge.stop());

	try {
		await hydratePersistedStudioAgents(AgentRegistry.global(), sessionFileOf(session));
		await runtime.services.commands.refresh();
		await bridge.start(runtime);
		// Install the Remote UI factory so Ask / tool dialogs surface as
		// interaction cards on the Bridge (plan §2.5). The interactive TUI
		// branch (TTY) replaces it with its own UIContext when it starts.
		dependencies.setToolUIContext?.(createStudioRemoteUiFactory(runtime.services.interaction), true);
		await runTui(runtime);
	} finally {
		unregisterCleanup();
		try {
			await bridge.stop();
		} finally {
			// Invalidate the factory so late tool contexts fail closed instead
			// of opening interactions on a dead bridge.
			dependencies.setToolUIContext?.(undefined, false);
			runtime.dispose();
		}
	}
}
