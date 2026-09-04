import { logger } from "@oh-my-pi/pi-utils";
import {
	type StudioEventEnvelope,
	type StudioInteractionRequiredEvent,
	type StudioInteractionResolvedEvent,
	type StudioOperatorStateSnapshot,
	type StudioPendingInteraction,
	type StudioReceipt,
	type StudioSessionTelemetry,
	type StudioSnapshotResponse,
	stableImplementedManifestHash,
} from "./bridge-protocol";
import type { ConversationRuntimeEvent } from "./conversation-protocol";
import { CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION } from "./conversation-protocol";
import type { StudioBtwSnapshot } from "./services/btw-service";
import type { StudioLiveService } from "./services/live-service";
import type { StudioLoopService } from "./services/loop-service";
import type { StudioModeControlService } from "./services/mode-control-service";
import type { StudioPauseService } from "./services/pause-service";
import { StudioSessionTranscriptService } from "./services/session-transcript-service";
import { buildStudioSessionTelemetry } from "./session-telemetry";
import type { StudioHostRuntime } from "./studio-host-mode";

function conversationAdvancesStateVersion(kind: ConversationRuntimeEvent["kind"]): boolean {
	if (kind === "conversation.message.delta") return CONVERSATION_MESSAGE_DELTA_INCREMENTS_STATE_VERSION;
	return (
		kind === "conversation.message.completed" ||
		kind === "conversation.tool.completed" ||
		kind === "conversation.turn.completed" ||
		kind === "conversation.turn.aborted" ||
		kind === "conversation.compaction.completed"
	);
}

function goalStatus(status: string): "off" | "active" | "paused" | "complete" {
	switch (status) {
		case "active":
			return "active";
		case "paused":
		case "budget-limited":
			return "paused";
		case "complete":
			return "complete";
		default:
			return "off";
	}
}

function cloneSnapshot(snapshot: StudioOperatorStateSnapshot): StudioOperatorStateSnapshot {
	return structuredClone(snapshot);
}

/**
 * Equality key for `commitStateChange`. `stateVersion` is normalized out
 * because the commit is what bumps it: keeping it would make every key differ
 * from the previously committed one and turn the equality check into a no-op.
 * One serialization per call, cached next to `#committedSnapshot`, replaces the
 * two `JSON.stringify` passes this comparison used to cost — the path runs
 * several times a second while subagents stream.
 */
function stateComparisonKey(snapshot: StudioOperatorStateSnapshot): string {
	return JSON.stringify({ ...snapshot, stateVersion: 0 });
}

const PLAN_BODY_MAX_CHARS = 32 * 1024;

interface SessionTitlePort {
	getSessionName?: () => string | undefined;
	readonly titleSource?: "user" | "auto";
	onSessionNameChanged?: (listener: () => void) => () => void;
}

function truncatePlanBody(body: string): string {
	return body.length <= PLAN_BODY_MAX_CHARS ? body : body.slice(0, PLAN_BODY_MAX_CHARS);
}

export class StudioStateProjector {
	readonly #runtime: StudioHostRuntime;
	readonly #pauseService: StudioPauseService;
	readonly #loopService: StudioLoopService;
	readonly #liveService: StudioLiveService;
	readonly #modeService: StudioModeControlService;
	readonly #listeners = new Set<(event: StudioEventEnvelope) => void>();
	readonly #terminalReceipts: StudioReceipt[] = [];
	readonly #unsubscribePause: () => void;
	readonly #unsubscribeLoop: () => void;
	readonly #unsubscribeLive: () => void;
	readonly #unsubscribeModes: () => void;
	readonly #unsubscribeModel: () => void;
	readonly #unsubscribeTaskModel: () => void;
	readonly #unsubscribeAgents: () => void;
	#unsubscribeJobs: () => void = () => {};
	readonly #unsubscribeSessionTitle: () => void;
	readonly #unsubscribeConversation: () => void;
	readonly #unsubscribeWorker: () => void;
	#committedSnapshot: StudioOperatorStateSnapshot | undefined;
	/**
	 * Change-detection key for `#committedSnapshot`, computed lazily so a commit
	 * driven by a conversation event never pays for a serialization no
	 * `commitStateChange` will read. `undefined` means "recompute on demand".
	 */
	#committedKey: string | undefined;
	#stateVersion = 0;
	#eventSeq = 0;
	#pendingInteraction: StudioPendingInteraction | undefined;
	#agentsRevision = 0;
	#jobsRevision = 0;
	#ownedTranscript: StudioSessionTranscriptService | undefined;
	#telemetryTimer: ReturnType<typeof setTimeout> | undefined;
	#telemetryInFlight = false;
	#telemetryQueued = false;
	#telemetrySnapshot: StudioSessionTelemetry;

	constructor(runtime: StudioHostRuntime) {
		this.#runtime = runtime;
		this.#pauseService = runtime.services.pause;
		this.#loopService = runtime.services.loop;
		this.#liveService = runtime.services.live;
		this.#modeService = runtime.services.modes;
		this.#telemetrySnapshot = this.#telemetry();
		this.#committedSnapshot = this.snapshot();
		this.#unsubscribePause = this.#pauseService.onChange(() => this.commitStateChange());
		this.#unsubscribeLoop = this.#loopService.onChange(() => this.commitStateChange());
		this.#unsubscribeLive = this.#liveService.onChange(() => this.commitStateChange());
		this.#unsubscribeModes = this.#modeService.onChange(() => this.commitStateChange());
		// The model pill must stay truthful no matter who switched: Bridge, the
		// `studio-host` TUI, a Plan-role transition, or a retry fallback.
		this.#unsubscribeModel =
			runtime.session.subscribe?.(event => {
				if (event.type === "model_changed" || event.type === "thinking_level_changed") this.commitStateChange();
			}) ?? (() => {});
		// Bridge-side Task subagent model switches carry their own signal; TUI
		// alt+p writes go through the settings override layer with no event and
		// surface on the next unrelated state commit instead.
		this.#unsubscribeTaskModel = runtime.services.models?.onChange(() => this.commitStateChange()) ?? (() => {});
		this.#unsubscribeAgents = runtime.services.agents.onChange(() => {
			this.#agentsRevision += 1;
			this.commitStateChange();
		});
		let unsubscribeJobManager = () => {};
		const bindJobManager = (): void => {
			unsubscribeJobManager();
			unsubscribeJobManager =
				runtime.session.asyncJobManager?.onChange(() => {
					this.#jobsRevision += 1;
					this.commitStateChange();
				}) ?? (() => {});
		};
		bindJobManager();
		this.#unsubscribeJobs = () => unsubscribeJobManager();
		const sessionManager = runtime.sessionManager as SessionTitlePort | undefined;
		const onSessionNameChanged = sessionManager?.onSessionNameChanged;
		this.#unsubscribeSessionTitle =
			typeof onSessionNameChanged === "function" && sessionManager !== undefined
				? onSessionNameChanged.call(sessionManager, () => this.commitStateChange())
				: () => {};
		this.#unsubscribeConversation =
			runtime.services.conversation?.onEvent(event => this.#emitConversation(event)) ?? (() => {});
		this.#unsubscribeWorker =
			runtime.onWorkerStateChange?.(() => {
				bindJobManager();
				this.commitStateChange();
			}) ?? (() => {});
	}

	get stateVersion(): number {
		return this.#stateVersion;
	}

	get lastEventSeq(): number {
		return this.#eventSeq;
	}

	snapshot(): StudioOperatorStateSnapshot {
		const workerResidency = this.#runtime.workerResidency?.() ?? "active";
		const workerGeneration = this.#runtime.workerGeneration?.() ?? 0;
		// A recycled Worker releases its in-memory transcript and closes its
		// SessionManager. Keep serving the last committed read model while the
		// old Worker is being torn down or revived (or after a failed recycle)
		// instead of dereferencing that terminal object.
		// The next state change still goes through commitStateChange and updates the
		// residency/generation fields monotonically.
		if (
			(workerResidency === "recycling" ||
				workerResidency === "reviving" ||
				workerResidency === "dormant" ||
				workerResidency === "failed") &&
			this.#committedSnapshot !== undefined
		) {
			return cloneSnapshot({
				...this.#committedSnapshot,
				workerResidency,
				workerGeneration,
				stateVersion: this.stateVersion,
			});
		}
		const sessionManager = this.#runtime.sessionManager as SessionTitlePort | undefined;
		const sessionTitle = sessionManager?.getSessionName?.();
		const modes = this.#modeService.state();
		const plan = modes.plan;
		const goal = modes.goal;
		const vibe = modes.vibe;
		const loop = this.#loopService.state();
		const live = this.#liveService.state();
		const model = this.#runtime.services.models?.state();
		const taskModel = this.#runtime.services.models?.taskState();
		const activeMode =
			goal?.status === "active"
				? "goal"
				: plan?.status === "active" || plan?.status === "review"
					? "plan"
					: vibe?.enabled
						? "vibe"
						: "normal";
		const snapshot: StudioOperatorStateSnapshot = {
			runtimeId: this.#runtime.runtimeId,
			runtimeEpoch: this.#runtime.runtimeEpoch,
			stateVersion: this.stateVersion,
			sessionId: this.#runtime.sessionId,
			workerResidency,
			workerGeneration,
			...(sessionTitle === undefined ? {} : { sessionTitle }),
			...(sessionManager?.titleSource === undefined ? {} : { sessionTitleSource: sessionManager.titleSource }),
			isStreaming: this.#runtime.session.isStreaming,
			isCompacting: this.#runtime.session.isCompacting,
			activeMode,
			approvalMode: this.#runtime.services.permissions?.state() ?? this.#approvalMode(),
			pause: this.#pauseService.state(),
			// Service- and projector-owned members go in by reference: the literal
			// is local and `cloneSnapshot` below deep-copies it before it escapes,
			// so cloning them here only copied the same bytes twice per snapshot.
			...(this.#pendingInteraction === undefined ? {} : { pendingInteraction: this.#pendingInteraction }),
			...(loop === undefined ? {} : { loop }),
			...(model === undefined ? {} : { model }),
			...(taskModel === undefined ? {} : { taskModel }),
			live,
			pendingMessages: this.#runtime.session.queuedMessageCount,
			activeCommandIds: [],
			agentsRevision: this.#agentsRevision,
			jobsRevision: this.#jobsRevision,
			agents: this.#runtime.services.agents.list({ includeTerminal: true, includePersisted: true }),
			jobs: this.#runtime.services.jobs.list({
				callerAgentId: this.#runtime.session.getAgentId() ?? "Main",
				includeRecent: true,
			}),
			telemetry: this.#telemetrySnapshot,
			...(this.#runtime.services.settings === undefined
				? {}
				: { runtimeSettings: this.#runtime.services.settings.snapshot() }),
			...(this.#runtime.session.compactionSpeculation === undefined
				? {}
				: { compactionSpeculation: this.#runtime.session.compactionSpeculation }),
		};
		if (plan !== undefined) {
			snapshot.plan = {
				status: plan.status,
				...(plan.planFilePath ? { planReference: plan.planFilePath } : {}),
				...(plan.title ? { title: plan.title } : {}),
				...(plan.body ? { body: truncatePlanBody(plan.body) } : {}),
			};
		}
		if (goal !== undefined) {
			snapshot.goal = {
				status: goalStatus(goal.status),
				objective: goal.objective ?? "",
				tokenBudget: goal.tokenBudget,
				tokensUsed: goal.tokensUsed ?? 0,
			};
		}
		if (vibe !== undefined) snapshot.vibe = { enabled: vibe.enabled, workerAgentIds: vibe.workerAgentIds };
		if (this.#runtime.session.isFastModeEnabled?.() === true) {
			snapshot.fast = {
				enabled: true,
				active: this.#runtime.session.isFastModeActive?.() === true,
			};
		}
		const prewalk = this.#runtime.session.getPrewalkState?.();
		if (prewalk?.target) {
			snapshot.prewalk = {
				status: "armed",
				target: `${prewalk.target.provider}/${prewalk.target.id}`,
			};
		}
		return cloneSnapshot(snapshot);
	}

	response(requestId: string): StudioSnapshotResponse {
		return {
			type: "studio.snapshot",
			requestId,
			snapshot: this.snapshot(),
			commandManifestHash: this.#runtime.services.commands.manifestHash(),
			capabilityHash: stableImplementedManifestHash("capabilities"),
			lastEventSeq: this.lastEventSeq,
			messagesCursor: this.#transcript().headCursor(),
			terminalReceipts: structuredClone(this.#terminalReceipts),
		};
	}

	onEvent(listener: (event: StudioEventEnvelope) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	recordTerminalReceipt(receipt: StudioReceipt): void {
		if (receipt.status !== "completed" && receipt.status !== "failed" && receipt.status !== "rejected") return;
		this.#terminalReceipts.push(structuredClone(receipt));
		if (this.#terminalReceipts.length > 128) this.#terminalReceipts.shift();
	}

	setPendingInteraction(pending: StudioPendingInteraction | undefined): void {
		this.#pendingInteraction = pending === undefined ? undefined : structuredClone(pending);
		this.commitStateChange();
	}

	emitInteractionRequired(eventBody: StudioInteractionRequiredEvent): void {
		this.#emitEvent(eventBody);
	}

	emitInteractionResolved(eventBody: StudioInteractionResolvedEvent): void {
		this.#emitEvent(eventBody);
	}

	emitBtwChanged(snapshot: StudioBtwSnapshot): void {
		this.#emitEvent({ kind: "btw.changed", snapshot: structuredClone(snapshot) });
	}

	emitRuntimeQuiescing(): void {
		this.#emitEvent({ kind: "runtime.quiescing" });
	}

	emitRuntimeShutdownComplete(): void {
		this.#emitEvent({ kind: "runtime.shutdownComplete" });
	}

	#transcript(): StudioSessionTranscriptService {
		if (this.#runtime.services.transcript !== undefined) return this.#runtime.services.transcript;
		if (this.#ownedTranscript === undefined) {
			this.#ownedTranscript = new StudioSessionTranscriptService(() => ({
				runtimeEpoch: this.#runtime.runtimeEpoch,
				sessionId: this.#runtime.sessionId,
				sessionManager: this.#runtime.sessionManager,
			}));
		}
		return this.#ownedTranscript;
	}

	/** Effective tool approval mode: runtime override layer first, then the persisted default. */
	#approvalMode(): "always-ask" | "write" | "yolo" {
		const settings = this.#runtime.session.settings;
		if (settings === undefined) return "yolo";
		const value = settings.get("tools.approvalMode");
		return value === "always-ask" || value === "write" || value === "yolo" ? value : "yolo";
	}

	#emitConversation(event: ConversationRuntimeEvent): void {
		const isMain = event.sessionId === this.#runtime.sessionId;
		const advances = isMain && conversationAdvancesStateVersion(event.kind);
		if (advances) {
			this.#stateVersion += 1;
			this.#committedSnapshot = this.snapshot();
			this.#committedKey = undefined;
		}
		this.#emitEvent(event);
		if (!isMain) return;
		if (
			event.kind === "conversation.message.completed" ||
			event.kind === "conversation.turn.completed" ||
			event.kind === "conversation.turn.aborted" ||
			event.kind === "conversation.compaction.completed"
		)
			this.#scheduleTelemetry(true);
		// A pure text delta cannot move any telemetry number a user can observe —
		// usage is accounted at message/turn/compaction terminals — so it must not
		// schedule a rebuild. Every other kind still does: tool boundaries and
		// notices can follow a context mutation.
		else if (event.kind !== "conversation.message.delta") this.#scheduleTelemetry(false);
		if (advances && this.#committedSnapshot !== undefined) {
			// No clone here: `#emitEvent` copies the body into the envelope and
			// `#notify` copies again per listener, so neither a listener nor the
			// envelope can reach `#committedSnapshot`.
			this.#emitEvent({ kind: "state.changed", snapshot: this.#committedSnapshot });
		}
	}

	#telemetry(): StudioSessionTelemetry {
		try {
			return buildStudioSessionTelemetry({
				sessionId: this.#runtime.sessionId,
				session: this.#runtime.session,
				capturedAt: new Date().toISOString(),
			});
		} catch (error) {
			logger.debug("Studio telemetry unavailable while Worker is not live", { error: String(error) });
			return (
				this.#telemetrySnapshot ?? {
					sessionId: this.#runtime.sessionId,
					capturedAt: new Date().toISOString(),
					tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
					context: null,
					unavailableReason: "model_context_unknown",
				}
			);
		}
	}

	#scheduleTelemetry(immediate: boolean): void {
		if (immediate) {
			if (this.#telemetryTimer !== undefined) clearTimeout(this.#telemetryTimer);
			this.#telemetryTimer = undefined;
			void this.#emitTelemetry();
			return;
		}
		if (this.#telemetryTimer !== undefined) return;
		this.#telemetryTimer = setTimeout(() => {
			this.#telemetryTimer = undefined;
			void this.#emitTelemetry();
		}, 250);
	}

	/**
	 * Recompute telemetry now and push `session.telemetry.changed`. Context
	 * mutations that finish without a following conversation turn (manual
	 * /compact, /clear, handoff) emit no AgentSessionEvent on the vendor side,
	 * so the cached snapshot would keep serving pre-mutation numbers until the
	 * next turn's conversation event recomputes it.
	 */
	refreshTelemetry(): void {
		this.#scheduleTelemetry(true);
	}

	async #emitTelemetry(): Promise<void> {
		if (this.#telemetryInFlight) {
			this.#telemetryQueued = true;
			return;
		}
		this.#telemetryInFlight = true;
		try {
			const telemetry = this.#telemetry();
			this.#telemetrySnapshot = structuredClone(telemetry);
			if (this.#committedSnapshot !== undefined) {
				this.#committedSnapshot = { ...this.#committedSnapshot, telemetry: structuredClone(telemetry) };
				this.#committedKey = undefined;
			}
			this.#emitEvent({ kind: "session.telemetry.changed", sessionId: this.#runtime.sessionId, telemetry });
		} finally {
			this.#telemetryInFlight = false;
			if (this.#telemetryQueued) {
				this.#telemetryQueued = false;
				this.#scheduleTelemetry(false);
			}
		}
	}

	#notify(event: StudioEventEnvelope): void {
		for (const listener of this.#listeners) {
			try {
				listener(structuredClone(event));
			} catch (error) {
				logger.warn("Studio state projector listener failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	#emitEvent(eventBody: StudioEventEnvelope["event"]): void {
		this.#eventSeq += 1;
		const event: StudioEventEnvelope = {
			type: "studio.event",
			runtimeEpoch: this.#runtime.runtimeEpoch,
			eventSeq: this.#eventSeq,
			stateVersion: this.#stateVersion,
			occurredAt: new Date().toISOString(),
			event: structuredClone(eventBody),
		};
		this.#notify(event);
	}

	dispose(): void {
		if (this.#telemetryTimer !== undefined) clearTimeout(this.#telemetryTimer);
		this.#telemetryTimer = undefined;
		this.#unsubscribePause();
		this.#unsubscribeLoop();
		this.#unsubscribeLive();
		this.#unsubscribeModes();
		this.#unsubscribeModel();
		this.#unsubscribeTaskModel();
		this.#unsubscribeAgents();
		this.#unsubscribeJobs();
		this.#unsubscribeSessionTitle();
		this.#unsubscribeConversation();
		this.#unsubscribeWorker();
		this.#listeners.clear();
	}

	/**
	 * Bump stateVersion/eventSeq and emit a state.changed event when the
	 * observable snapshot actually differs from the last committed one.
	 * Returns false (and emits nothing) when no observable change occurred.
	 */
	commitStateChange(): boolean {
		const snapshot = this.snapshot();
		const key = stateComparisonKey(snapshot);
		if (this.#committedSnapshot !== undefined) {
			this.#committedKey ??= stateComparisonKey(this.#committedSnapshot);
			if (key === this.#committedKey) return false;
		}
		this.#stateVersion += 1;
		snapshot.stateVersion = this.#stateVersion;
		this.#committedSnapshot = snapshot;
		this.#committedKey = key;
		// `#emitEvent` bumps eventSeq, stamps the envelope, and copies the body,
		// so the committed snapshot is never aliased into an emitted event.
		this.#emitEvent({ kind: "state.changed", snapshot });
		return true;
	}
}
