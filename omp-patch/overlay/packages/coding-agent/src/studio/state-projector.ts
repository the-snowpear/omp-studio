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

const PLAN_BODY_MAX_CHARS = 32 * 1024;

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
	readonly #unsubscribeAgents: () => void;
	readonly #unsubscribeJobs: () => void;
	readonly #unsubscribeConversation: () => void;
	#committedSnapshot: StudioOperatorStateSnapshot | undefined;
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
		this.#unsubscribeAgents = runtime.services.agents.onChange(() => {
			this.#agentsRevision += 1;
			this.commitStateChange();
		});
		this.#unsubscribeJobs =
			runtime.session.asyncJobManager?.onChange(() => {
				this.#jobsRevision += 1;
				this.commitStateChange();
			}) ?? (() => {});
		this.#unsubscribeConversation =
			runtime.services.conversation?.onEvent(event => this.#emitConversation(event)) ?? (() => {});
	}

	get stateVersion(): number {
		return this.#stateVersion;
	}

	get lastEventSeq(): number {
		return this.#eventSeq;
	}

	snapshot(): StudioOperatorStateSnapshot {
		const modes = this.#modeService.state();
		const plan = modes.plan;
		const goal = modes.goal;
		const vibe = modes.vibe;
		const loop = this.#loopService.state();
		const live = this.#liveService.state();
		const model = this.#runtime.services.models?.state();
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
			isStreaming: this.#runtime.session.isStreaming,
			isCompacting: this.#runtime.session.isCompacting,
			activeMode,
			approvalMode: this.#runtime.services.permissions?.state() ?? this.#approvalMode(),
			pause: this.#pauseService.state(),
			...(this.#pendingInteraction === undefined
				? {}
				: { pendingInteraction: structuredClone(this.#pendingInteraction) }),
			...(loop === undefined ? {} : { loop }),
			...(model === undefined ? {} : { model }),
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
			telemetry: structuredClone(this.#telemetrySnapshot),
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
		else this.#scheduleTelemetry(false);
		if (advances && this.#committedSnapshot !== undefined) {
			this.#emitEvent({ kind: "state.changed", snapshot: structuredClone(this.#committedSnapshot) });
		}
	}

	#telemetry(): StudioSessionTelemetry {
		return buildStudioSessionTelemetry({
			sessionId: this.#runtime.sessionId,
			session: this.#runtime.session,
			capturedAt: new Date().toISOString(),
		});
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

	async #emitTelemetry(): Promise<void> {
		if (this.#telemetryInFlight) {
			this.#telemetryQueued = true;
			return;
		}
		this.#telemetryInFlight = true;
		try {
			const telemetry = this.#telemetry();
			this.#telemetrySnapshot = structuredClone(telemetry);
			if (this.#committedSnapshot !== undefined)
				this.#committedSnapshot = { ...this.#committedSnapshot, telemetry: structuredClone(telemetry) };
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
		this.#unsubscribeAgents();
		this.#unsubscribeJobs();
		this.#unsubscribeConversation();
		this.#listeners.clear();
	}

	/**
	 * Bump stateVersion/eventSeq and emit a state.changed event when the
	 * observable snapshot actually differs from the last committed one.
	 * Returns false (and emits nothing) when no observable change occurred.
	 */
	commitStateChange(): boolean {
		const snapshot = this.snapshot();
		if (
			this.#committedSnapshot !== undefined &&
			JSON.stringify(snapshot) === JSON.stringify(this.#committedSnapshot)
		) {
			return false;
		}
		this.#stateVersion += 1;
		this.#eventSeq += 1;
		snapshot.stateVersion = this.#stateVersion;
		this.#committedSnapshot = snapshot;
		const event: StudioEventEnvelope = {
			type: "studio.event",
			runtimeEpoch: this.#runtime.runtimeEpoch,
			eventSeq: this.#eventSeq,
			stateVersion: this.#stateVersion,
			occurredAt: new Date().toISOString(),
			event: { kind: "state.changed", snapshot: structuredClone(snapshot) },
		};
		this.#notify(event);
		return true;
	}
}
