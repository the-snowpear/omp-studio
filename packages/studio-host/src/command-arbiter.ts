import { randomUUID } from "node:crypto";
import {
  SESSION_TRANSCRIPT_READ_KIND,
  type CommandConcurrency,
  type CommandId,
  type Generation,
  type InteractionId,
  type RuntimeControlLease,
  type RuntimeEpoch,
  type StateVersion,
  type StudioErrorCode,
  type StudioOperation,
  type StudioRequest,
} from "@omp-studio/studio-protocol";

export interface ArbiterState {
  runtimeEpoch: RuntimeEpoch;
  stateVersion: StateVersion;
  isStreaming: boolean;
  isCompacting: boolean;
}

export type StudioSurface = RuntimeControlLease["holder"];

export type InteractionSurface = Extract<StudioSurface, "gui" | "tui">;

export interface InteractionOwnership {
  interactionId: InteractionId;
  commandId: CommandId;
  owner: InteractionSurface;
  generation: number;
}

export interface RunOptions {
  /** Surface that issued the command; recorded on the control lease for exclusive commands. */
  surface?: StudioSurface;
  /** Command identity recorded on the control lease for exclusive commands. */
  commandId?: CommandId;
  /** Command-specific gate (e.g. destructive confirmation) checked after arbitration gates. */
  precondition?: () => void;
}

export class StudioHostError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "StudioHostError";
  }
}

export function classifyOperation(operation: StudioOperation): CommandConcurrency {
  if (
    operation.kind === "runtime.snapshot" ||
    operation.kind === "operator.manifest.get" ||
    operation.kind === "agent.list" ||
    operation.kind === "agent.get" ||
    operation.kind === "agent.transcript.read" ||
    operation.kind === SESSION_TRANSCRIPT_READ_KIND ||
    operation.kind === "job.list" ||
    operation.kind === "job.get"
  ) {
    return "read-concurrent";
  }
  if (
    operation.kind === "core.prompt" ||
    operation.kind === "core.steer" ||
    operation.kind === "core.followUp" ||
    operation.kind === "core.abort" ||
    operation.kind === "queue.enqueue"
  ) {
    return "queue-compatible";
  }
  if (
    operation.kind === "runtime.pause" ||
    operation.kind === "runtime.resume" ||
    operation.kind === "runtime.shutdown" ||
    operation.kind === "live.start" ||
    operation.kind === "live.stop"
  ) {
    return "process-exclusive";
  }
  return "session-exclusive";
}

export class CommandArbiter {
  #activeReadCount = 0;
  #activeQueueCount = 0;
  #exclusive: CommandConcurrency | undefined;
  #lease: RuntimeControlLease | undefined;
  #leaseGeneration = 0;
  #interactions = new Map<InteractionId, InteractionOwnership>();

  constructor(private readonly state: () => ArbiterState) {}

  /** Read-only view of the runtime control lease, if an exclusive command holds it. */
  get currentLease(): Readonly<RuntimeControlLease> | undefined {
    return this.#lease === undefined ? undefined : { ...this.#lease };
  }

  async run<T>(
    request: StudioRequest,
    execute: () => Promise<T> | T,
    options: RunOptions = {},
  ): Promise<T> {
    const state = this.state();
    if (request.runtimeEpoch !== state.runtimeEpoch) {
      throw new StudioHostError("RUNTIME_EPOCH_STALE", "Runtime epoch is stale");
    }
    if (request.expectedStateVersion !== undefined && request.expectedStateVersion !== state.stateVersion) {
      throw new StudioHostError("STATE_VERSION_CONFLICT", "State version does not match");
    }

    const concurrency = classifyOperation(request.operation);
    if (state.isCompacting && concurrency !== "read-concurrent") {
      throw new StudioHostError("BUSY_COMPACTING", "Runtime is compacting");
    }
    if (
      state.isStreaming &&
      request.operation.kind !== "runtime.pause" &&
      (concurrency === "session-exclusive" || concurrency === "process-exclusive")
    ) {
      throw new StudioHostError("BUSY_STREAMING", "Runtime is streaming");
    }
    this.#acquire(concurrency, options);
    try {
      options.precondition?.();
      return await execute();
    } finally {
      this.#release(concurrency);
    }
  }

  openInteraction(commandId: CommandId, owner: InteractionSurface): InteractionOwnership {
    if (this.#interactions.size > 0) {
      throw new StudioHostError("COMMAND_BLOCKED", "Another interaction is already active");
    }
    const ownership: InteractionOwnership = {
      interactionId: randomUUID() as InteractionId,
      commandId,
      owner,
      generation: 1,
    };
    this.#interactions.set(ownership.interactionId, ownership);
    if (this.#lease !== undefined) {
      this.#lease = { ...this.#lease, interactionId: ownership.interactionId };
    }
    return { ...ownership };
  }

  /**
   * Adopt a Runtime-issued interaction lease. The Runtime supplies the exact
   * interaction identity and generation; the Host never mints a replacement id.
   */
  adoptInteraction(
    interactionId: InteractionId,
    commandId: CommandId,
    owner: InteractionSurface,
    generation: number,
  ): InteractionOwnership {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new StudioHostError("INVALID_ARGUMENT", "Interaction generation must be a positive integer");
    }
    const existing = this.#interactions.get(interactionId);
    if (existing !== undefined) {
      if (existing.commandId !== commandId) {
        throw new StudioHostError("INTERACTION_STALE", "Interaction is already active (replayed adoption)");
      }
      if (generation === existing.generation && existing.owner === owner) {
        return { ...existing };
      }
      if (generation > existing.generation) {
        const updated: InteractionOwnership = { interactionId, commandId, owner, generation };
        this.#interactions.set(interactionId, updated);
        if (this.#lease !== undefined) {
          this.#lease = { ...this.#lease, interactionId };
        }
        return { ...updated };
      }
      throw new StudioHostError("INTERACTION_STALE", "Interaction generation is stale");
    }
    if (this.#interactions.size > 0) {
      throw new StudioHostError("COMMAND_BLOCKED", "Another interaction is already active");
    }
    const ownership: InteractionOwnership = { interactionId, commandId, owner, generation };
    this.#interactions.set(interactionId, ownership);
    if (this.#lease !== undefined) {
      this.#lease = { ...this.#lease, interactionId };
    }
    return { ...ownership };
  }

  /** Drop every interaction lease without dispatching a Runtime respond. Used on rebind. */
  abandonAllInteractions(): void {
    this.#interactions.clear();
  }

  claimInteraction(commandId: CommandId, owner: InteractionSurface): InteractionOwnership {
    for (const entry of this.#interactions.values()) {
      if (entry.commandId !== commandId) {
        throw new StudioHostError("COMMAND_BLOCKED", "Another interaction is already active");
      }
      if (entry.owner !== owner) {
        throw new StudioHostError("NOT_OWNER", "Interaction transfer requires its current owner");
      }
      return { ...entry };
    }
    return this.openInteraction(commandId, owner);
  }

  transferInteraction(
    interactionId: InteractionId,
    from: InteractionSurface,
    to: InteractionSurface,
  ): InteractionOwnership {
    const entry = this.#interactions.get(interactionId);
    if (entry === undefined) {
      throw new StudioHostError("INTERACTION_STALE", "Interaction is not active");
    }
    if (entry.owner !== from) {
      throw new StudioHostError("NOT_OWNER", "Surface does not own the interaction");
    }
    if (from === to) {
      return { ...entry };
    }
    const transferred: InteractionOwnership = { ...entry, owner: to, generation: entry.generation + 1 };
    this.#interactions.set(interactionId, transferred);
    return { ...transferred };
  }

  assertInteraction(
    interactionId: InteractionId,
    commandId: CommandId,
    owner: InteractionSurface,
    generation: number,
  ): InteractionOwnership {
    return { ...this.#validateInteraction(interactionId, commandId, owner, generation) };
  }

  completeInteraction(
    interactionId: InteractionId,
    commandId: CommandId,
    owner: InteractionSurface,
    generation: number,
  ): InteractionOwnership {
    const entry = this.#validateInteraction(interactionId, commandId, owner, generation);
    this.#interactions.delete(interactionId);
    return { ...entry };
  }

  #validateInteraction(
    interactionId: InteractionId,
    commandId: CommandId,
    owner: InteractionSurface,
    generation: number,
  ): InteractionOwnership {
    const entry = this.#interactions.get(interactionId);
    if (entry === undefined) {
      throw new StudioHostError("INTERACTION_STALE", "Interaction is not active");
    }
    if (entry.generation !== generation) {
      throw new StudioHostError("INTERACTION_STALE", "Interaction generation is stale");
    }
    if (entry.owner !== owner || entry.commandId !== commandId) {
      throw new StudioHostError("NOT_OWNER", "Caller does not own the interaction");
    }
    return entry;
  }

  #acquire(concurrency: CommandConcurrency, options: RunOptions): void {
    const exclusive = concurrency === "session-exclusive" || concurrency === "process-exclusive";
    const busy =
      this.#exclusive !== undefined ||
      (exclusive && (this.#activeReadCount > 0 || this.#activeQueueCount > 0 || this.#interactions.size > 0));
    if (busy) {
      throw new StudioHostError("COMMAND_BLOCKED", "A conflicting command is active");
    }
    if (concurrency === "read-concurrent") this.#activeReadCount += 1;
    else if (concurrency === "queue-compatible") this.#activeQueueCount += 1;
    else {
      this.#exclusive = concurrency;
      this.#lease = {
        holder: options.surface ?? "system",
        generation: (++this.#leaseGeneration) as Generation,
        acquiredAt: new Date().toISOString(),
        ...(options.commandId === undefined ? {} : { commandId: options.commandId }),
      };
    }
  }

  #release(concurrency: CommandConcurrency): void {
    if (concurrency === "read-concurrent") this.#activeReadCount -= 1;
    else if (concurrency === "queue-compatible") this.#activeQueueCount -= 1;
    else {
      this.#exclusive = undefined;
      this.#lease = undefined;
    }
  }
}
