/**
 * Presentation-neutral Studio TAN backend service (WP-042).
 *
 * Extracts the native business flow behind `TanCommandController` (fork the
 * persisted parent session, create an isolated background agent, adopt it into
 * the agent registry, register a `task` async job, dispatch the work) into a
 * service that only depends on narrow injected ports. There is no
 * `InteractiveModeContext` / TUI dependency: every side effect (fork,
 * agent creation, registry, jobs, delivery, cleanup) arrives through
 * {@link StudioTanPorts}.
 *
 * The outward API is opaque: `start` and the `get`/`list` views never expose
 * session file paths or provider-facing session ids. Terminal job state lives
 * in the injected async job manager; this service keeps only a path-free
 * started-index (see {@link StudioTanService.get}) and never fabricates
 * completions.
 */
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import type { ToolDefinition } from "../../extensibility/extensions";
import type { LocalProtocolOptions } from "../../internal-urls";
import tanContextSwitchPrompt from "../../prompts/system/tan-context-switch.md" with { type: "text" };
import type { AgentRegistry } from "../../registry/agent-registry";
import type { AgentSession } from "../../session/agent-session";
import type { AuthStorage } from "../../session/auth-storage";
import type { SessionManager } from "../../session/session-manager";
import { createSubagentSettings } from "../../task/executor";
import type { ConfiguredThinkingLevel } from "../../thinking";

const TAN_LABEL_PREVIEW_LENGTH = 80;

/** Upper bound (characters) for the TAN work text. */
export const MAX_TAN_WORK_LENGTH = 80_000;

/**
 * Custom-entry type used to persist an empty todo list on the tan clone so
 * reloads agree with the cleared runtime state. Local mirror of
 * `USER_TODO_EDIT_CUSTOM_TYPE` (`src/tools/todo.ts`) so this
 * presentation-neutral service does not pull TUI modules into its graph.
 */
const TAN_TODO_CLEAR_CUSTOM_TYPE = "user_todo_edit";

function previewWork(work: string): string {
	const singleLine = work.trim().replace(/\s+/g, " ");
	if (singleLine.length <= TAN_LABEL_PREVIEW_LENGTH) return singleLine;
	return `${singleLine.slice(0, TAN_LABEL_PREVIEW_LENGTH - 1)}…`;
}

function extractAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter(content => content.type === "text")
		.map(content => content.text)
		.join("")
		.trim();
}

export type StudioTanErrorCode = "INVALID_ARGUMENT" | "COMMAND_BLOCKED" | "BUSY_STREAMING" | "INTERNAL_ERROR";

export class StudioTanError extends Error {
	constructor(
		readonly code: StudioTanErrorCode,
		message: string,
	) {
		super(message);
		this.name = "StudioTanError";
	}
}

export type StudioTanJobStatus = "running" | "completed" | "failed" | "cancelled";

/** Path-free service-level view of a started TAN job. */
export interface StudioTanJobView {
	jobId: string;
	agentId: string;
	status: StudioTanJobStatus;
}

export interface StudioTanStartResult {
	jobId: string;
	agentId: string;
	status: "running";
}

/**
 * Snapshot of the parent session identity/model/settings captured at
 * construction time. `model` and `parentFile` are optional because `start`
 * rejects when the parent has no persisted session or active model.
 */
export interface StudioTanParentContext {
	/** Provider-facing id of the parent session (never leaked outward). */
	sessionId: string;
	/** Provider prompt-cache key the parent populated (falls back to sessionId). */
	promptCacheKey: string;
	/** Agent-registry id of the owning agent (falls back to `MAIN_AGENT_ID`). */
	ownerId: string;
	/** True while the parent session is streaming a response. */
	isStreaming: boolean;
	/** Active parent model; `start` rejects when absent. */
	model: Model | undefined;
	/** Model registry of the parent session (owns `authStorage`). */
	modelRegistry: ModelRegistry;
	/** Auth storage of the parent's model registry. */
	authStorage: AuthStorage;
	/** Snapshot of the parent's rendered system prompt. */
	systemPrompt: string[];
	/** Snapshot of the parent's active tool names. */
	toolNames: string[];
	/** Parent thinking level forwarded to the clone. */
	thinkingLevel: ConfiguredThinkingLevel;
	/** Parent settings used to derive subagent settings. */
	settings: Settings;
	/** LSP enabled flag (`settings.get("task.enableLsp") !== false`). */
	enableLsp: boolean;
	/** Optional MCP proxy custom tools snapshot. */
	customTools?: (CustomTool | ToolDefinition)[];
	/** Persisted parent session file; `start` rejects when absent. */
	parentFile: string | undefined;
	/** Working directory of the parent session. */
	cwd: string;
	/** Directory that hosts the nested clone session file (parent session dir). */
	sessionDir: string;
	/** Artifacts dir of the parent session (may be null). */
	artifactsDir: string | null;
	/** Session-manager id used for the `local://` root snapshot. */
	parentLocalSessionId: string;
}

export interface StudioTanForkInput {
	parentFile: string;
	cwd: string;
	sessionDir: string;
	cloneFile: string;
}

/**
 * Fork the persisted parent session into a new clone manager. The
 * implementation must ensure the parent file is flushed before forking.
 */
export type StudioTanForkPort = (input: StudioTanForkInput) => Promise<SessionManager>;

/** Options forwarded to the agent creator; mirrors `sdk.createAgentSession`. */
export interface StudioTanCreateAgentOptions {
	cwd: string;
	sessionManager: SessionManager;
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel;
	systemPrompt: string[];
	toolNames: string[];
	providerSessionId: string;
	providerPromptCacheKey: string;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	settings: Settings;
	hasUI: false;
	enableMCP: false;
	customTools?: (CustomTool | ToolDefinition)[];
	enableLsp: boolean;
	agentId: string;
	agentDisplayName: "tan";
	parentTaskPrefix: string;
	parentAgentId: string;
	/** The registry the created agent must be registered into exactly once. */
	agentRegistry: AgentRegistry;
	disableExtensionDiscovery: true;
	localProtocolOptions: LocalProtocolOptions;
}

export interface StudioTanCreatedAgent {
	session: AgentSession;
	sessionFile: string | null;
}

export type StudioTanCreateAgentPort = (options: StudioTanCreateAgentOptions) => Promise<StudioTanCreatedAgent>;

export interface StudioTanAdoptInput {
	agentId: string;
	displayName: string;
	parentId: string;
	session: AgentSession;
	sessionFile: string | null;
}

/**
 * Adopt the created agent into the registry exactly once. The wiring may
 * implement this as a registry register + attach; when the agent creator
 * already registered the ref, a re-attach must be idempotent. Returns false
 * when the adoption is refused.
 */
export type StudioTanAdoptPort = (input: StudioTanAdoptInput) => boolean;

export interface StudioTanJobRunContext {
	jobId: string;
	signal: AbortSignal;
	reportProgress: (text: string, details?: Record<string, unknown>) => Promise<void>;
	markRunning: () => void;
}

/** Narrow structural subset of `AsyncJobManager.register`. */
export interface StudioTanJobManagerPort {
	register(
		type: "task",
		label: string,
		run: (ctx: StudioTanJobRunContext) => Promise<string>,
		options: { ownerId: string; agentId: string },
	): string;
}

export interface StudioTanDeliverInput {
	jobId: string;
	work: string;
}

/**
 * Presentation-neutral dispatch notice. The wiring decides how to surface
 * it (breadcrumb, bridge event, ...). Receives no paths or provider ids.
 */
export type StudioTanDeliveryPort = (input: StudioTanDeliverInput) => void | Promise<void>;

/**
 * Best-effort reverse-order cleanup callbacks. Each callback must be
 * idempotent and must not throw (a failing step must not mask the original
 * error). Invoked in reverse creation order: job, agent, session, fork files.
 */
export interface StudioTanCleanupPorts {
	cancelJob(jobId: string): void | Promise<void>;
	unregisterAgent(agentId: string): void | Promise<void>;
	disposeSession(session: AgentSession): void | Promise<void>;
	removeCloneFiles(cloneFile: string): void | Promise<void>;
}

export interface StudioTanPorts {
	parent: StudioTanParentContext;
	fork: StudioTanForkPort;
	createAgent: StudioTanCreateAgentPort;
	adopt: StudioTanAdoptPort;
	jobManager: StudioTanJobManagerPort;
	/**
	 * The agent registry the created agent is registered into and whose
	 * lifecycle (park/abort/detach) the TAN run drives. The wiring passes the
	 * same instance the agent creator registers into, typically
	 * `AgentRegistry.global()`.
	 */
	registry: AgentRegistry;
	deliver: StudioTanDeliveryPort;
	cleanup: StudioTanCleanupPorts;
}

/**
 * Presentation-neutral Studio TAN backend service (WP-042).
 *
 * One instance is constructed per parent session with explicit ports. `start`
 * is fail-closed: it validates the work and the parent state, forks exactly
 * once, creates exactly one isolated background agent, adopts it exactly once,
 * registers exactly one `task` async job, and returns an opaque running
 * handle. Any seam failure rolls back the resources created so far in reverse
 * order through the injected cleanup callbacks.
 */
export class StudioTanService {
	readonly #ports: StudioTanPorts;
	readonly #started = new Map<string, StudioTanJobView>();
	#preparing = false;

	constructor(ports: StudioTanPorts) {
		this.#ports = ports;
	}

	/**
	 * Start a background TAN for `work`. Returns only the opaque running
	 * handle; the terminal outcome lives in the async job manager.
	 */
	async start(work: string): Promise<StudioTanStartResult> {
		const trimmedWork = work.trim();
		if (!trimmedWork) {
			throw new StudioTanError("INVALID_ARGUMENT", "TAN work must not be empty");
		}
		if (trimmedWork.length > MAX_TAN_WORK_LENGTH) {
			throw new StudioTanError("INVALID_ARGUMENT", `TAN work exceeds the ${MAX_TAN_WORK_LENGTH} character limit`);
		}
		if (this.#preparing) {
			throw new StudioTanError("COMMAND_BLOCKED", "Another TAN start is already being prepared");
		}

		const parent = this.#ports.parent;
		if (parent.isStreaming) {
			throw new StudioTanError("BUSY_STREAMING", "Cannot start a TAN while the parent session is streaming");
		}
		if (parent.parentFile === undefined) {
			throw new StudioTanError("COMMAND_BLOCKED", "TAN requires a persisted parent session");
		}
		if (parent.model === undefined) {
			throw new StudioTanError("COMMAND_BLOCKED", "No active model is available for TAN");
		}

		this.#preparing = true;
		const settings = createSubagentSettings(parent.settings);
		const cloneId = `Tan-${Snowflake.next()}`;
		const cloneFile = path.join(parent.sessionDir, `${cloneId}.jsonl`);
		const label = `/tan ${previewWork(trimmedWork)}`;
		const localProtocolOptions: LocalProtocolOptions = {
			getArtifactsDir: () => parent.artifactsDir,
			getSessionId: () => parent.parentLocalSessionId,
		};

		let jobId: string | undefined;
		let created: StudioTanCreatedAgent | undefined;
		try {
			const cloneManager = await this.#ports.fork({
				parentFile: parent.parentFile,
				cwd: parent.cwd,
				sessionDir: parent.sessionDir,
				cloneFile,
			});
			created = await this.#ports.createAgent({
				cwd: parent.cwd,
				sessionManager: cloneManager,
				model: parent.model,
				thinkingLevel: parent.thinkingLevel,
				systemPrompt: parent.systemPrompt,
				toolNames: parent.toolNames,
				providerSessionId: `${parent.sessionId}:tan:${Snowflake.next()}`,
				providerPromptCacheKey: parent.promptCacheKey,
				modelRegistry: parent.modelRegistry,
				authStorage: parent.authStorage,
				settings,
				hasUI: false,
				enableMCP: false,
				customTools: parent.customTools,
				enableLsp: parent.enableLsp,
				agentId: cloneId,
				agentDisplayName: "tan",
				parentTaskPrefix: cloneId,
				parentAgentId: parent.ownerId,
				agentRegistry: this.#ports.registry,
				disableExtensionDiscovery: true,
				localProtocolOptions,
			});
			const session = created.session;
			const adopted = this.#ports.adopt({
				agentId: cloneId,
				displayName: "tan",
				parentId: parent.ownerId,
				session,
				sessionFile: created.sessionFile,
			});
			if (!adopted) {
				throw new Error("TAN agent adoption failed");
			}
			jobId = this.#ports.jobManager.register(
				"task",
				label,
				ctx => this.#run(cloneId, session, cloneManager, trimmedWork, parent, ctx),
				{ ownerId: parent.ownerId, agentId: cloneId },
			);
			this.#started.set(jobId, { jobId, agentId: cloneId, status: "running" });
			await this.#ports.deliver({ jobId, work: trimmedWork });
			return { jobId, agentId: cloneId, status: "running" };
		} catch (error) {
			if (jobId !== undefined) this.#started.delete(jobId);
			await this.#rollback(jobId, created, cloneId, cloneFile);
			if (error instanceof StudioTanError) throw error;
			throw new StudioTanError("INTERNAL_ERROR", "TAN could not be started");
		} finally {
			this.#preparing = false;
		}
	}

	/** Path-free view of a started TAN job, or undefined when unknown. */
	get(jobId: string): StudioTanJobView | undefined {
		const view = this.#started.get(jobId);
		return view === undefined ? undefined : { ...view };
	}

	/** Path-free views of all TAN jobs started through this service. */
	list(): StudioTanJobView[] {
		return [...this.#started.values()].map(view => ({ ...view }));
	}

	/**
	 * Body of the registered `task` job: run the isolated clone headlessly,
	 * then park the agent ref (or leave an aborted tombstone on cancel).
	 */
	async #run(
		agentId: string,
		clone: AgentSession,
		cloneManager: SessionManager,
		work: string,
		parent: StudioTanParentContext,
		ctx: StudioTanJobRunContext,
	): Promise<string> {
		const view = this.#started.get(ctx.jobId);
		try {
			if (ctx.signal.aborted) throw new Error("Aborted before execution");
			clone.sessionManager?.appendSessionInit?.({
				systemPrompt: clone.systemPrompt ? clone.systemPrompt.join("\n\n") : parent.systemPrompt.join("\n\n"),
				task: work,
				tools: clone.getActiveToolNames ? clone.getActiveToolNames() : parent.toolNames,
			});
			const abortClone = () => {
				void clone.abort();
			};
			ctx.signal.addEventListener("abort", abortClone, { once: true });
			// The fork inherits the parent's todo list via session entries; its
			// reminders would drag the tan back onto the parent's task. Clear
			// runtime state and persist an empty edit so reloads agree.
			clone.setTodoPhases([]);
			cloneManager.appendCustomEntry(TAN_TODO_CLEAR_CUSTOM_TYPE, { phases: [] });
			const injectContextSwitch = () => {
				clone.agent.appendMessage({
					role: "developer",
					content: tanContextSwitchPrompt,
					attribution: "agent",
					timestamp: Date.now(),
				});
			};
			// Compaction summarizes the fork notice away with the rest of the
			// history; re-inject after every successful compaction so the fork
			// boundary survives summarization.
			const unsubscribeCompaction = clone.subscribe(event => {
				if (event.type === "auto_compaction_end" && event.result && !event.aborted) {
					injectContextSwitch();
				}
			});
			try {
				if (ctx.signal.aborted) {
					abortClone();
					throw new Error("Aborted before execution");
				}
				injectContextSwitch();
				await clone.prompt(work, { attribution: "user" });
				await clone.waitForIdle();
				const text = extractAssistantText(clone.getLastAssistantMessage()) || "(no output)";
				if (view) view.status = "completed";
				return text;
			} finally {
				unsubscribeCompaction();
				ctx.signal.removeEventListener("abort", abortClone);
			}
		} catch (error) {
			if (view) view.status = ctx.signal.aborted ? "cancelled" : "failed";
			throw error;
		} finally {
			if (ctx.signal.aborted) {
				// An aborted tan is terminal — leave the tombstone, let the
				// job manager's dispose path unregister it.
				this.#ports.registry.setStatus(agentId, "aborted");
				await clone.dispose();
			} else {
				// Keep the finished tan in the Agent Hub: flip the ref to parked
				// BEFORE dispose so the sdk dispose wrapper skips its unregister,
				// then detach so the hub sees a transcript-only parked agent.
				this.#ports.registry.setStatus(agentId, "parked");
				await clone.dispose();
				this.#ports.registry.detachSession(agentId);
			}
		}
	}

	/** Best-effort reverse-order rollback of the resources created so far. */
	async #rollback(
		jobId: string | undefined,
		created: StudioTanCreatedAgent | undefined,
		agentId: string,
		cloneFile: string,
	): Promise<void> {
		const steps: Array<() => void | Promise<void>> = [];
		if (jobId !== undefined) steps.push(() => this.#ports.cleanup.cancelJob(jobId));
		if (created !== undefined) {
			const session = created.session;
			steps.push(() => this.#ports.cleanup.unregisterAgent(agentId));
			steps.push(() => this.#ports.cleanup.disposeSession(session));
		}
		steps.push(() => this.#ports.cleanup.removeCloneFiles(cloneFile));
		for (const step of steps) {
			try {
				await step();
			} catch {
				// Best-effort: a failed cleanup step must not mask the original error.
			}
		}
	}
}
