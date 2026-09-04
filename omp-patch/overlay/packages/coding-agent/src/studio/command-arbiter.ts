import * as crypto from "node:crypto";
import type { StudioRequest } from "./bridge-protocol";

export type StudioCommandSurface = "gui" | "tui" | "system";

/** Abort/steer/pause run against a live turn. Conversation events bump
 *  `stateVersion` continuously, so a snapshot fence races the stream. */
const LIVE_TURN_OPERATION_KINDS = new Set<string>([
	"core.abort",
	"core.steer",
	"core.followUp",
	"queue.enqueue",
	"runtime.pause",
	"runtime.resume",
	"session.model.set",
	"session.thinking.set",
	"session.taskModel.set",
	"mode.plan.enter",
	"mode.plan.exit",
	"mode.vibe.enter",
	"mode.vibe.exit",
	"goal.create",
	"goal.drop",
	"loop.enable",
	"loop.disable",
	"session.fast.set",
	"session.prewalk.arm",
	"session.prewalk.disarm",
	"permissions.mode.set",
	"operator.invoke",
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
]);

/** Queue-compatible interrupts that must run while `core.prompt` still holds
 *  the exclusive lease (streaming, 503 backoff, auto-retry). Pause/resume stay
 *  exclusive. `operator.invoke` is user-initiated and routes to the slash
 *  handler, which owns mid-stream semantics (builtin.compact aborts the live
 *  turn first, skills steer, extension commands run immediately); a plain
 *  prompt still fails closed. The Host's interaction arbiter keeps classifying
 *  it session-exclusive, but this Runtime arbiter is authoritative for it. */
const CONCURRENT_WITH_LEASE_OPERATION_KINDS = new Set<string>([
	"core.abort",
	"core.steer",
	"core.followUp",
	"queue.enqueue",
	"session.model.set",
	"session.thinking.set",
	"session.taskModel.set",
	"mode.plan.enter",
	"mode.plan.exit",
	"mode.vibe.enter",
	"mode.vibe.exit",
	"goal.create",
	"goal.drop",
	"loop.enable",
	"loop.disable",
	"session.fast.set",
	"session.prewalk.arm",
	"session.prewalk.disarm",
	"permissions.mode.set",
	"operator.invoke",
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
]);

const DEFERRED_SESSION_PREFERENCE_KINDS = new Set<string>([
	"session.model.set",
	"session.thinking.set",
	"session.taskModel.set",
	"mode.plan.enter",
	"mode.plan.exit",
	"mode.vibe.enter",
	"mode.vibe.exit",
	"goal.create",
	"goal.drop",
	"loop.enable",
	"loop.disable",
	"session.fast.set",
	"session.prewalk.arm",
	"session.prewalk.disarm",
	"permissions.mode.set",
]);

/** Operations that actively cancel an in-flight compaction rather than being
 *  deferred past it. The GUI cancel button and native Esc both let `core.abort`
 *  overtake a manual compaction (`session.abort` → `abortCompaction`, then
 *  waits for its cleanup barrier), so it must not trip the BUSY_COMPACTING gate
 *  while still staying out of the deferred-preference set. */
const COMPACTION_CANCEL_KINDS = new Set<string>(["core.abort"]);

export class StudioRuntimeCommandError extends Error {
	constructor(
		readonly code:
			| "RUNTIME_EPOCH_STALE"
			| "STATE_VERSION_CONFLICT"
			| "COMMAND_BLOCKED"
			| "INTERACTION_STALE"
			| "NOT_OWNER"
			| "BUSY_COMPACTING"
			| "BUSY_STREAMING",
		message: string,
	) {
		super(message);
		this.name = "StudioRuntimeCommandError";
	}
}

export interface StudioRuntimeArbiterState {
	runtimeEpoch: number;
	stateVersion: number;
	isStreaming: boolean;
	isCompacting: boolean;
}

export interface StudioRuntimeControlLease {
	holder: StudioCommandSurface;
	generation: number;
	commandId: string;
}

export interface StudioRuntimeInteractionLease {
	interactionId: string;
	commandId: string;
	owner: "gui" | "tui";
	generation: number;
}

/** Runtime-authoritative serialization gate. Host arbitration is advisory. */
export class StudioRuntimeCommandArbiter {
	#lease: StudioRuntimeControlLease | undefined;
	#generation = 0;
	#interaction: StudioRuntimeInteractionLease | undefined;
	readonly #registeredOperations: ReadonlySet<string>;

	constructor(
		private readonly state: () => StudioRuntimeArbiterState,
		registeredOperations: readonly string[] = ["runtime.pause", "runtime.resume"],
	) {
		this.#registeredOperations = new Set(registeredOperations);
	}

	currentLease(): StudioRuntimeControlLease | undefined {
		return this.#lease === undefined ? undefined : { ...this.#lease };
	}

	currentInteraction(): StudioRuntimeInteractionLease | undefined {
		return this.#interaction === undefined ? undefined : { ...this.#interaction };
	}

	openInteraction(commandId: string, owner: "gui" | "tui"): StudioRuntimeInteractionLease {
		if (this.#interaction !== undefined) {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Another interaction is active");
		}
		this.#interaction = { interactionId: crypto.randomUUID(), commandId, owner, generation: 1 };
		return { ...this.#interaction };
	}

	transferInteraction(interactionId: string, from: "gui" | "tui", to: "gui" | "tui"): StudioRuntimeInteractionLease {
		const interaction = this.#requireInteraction(interactionId);
		if (interaction.owner !== from) {
			throw new StudioRuntimeCommandError("NOT_OWNER", "Surface does not own the interaction");
		}
		if (from !== to) this.#interaction = { ...interaction, owner: to, generation: interaction.generation + 1 };
		return { ...(this.#interaction ?? interaction) };
	}

	completeInteraction(interactionId: string, commandId: string, owner: "gui" | "tui", generation: number): void {
		const interaction = this.#requireInteraction(interactionId);
		if (interaction.generation !== generation) {
			throw new StudioRuntimeCommandError("INTERACTION_STALE", "Interaction generation is stale");
		}
		if (interaction.commandId !== commandId || interaction.owner !== owner) {
			throw new StudioRuntimeCommandError("NOT_OWNER", "Caller does not own the interaction");
		}
		this.#interaction = undefined;
	}

	async run<T>(
		request: StudioRequest,
		commandId: string,
		surface: StudioCommandSurface,
		execute: () => Promise<T> | T,
	): Promise<T> {
		const state = this.state();
		if (request.runtimeEpoch !== state.runtimeEpoch) {
			throw new StudioRuntimeCommandError("RUNTIME_EPOCH_STALE", "Runtime epoch is stale");
		}
		if (
			request.expectedStateVersion !== undefined &&
			request.expectedStateVersion !== state.stateVersion &&
			!LIVE_TURN_OPERATION_KINDS.has(request.operation.kind)
		) {
			throw new StudioRuntimeCommandError("STATE_VERSION_CONFLICT", "State version does not match");
		}
		if (
			state.isCompacting &&
			!DEFERRED_SESSION_PREFERENCE_KINDS.has(request.operation.kind) &&
			!COMPACTION_CANCEL_KINDS.has(request.operation.kind)
		) {
			throw new StudioRuntimeCommandError("BUSY_COMPACTING", "Runtime is compacting");
		}
		if (!this.#registeredOperations.has(request.operation.kind)) {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "Operation is not registered with the Runtime arbiter");
		}
		if (this.#interaction !== undefined && !DEFERRED_SESSION_PREFERENCE_KINDS.has(request.operation.kind)) {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "An interaction is active");
		}
		if (CONCURRENT_WITH_LEASE_OPERATION_KINDS.has(request.operation.kind)) {
			return await execute();
		}
		if (this.#lease !== undefined) {
			throw new StudioRuntimeCommandError("COMMAND_BLOCKED", "A conflicting command is active");
		}
		this.#lease = { holder: surface, generation: ++this.#generation, commandId };
		try {
			return await execute();
		} finally {
			this.#lease = undefined;
		}
	}

	#requireInteraction(interactionId: string): StudioRuntimeInteractionLease {
		if (this.#interaction === undefined || this.#interaction.interactionId !== interactionId) {
			throw new StudioRuntimeCommandError("INTERACTION_STALE", "Interaction is stale");
		}
		return this.#interaction;
	}
}
