import { isEvaluationOperationKind } from "./evaluation-validation";
import type { EvaluationOperation } from "./evaluation-protocol";
import { StudioEvaluationError } from "./services/evaluation-service";
import * as crypto from "node:crypto";
import type { StudioEventEnvelope, StudioProtocolError, StudioReceipt, StudioRequest } from "./bridge-protocol";
import { StudioRuntimeCommandArbiter, StudioRuntimeCommandError } from "./command-arbiter";
import { StudioAgentConversationError } from "./services/agent-conversation-service";
import { StudioAgentHubError } from "./services/agent-hub-service";
import { StudioBtwError } from "./services/btw-service";
import { StudioCommandManifestError } from "./services/command-manifest-service";
import { StudioFastPrewalkError } from "./services/fast-prewalk-service";
import { StudioForkError } from "./services/fork-service";
import { StudioHandoffError } from "./services/handoff-service";
import { StudioInteractionError, StudioRemoteInteractionPort } from "./services/interaction-port";
import { StudioJobError } from "./services/job-service";
import { StudioLiveError } from "./services/live-service";
import { StudioLoopError } from "./services/loop-service";
import { StudioModeError } from "./services/mode-control-service";
import { StudioModelControlError } from "./services/model-control-service";
import { StudioOmfgError } from "./services/omfg-service";
import { StudioPauseError } from "./services/pause-service";
import { StudioPermissionControlError, StudioPermissionControlService } from "./services/permission-control-service";
import { StudioRuntimeSettingsError } from "./services/runtime-settings-service";
import { SessionControlError, SessionControlService } from "./services/session-control-service";
import { StudioSessionTranscriptError, StudioSessionTranscriptService } from "./services/session-transcript-service";
import { expandSkillPrompts } from "./services/skill-prompt-expansion";
import { StudioTanError } from "./services/tan-service";
import { StudioTreeError } from "./services/tree-service";
import type { StudioStateProjector } from "./state-projector";
import type { StudioHostRuntime } from "./studio-host-mode";

export type StudioBridgeSend = (
	frameId: string,
	body: StudioReceipt | ReturnType<StudioStateProjector["response"]> | StudioEventEnvelope,
) => void;

interface RememberedReceipt {
	operation: string;
	receipt: StudioReceipt;
}

const SESSION_CONTROL_OPERATION_KINDS = new Set<string>([
	"runtime.shutdown",
	"runtime.settings.get",
	"runtime.settings.set",
	"live.start",
	"live.stop",
	"queue.enqueue",
	"session.clearContext",
	"session.drop",
	"turn.retry",
	"core.prompt",
	"core.steer",
	"core.followUp",
	"core.abort",
	"loop.enable",
	"loop.pause",
	"loop.disable",
	"mode.plan.enter",
	"mode.plan.exit",
	"mode.plan.review.open",
	"mode.plan.review.saveAndQuit",
	"mode.plan.review.respond",
	"mode.vibe.enter",
	"mode.vibe.exit",
	"goal.create",
	"goal.replace",
	"goal.show",
	"goal.setBudget",
	"goal.pause",
	"goal.resume",
	"goal.drop",
	"goal.guided.start",
	"btw.ask",
	"btw.abort",
	"btw.branch",
	"tan.start",
	"omfg.generate",
	"omfg.amend",
	"omfg.commit",
	"agent.list",
	"agent.get",
	"agent.spawn",
	"agent.send",
	"agent.kill",
	"agent.revive",
	"agent.release",
	"agent.transcript.read",
	"agent.subscribe",
	"job.list",
	"job.get",
	"job.cancel",
	"job.subscribe",
	"session.tree.get",
	"session.tree.navigate",
	"session.tree.branch",
	"session.fork",
	"session.handoff",
	"session.fast.set",
	"session.prewalk.arm",
	"session.prewalk.disarm",
	"session.model.set",
	"session.thinking.set",
	"session.taskModel.set",
	"operator.manifest.get",
	"operator.invoke",
	"permissions.mode.set",
]);

function operationSignature(request: StudioRequest): string {
	return JSON.stringify(request.operation);
}

function protocolError(error: unknown): StudioProtocolError {
	if (error instanceof StudioEvaluationError) return { code: error.code, message: error.message, retryable: false };
	if (error instanceof StudioRuntimeCommandError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioPauseError) {
		return {
			code: error.code === "STALE_PAUSE_EPOCH" ? "STATE_VERSION_CONFLICT" : "COMMAND_BLOCKED",
			message: error.message,
			retryable: false,
			details: { reason: error.code },
		};
	}
	if (error instanceof SessionControlError) {
		return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
	}
	if (error instanceof StudioLoopError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioLiveError) {
		return {
			code: error.code,
			message: error.message,
			retryable: false,
			...(error.code === "CAPABILITY_UNAVAILABLE" ? { details: { reason: "MEDIA_SIDEBAND_UNAVAILABLE" } } : {}),
		};
	}
	if (
		error instanceof StudioModeError ||
		error instanceof StudioRuntimeSettingsError ||
		error instanceof StudioForkError ||
		error instanceof StudioHandoffError ||
		error instanceof StudioModelControlError ||
		error instanceof StudioPermissionControlError ||
		error instanceof StudioFastPrewalkError
	) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioTreeError) {
		return { code: error.code, message: error.message, retryable: false, details: error.details };
	}
	if (error instanceof StudioCommandManifestError) {
		return { code: error.code, message: error.message, retryable: false, details: error.details };
	}
	if (error instanceof StudioInteractionError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioBtwError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioOmfgError) {
		return {
			code: error.code,
			message: error.message,
			retryable: false,
			...(error.partial ? { details: { partial: true } } : {}),
		};
	}
	if (error instanceof StudioTanError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioAgentHubError) {
		const code =
			error.code === "AGENT_GENERATION_CONFLICT"
				? "AGENT_GENERATION_CONFLICT"
				: error.code === "NOT_OWNER"
					? "NOT_OWNER"
					: error.code === "INVALID_ARGUMENT" || error.code === "INVALID_CURSOR"
						? "INVALID_ARGUMENT"
						: error.code === "STALE_CURSOR"
							? "STATE_VERSION_CONFLICT"
							: "COMMAND_BLOCKED";
		return {
			code,
			message: error.message,
			retryable: false,
			details: {
				reason: error.code,
				...(error.snapshot === undefined ? {} : { snapshot: error.snapshot }),
				...(error.action === undefined ? {} : { action: error.action }),
			},
		};
	}
	if (error instanceof StudioSessionTranscriptError) {
		return { code: error.code, message: error.message, retryable: false };
	}
	if (error instanceof StudioAgentConversationError) {
		const code = error.code === "CURSOR_STALE" || error.code === "INVALID_ARGUMENT" ? error.code : "COMMAND_BLOCKED";
		return { code, message: error.message, retryable: false, details: { reason: error.code } };
	}
	if (error instanceof StudioJobError) {
		const code =
			error.code === "JOB_GENERATION_CONFLICT"
				? "JOB_GENERATION_CONFLICT"
				: error.code === "NOT_OWNER"
					? "NOT_OWNER"
					: error.code === "INVALID_ARGUMENT"
						? "INVALID_ARGUMENT"
						: "COMMAND_BLOCKED";
		return {
			code,
			message: error.message,
			retryable: false,
			details: {
				reason: error.code,
				...(error.snapshot === undefined ? {} : { snapshot: error.snapshot }),
				...(error.action === undefined ? {} : { action: error.action }),
			},
		};
	}
	return { code: "INTERNAL_ERROR", message: "Runtime command failed", retryable: false };
}

/** Minimal Runtime dispatcher. It advertises and executes only truthful services. */
export class StudioBridgeDispatcher {
	readonly #arbiter: StudioRuntimeCommandArbiter;
	readonly #sessionControl: SessionControlService;
	readonly #transcript: StudioSessionTranscriptService;
	readonly #interactions: StudioRemoteInteractionPort;
	readonly #unsubscribeBtw: () => void;
	readonly #permissions: StudioPermissionControlService;
	readonly #byRequestId = new Map<string, RememberedReceipt>();
	readonly #byIdempotencyKey = new Map<string, RememberedReceipt>();
	#quiescing = false;

	constructor(
		private readonly runtime: StudioHostRuntime,
		private readonly projector: StudioStateProjector,
		private readonly send: StudioBridgeSend,
	) {
		this.#arbiter = new StudioRuntimeCommandArbiter(
			() => ({
				runtimeEpoch: runtime.runtimeEpoch,
				stateVersion: projector.stateVersion,
				isStreaming: runtime.session.isStreaming,
				isCompacting: runtime.session.isCompacting,
			}),
			[
				...SESSION_CONTROL_OPERATION_KINDS,
				"runtime.pause",
				"runtime.resume",
				"browser.evaluate",
				"computer.evaluate",
				"image.read",
				"terminal.image",
				"video.metadata",
				"video.frame",
				"eval.agent.start",
				"eval.agent.status",
				"eval.agent.wait",
				"eval.agent.cancel",
				"eval.completion.start",
				"eval.completion.status",
				"eval.completion.wait",
				"eval.completion.cancel",
				"eval.workpool.status",
			],
		);
		this.#permissions = runtime.services.permissions ?? new StudioPermissionControlService(runtime.session);
		this.#sessionControl = new SessionControlService(runtime.session, {
			beforeQueuedUserTurn: async () => {
				await this.runtime.services.models.applyPending();
				await this.runtime.services.modes.applyPending();
				await this.#permissions.applyPending();
			},
		});
		this.#transcript =
			runtime.services.transcript ??
			new StudioSessionTranscriptService(() => ({
				runtimeEpoch: runtime.runtimeEpoch,
				sessionId: runtime.sessionId,
				sessionManager: runtime.sessionManager,
			}));
		this.#interactions = new StudioRemoteInteractionPort(
			this.#arbiter,
			(pending, event) => {
				this.projector.setPendingInteraction(pending);
				this.projector.emitInteractionRequired(event);
			},
			event => {
				this.projector.setPendingInteraction(undefined);
				this.projector.emitInteractionResolved(event);
			},
		);
		runtime.services.interaction.bind(this.#interactions);
		this.#unsubscribeBtw = runtime.services.btw.onChange(snapshot => this.projector.emitBtwChanged(snapshot));
	}

	dispose(): void {
		this.#unsubscribeBtw();
		this.#interactions.cancel("Interaction bridge closed");
		this.runtime.services.interaction.unbind(this.#interactions);
	}

	async dispatch(request: StudioRequest, send: StudioBridgeSend = this.send): Promise<void> {
		const operation = request.operation;
		if (operation.kind !== "runtime.shutdown") {
			try {
				await this.runtime.ensureWorkerLive?.();
			} catch (error) {
				const workerState = this.runtime.workerResidency?.() ?? "active";
				this.#reject(
					request,
					{
						code: "COMMAND_BLOCKED",
						message: error instanceof Error ? error.message : "Main Worker revival failed",
						retryable: true,
						details: { workerState, workerGeneration: this.runtime.workerGeneration?.() ?? 0 },
					},
					send,
					false,
				);
				return;
			}
		}
		if (operation.kind === "runtime.snapshot") {
			send(`snapshot-result:${request.requestId}`, this.projector.response(request.requestId));
			return;
		}
		if (operation.kind === "session.transcript.read") {
			this.#dispatchTranscriptRead(request, send);
			return;
		}
		if (operation.kind === "agent.conversation.read") {
			void this.#dispatchAgentConversationRead(request, send);
			return;
		}
		if (operation.kind === "interaction.respond") {
			this.#dispatchInteractionResponse(request, send);
			return;
		}
		if (operation.kind === "tui.transfer") {
			this.#dispatchInteractionTransfer(request, send);
			return;
		}

		const replay = this.#lookupReplay(request, send);
		if (replay === null) return;
		if (replay !== undefined) {
			send(`receipt-replay:${request.requestId}`, { ...replay, requestId: request.requestId });
			return;
		}

		if (this.#quiescing && operation.kind !== "runtime.shutdown") {
			this.#reject(
				request,
				{
					code: "COMMAND_BLOCKED",
					message: "Runtime is shutting down",
					retryable: false,
				},
				send,
			);
			return;
		}

		if (
			operation.kind !== "runtime.pause" &&
			operation.kind !== "runtime.resume" &&
			!SESSION_CONTROL_OPERATION_KINDS.has(operation.kind) &&
			!isEvaluationOperationKind(operation.kind)
		) {
			this.#reject(
				request,
				{
					code: "COMMAND_UNKNOWN",
					message: "Operation is not implemented by this Runtime",
					retryable: false,
				},
				send,
			);
			return;
		}

		const commandId = crypto.randomUUID();
		let accepted = false;
		try {
			await this.#arbiter.run(request, commandId, "gui", async () => {
				const isPauseOperation = operation.kind === "runtime.pause" || operation.kind === "runtime.resume";
				const isLoopOperation = operation.kind.startsWith("loop.");
				const isModeOperation = operation.kind.startsWith("mode.") || operation.kind.startsWith("goal.");
				const isTreeOperation = operation.kind.startsWith("session.tree.");
				const isOperatorOperation = operation.kind.startsWith("operator.");
				const isBtwOperation = operation.kind.startsWith("btw.");
				const isOmfgOperation = operation.kind.startsWith("omfg.");
				const isTanOperation = operation.kind.startsWith("tan.");
				const isAgentOperation = operation.kind.startsWith("agent.");
				const isJobOperation = operation.kind.startsWith("job.");
				const isPermissionOperation = operation.kind === "permissions.mode.set";
				const isShutdownOperation = operation.kind === "runtime.shutdown";
				const isLiveOperation = operation.kind === "live.start" || operation.kind === "live.stop";
				if (isPauseOperation) this.#assertPausePreconditions(operation);
				accepted = true;
				send(`receipt-accepted:${commandId}`, {
					type: "studio.receipt",
					requestId: request.requestId,
					commandId,
					runtimeEpoch: this.runtime.runtimeEpoch,
					stateVersion: this.projector.stateVersion,
					status: "accepted",
				});
				const result = isEvaluationOperationKind(operation.kind)
					? await this.runtime.services.evaluation.execute(operation as EvaluationOperation)
					: isShutdownOperation
						? await this.#executeShutdownOperation(operation)
						: isLiveOperation
							? await this.#executeLiveOperation(operation)
							: isPauseOperation
								? await this.#executePauseOperation(operation)
								: isLoopOperation
									? await this.#executeLoopOperation(operation)
									: isModeOperation
										? await this.#executeModeOperation(operation)
										: isTreeOperation
											? await this.#executeTreeOperation(operation, commandId)
											: operation.kind === "session.fork"
												? await this.runtime.services.fork.fork()
												: operation.kind === "session.handoff"
													? await this.runtime.services.handoff.handoff(operation.customInstructions)
													: isOperatorOperation
														? await this.#executeOperatorOperation(operation)
														: isBtwOperation
															? await this.#executeBtwOperation(operation)
															: isOmfgOperation
																? await this.#executeOmfgOperation(operation, commandId)
																: isTanOperation
																	? await this.#executeTanOperation(operation)
																	: isAgentOperation
																		? await this.#executeAgentOperation(operation)
																		: isJobOperation
																			? await this.#executeJobOperation(operation)
																			: isPermissionOperation
																				? await this.#executePermissionOperation(operation)
																				: await this.#executeSessionOperation(operation, commandId);
				if (!isPauseOperation) this.projector.commitStateChange();
				// Manual /compact, /clear, and handoff rewrite the context without
				// a following conversation turn, so no conversation event will
				// recompute telemetry. Refresh it now or the GUI context meter
				// keeps showing pre-mutation numbers until the next turn.
				if (this.#mutatesContextInPlace(operation)) this.projector.refreshTelemetry();
				const completed: StudioReceipt = {
					type: "studio.receipt",
					requestId: request.requestId,
					commandId,
					runtimeEpoch: this.runtime.runtimeEpoch,
					stateVersion: this.projector.stateVersion,
					status: "completed",
					result,
				};
				this.#remember(request, completed);
				this.projector.recordTerminalReceipt(completed);
				send(`receipt-completed:${commandId}`, completed);
				if (isShutdownOperation) {
					this.projector.emitRuntimeShutdownComplete();
					queueMicrotask(() => this.runtime.requestShutdown());
				}
			});
		} catch (error) {
			if (operation.kind === "runtime.shutdown") this.#quiescing = false;
			const receipt: StudioReceipt = {
				type: "studio.receipt",
				requestId: request.requestId,
				commandId,
				runtimeEpoch: this.runtime.runtimeEpoch,
				stateVersion: this.projector.stateVersion,
				status: accepted ? "failed" : "rejected",
				error: protocolError(error),
			};
			this.#remember(request, receipt);
			this.projector.recordTerminalReceipt(receipt);
			send(`receipt-${receipt.status}:${commandId}`, receipt);
		}
	}

	#dispatchTranscriptRead(request: StudioRequest, send: StudioBridgeSend): void {
		const operation = request.operation;
		if (operation.kind !== "session.transcript.read") return;
		const commandId = crypto.randomUUID();
		try {
			if (request.runtimeEpoch !== this.runtime.runtimeEpoch) {
				throw new StudioRuntimeCommandError("RUNTIME_EPOCH_STALE", "Runtime epoch is stale");
			}
			const result = this.#transcript.read({ cursor: operation.cursor, limit: operation.limit });
			send(`receipt-completed:${commandId}`, {
				type: "studio.receipt",
				requestId: request.requestId,
				commandId,
				runtimeEpoch: this.runtime.runtimeEpoch,
				stateVersion: this.projector.stateVersion,
				status: "completed",
				result,
			});
		} catch (error) {
			this.#reject(request, protocolError(error), send, false);
		}
	}

	async #dispatchAgentConversationRead(request: StudioRequest, send: StudioBridgeSend): Promise<void> {
		const operation = request.operation;
		if (operation.kind !== "agent.conversation.read") return;
		const commandId = crypto.randomUUID();
		try {
			if (request.runtimeEpoch !== this.runtime.runtimeEpoch) {
				throw new StudioRuntimeCommandError("RUNTIME_EPOCH_STALE", "Runtime epoch is stale");
			}
			const result = await this.runtime.services.agentConversation.read({
				agentId: operation.agentId,
				...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
				...(operation.limit === undefined ? {} : { limit: operation.limit }),
			});
			send(`receipt-completed:${commandId}`, {
				type: "studio.receipt",
				requestId: request.requestId,
				commandId,
				runtimeEpoch: this.runtime.runtimeEpoch,
				stateVersion: this.projector.stateVersion,
				status: "completed",
				result,
			});
		} catch (error) {
			this.#reject(request, protocolError(error), send, false);
		}
	}

	#dispatchInteractionResponse(request: StudioRequest, send: StudioBridgeSend): void {
		const operation = request.operation;
		if (operation.kind !== "interaction.respond") return;
		const responseCommandId = crypto.randomUUID();
		try {
			if (request.runtimeEpoch !== this.runtime.runtimeEpoch) {
				throw new StudioRuntimeCommandError("RUNTIME_EPOCH_STALE", "Runtime epoch is stale");
			}
			this.#interactions.respond(operation, "gui");
			send(`receipt-completed:${responseCommandId}`, {
				type: "studio.receipt",
				requestId: request.requestId,
				commandId: responseCommandId,
				runtimeEpoch: this.runtime.runtimeEpoch,
				stateVersion: this.projector.stateVersion,
				status: "completed",
				result: { responded: true },
			});
		} catch (error) {
			this.#reject(request, protocolError(error), send, false);
		}
	}

	#dispatchInteractionTransfer(request: StudioRequest, send: StudioBridgeSend): void {
		const operation = request.operation;
		if (operation.kind !== "tui.transfer") return;
		const responseCommandId = crypto.randomUUID();
		try {
			if (request.runtimeEpoch !== this.runtime.runtimeEpoch) {
				throw new StudioRuntimeCommandError("RUNTIME_EPOCH_STALE", "Runtime epoch is stale");
			}
			const interaction = this.#interactions.transfer(operation.interactionId, operation.commandId, "gui", "tui");
			send(`receipt-completed:${responseCommandId}`, {
				type: "studio.receipt",
				requestId: request.requestId,
				commandId: responseCommandId,
				runtimeEpoch: this.runtime.runtimeEpoch,
				stateVersion: this.projector.stateVersion,
				status: "completed",
				result: { transferred: true, interaction },
			});
		} catch (error) {
			this.#reject(request, protocolError(error), send, false);
		}
	}

	#assertPausePreconditions(
		operation: { kind: "runtime.pause" } | { kind: "runtime.resume"; expectedPauseEpoch: number },
	): void {
		const pauseState = this.runtime.services.pause.state();
		if (operation.kind === "runtime.pause" && pauseState.paused) {
			throw new StudioPauseError("ALREADY_PAUSED", "Runtime is already paused");
		}
		if (operation.kind === "runtime.resume" && !pauseState.paused) {
			throw new StudioPauseError("NOT_PAUSED", "Runtime is not paused");
		}
		if (operation.kind === "runtime.resume" && operation.expectedPauseEpoch !== pauseState.pauseEpoch) {
			throw new StudioPauseError("STALE_PAUSE_EPOCH", "Pause epoch is stale");
		}
	}

	#executePauseOperation(
		operation: { kind: "runtime.pause" } | { kind: "runtime.resume"; expectedPauseEpoch: number },
	) {
		return operation.kind === "runtime.pause"
			? this.runtime.services.pause.pause()
			: this.runtime.services.pause.resume(operation.expectedPauseEpoch);
	}

	async #executeShutdownOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		if (operation.kind !== "runtime.shutdown" || operation.drain !== true) {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Invalid Runtime shutdown request");
		}
		this.#quiescing = true;
		this.runtime.services.loop.disable();
		await this.runtime.services.live.stop();
		this.projector.emitRuntimeQuiescing();
		await this.runtime.session.waitForIdle();
		if (this.runtime.session.asyncJobManager !== undefined) {
			await this.runtime.session.asyncJobManager.waitForAll();
			await this.runtime.session.asyncJobManager.drainDeliveries({ timeoutMs: 5_000 });
		}
		return { drained: true };
	}

	async #executeLiveOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		switch (operation.kind) {
			case "live.start":
				return { state: await this.runtime.services.live.start(operation.deviceId) };
			case "live.stop":
				return await this.runtime.services.live.stop();
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Live operation is not registered");
		}
	}

	async #executeSessionOperation(operation: StudioRequest["operation"], commandId: string): Promise<unknown> {
		switch (operation.kind) {
			case "queue.enqueue":
				return await this.#sessionControl.enqueue(operation.text);
			case "runtime.settings.get":
				return this.runtime.services.settings.get(operation.keys);
			case "runtime.settings.set":
				return await this.runtime.services.settings.set(operation.key, operation.value, operation.persist);
			case "session.clearContext":
				return await this.#sessionControl.clearContext();
			case "session.drop": {
				const approved = await this.#interactions.confirm({
					commandId,
					title: "Drop session",
					message: "Permanently delete the current session transcript and start a new session?",
					destructive: true,
				});
				return await this.#sessionControl.drop(approved);
			}
			case "turn.retry":
				return await this.#sessionControl.retry();
			case "session.model.set":
				return await this.runtime.services.models.setModel(operation.selector, operation.thinking);
			case "session.thinking.set":
				return this.runtime.services.models.setThinking(operation.level);
			case "session.taskModel.set":
				return await this.runtime.services.models.setTaskModel(operation.selector);
			case "session.fast.set":
				return this.runtime.services.fastPrewalk.setFast(operation.enabled);
			case "session.prewalk.arm":
				return this.runtime.services.fastPrewalk.arm(operation.target);
			case "session.prewalk.disarm":
				return this.runtime.services.fastPrewalk.disarm();
			case "core.prompt": {
				const { preludes } = await expandSkillPrompts(this.runtime.session, operation.text);
				return await this.#sessionControl.prompt(operation.text, operation.images, preludes).then(result => {
					if (this.runtime.services.loop.state()?.status === "waiting") {
						this.runtime.services.loop.capturePrompt(operation.text);
					}
					return result;
				});
			}
			case "core.steer": {
				const { preludes } = await expandSkillPrompts(this.runtime.session, operation.text);
				return await this.#sessionControl.steer(operation.text, operation.images, preludes);
			}
			case "core.followUp": {
				const { preludes } = await expandSkillPrompts(this.runtime.session, operation.text);
				return await this.#sessionControl.followUp(operation.text, operation.images, preludes);
			}
			case "core.abort":
				return await this.#sessionControl.abort();
			default:
				throw new StudioRuntimeCommandError(
					"COMMAND_BLOCKED",
					"Operation is not registered with the Runtime arbiter",
				);
		}
	}

	async #executePermissionOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		if (operation.kind !== "permissions.mode.set") {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Operation is not registered with the Runtime arbiter");
		}
		return await this.#permissions.setMode(operation.mode, operation.persist);
	}

	async #executeLoopOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		switch (operation.kind) {
			case "loop.enable": {
				if (operation.prompt !== undefined && this.runtime.session.isStreaming) {
					throw new StudioRuntimeCommandError("BUSY_STREAMING", "Runtime is streaming");
				}
				if (this.runtime.services.loop.state()) {
					return this.runtime.services.loop.setLimit(operation.limit);
				}
				const result = this.runtime.services.loop.enable(operation.prompt, operation.limit);
				if (result.initialPrompt !== undefined) {
					try {
						await this.runtime.session.prompt(result.initialPrompt);
					} catch (error) {
						this.runtime.services.loop.disable();
						throw error;
					}
				}
				return result.state;
			}
			case "loop.pause":
				return this.runtime.services.loop.pause();
			case "loop.disable":
				return this.runtime.services.loop.disable();
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Loop operation is not registered");
		}
	}

	async #executeModeOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		switch (operation.kind) {
			case "mode.plan.enter":
				return await this.runtime.services.modes.enterPlan(operation.initialPrompt);
			case "mode.plan.exit":
				return await this.runtime.services.modes.exitPlan(operation.discardDraft === true);
			case "mode.plan.review.open":
				return await this.runtime.services.modes.openPlanReview();
			case "mode.plan.review.saveAndQuit":
				return await this.runtime.services.modes.savePlanAndQuit(operation.path);
			case "mode.plan.review.respond":
				return await this.runtime.services.modes.respondPlanReview(operation.decision, operation.feedback);
			case "mode.vibe.enter":
				return await this.runtime.services.modes.enterVibe(operation.initialPrompt);
			case "mode.vibe.exit":
				return await this.runtime.services.modes.exitVibe();
			case "goal.create":
				return await this.runtime.services.modes.createGoal(operation.objective, operation.tokenBudget);
			case "goal.replace":
				return await this.runtime.services.modes.replaceGoal(operation.objective, operation.tokenBudget);
			case "goal.show":
				return this.runtime.services.modes.state().goal ?? { status: "off" };
			case "goal.setBudget":
				return await this.runtime.services.modes.setGoalBudget(operation.tokenBudget);
			case "goal.pause":
				return await this.runtime.services.modes.pauseGoal();
			case "goal.resume":
				return await this.runtime.services.modes.resumeGoal();
			case "goal.drop":
				return await this.runtime.services.modes.dropGoal();
			case "goal.guided.start":
				return await this.runtime.services.modes.startGuidedGoal(operation.initial);
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Mode operation is not registered");
		}
	}

	async #executeTreeOperation(operation: StudioRequest["operation"], commandId: string): Promise<unknown> {
		switch (operation.kind) {
			case "session.tree.get":
				return this.runtime.services.tree.getTree();
			case "session.tree.navigate":
				return await this.runtime.services.tree.navigate(commandId, operation);
			case "session.tree.branch":
				return await this.runtime.services.tree.branch(commandId, operation);
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Tree operation is not registered");
		}
	}

	async #executeOperatorOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		switch (operation.kind) {
			case "operator.manifest.get":
				return this.runtime.services.commands.manifest();
			case "operator.invoke":
				return await this.runtime.services.commands.invoke(operation.commandId, operation.arguments);
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Operator operation is not registered");
		}
	}

	/** Operations that rewrite the conversation context in place and finish
	 *  without a conversation turn whose events would refresh telemetry. */
	#mutatesContextInPlace(operation: StudioRequest["operation"]): boolean {
		if (operation.kind === "session.clearContext" || operation.kind === "session.handoff") return true;
		return (
			operation.kind === "operator.invoke" &&
			(operation.commandId === "builtin.compact" || operation.commandId === "builtin.handoff")
		);
	}

	async #executeBtwOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		switch (operation.kind) {
			case "btw.ask":
				return this.runtime.services.btw.ask(operation.question);
			case "btw.abort":
				return this.runtime.services.btw.abort(operation.ephemeralId);
			case "btw.branch":
				return await this.runtime.services.btw.branchCurrent(operation.branchToken);
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "BTW operation is not registered");
		}
	}

	async #executeOmfgOperation(operation: StudioRequest["operation"], commandId: string): Promise<unknown> {
		switch (operation.kind) {
			case "omfg.generate":
				return await this.runtime.services.omfg.generate(operation.complaint);
			case "omfg.amend":
				return await this.runtime.services.omfg.amend(operation.candidateId, operation.feedback);
			case "omfg.commit":
				return await this.runtime.services.omfg.commit(
					operation.candidateId,
					operation.scope,
					operation.overwrite,
					commandId,
				);
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "OMFG operation is not registered");
		}
	}

	async #executeTanOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		if (operation.kind !== "tan.start") {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "TAN operation is not registered");
		}
		return await this.runtime.services.tan.start(operation.work);
	}

	async #executeAgentOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		const callerAgentId = this.runtime.session.getAgentId() ?? "Main";
		switch (operation.kind) {
			case "agent.list":
				return this.runtime.services.agents.list({
					...(operation.includeTerminal === undefined ? {} : { includeTerminal: operation.includeTerminal }),
					...(operation.includePersisted === undefined ? {} : { includePersisted: operation.includePersisted }),
				});
			case "agent.get":
				return this.runtime.services.agents.get(operation.agentId);
			case "agent.spawn":
				return await this.runtime.services.agents.spawn({
					definition: operation.definition,
					assignment: operation.assignment,
					...(operation.context === undefined ? {} : { context: operation.context }),
					...(operation.async === undefined ? {} : { async: operation.async }),
					...(operation.isolation === undefined ? {} : { isolation: operation.isolation }),
					...(operation.effort === undefined ? {} : { effort: operation.effort }),
					callerAgentId,
				});
			case "agent.send":
				return await this.runtime.services.agents.send({ ...operation, callerAgentId });
			case "agent.kill":
				return await this.runtime.services.agents.kill({ ...operation, callerAgentId });
			case "agent.revive":
				return await this.runtime.services.agents.revive({ ...operation, callerAgentId });
			case "agent.release":
				return await this.runtime.services.agents.release({ ...operation, callerAgentId });
			case "agent.transcript.read":
				return await this.runtime.services.agents.readTranscript({
					agentId: operation.agentId,
					...(operation.cursor === undefined ? {} : { cursor: operation.cursor }),
					...(operation.limit === undefined ? {} : { limit: operation.limit }),
				});
			case "agent.subscribe":
				return { subscribed: true, level: operation.level };
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Agent operation is not registered");
		}
	}

	async #executeJobOperation(operation: StudioRequest["operation"]): Promise<unknown> {
		const callerAgentId = this.runtime.session.getAgentId() ?? "Main";
		switch (operation.kind) {
			case "job.list":
				return this.runtime.services.jobs.list({
					callerAgentId,
					...(operation.ownerAgentId === undefined ? {} : { ownerAgentId: operation.ownerAgentId }),
					...(operation.includeRecent === undefined ? {} : { includeRecent: operation.includeRecent }),
				});
			case "job.get":
				return this.runtime.services.jobs.get(operation.jobId);
			case "job.cancel":
				return await this.runtime.services.jobs.cancel({
					jobId: operation.jobId,
					expectedGeneration: operation.expectedGeneration,
					callerAgentId,
				});
			case "job.subscribe":
				return { subscribed: true };
			default:
				throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Job operation is not registered");
		}
	}

	#lookupReplay(request: StudioRequest, send: StudioBridgeSend): StudioReceipt | null | undefined {
		const signature = operationSignature(request);
		const byRequest = this.#byRequestId.get(request.requestId);
		const byKey =
			request.idempotencyKey === undefined ? undefined : this.#byIdempotencyKey.get(request.idempotencyKey);
		const remembered = byRequest ?? byKey;
		if (remembered === undefined) return undefined;
		if (remembered.operation !== signature) {
			this.#reject(
				request,
				{
					code: "INVALID_ARGUMENT",
					message: "Idempotency identity was reused for a different operation",
					retryable: false,
					details: { reason: "IDEMPOTENCY_CONFLICT" },
				},
				send,
				false,
			);
			return null;
		}
		return structuredClone(remembered.receipt);
	}

	#remember(request: StudioRequest, receipt: StudioReceipt): void {
		const remembered = { operation: operationSignature(request), receipt: structuredClone(receipt) };
		this.#boundedSet(this.#byRequestId, request.requestId, remembered);
		if (request.idempotencyKey !== undefined)
			this.#boundedSet(this.#byIdempotencyKey, request.idempotencyKey, remembered);
	}

	#boundedSet(map: Map<string, RememberedReceipt>, key: string, value: RememberedReceipt): void {
		map.delete(key);
		map.set(key, value);
		if (map.size > 512) map.delete(map.keys().next().value as string);
	}

	#reject(request: StudioRequest, error: StudioProtocolError, send: StudioBridgeSend, remember = true): void {
		const receipt: StudioReceipt = {
			type: "studio.receipt",
			requestId: request.requestId,
			runtimeEpoch: this.runtime.runtimeEpoch,
			stateVersion: this.projector.stateVersion,
			status: "rejected",
			error,
		};
		if (remember) {
			this.#remember(request, receipt);
			this.projector.recordTerminalReceipt(receipt);
		}
		send(`receipt-rejected:${request.requestId}`, receipt);
	}
}
