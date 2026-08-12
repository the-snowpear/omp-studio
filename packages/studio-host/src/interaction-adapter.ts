import type {
  CommandId,
  InteractionId,
  RemoteInteractionRequest,
  RemoteInteractionRequiredEvent,
  RemoteInteractionResponse,
  StudioOperation,
} from "@omp-studio/studio-protocol";
import { CommandArbiter, StudioHostError, type InteractionSurface } from "./command-arbiter.js";
import { HostConfirmationRegistry } from "./host-confirmation.js";

/**
 * Transport acknowledgement for a dispatched StudioOperation. A resolved invoke
 * with status "accepted" or "completed" is the explicit signal that the Runtime
 * acknowledged the respond or transfer; only then does the host interaction
 * complete. A rejection or any unexpected status fails closed without
 * completing the host interaction.
 */
export type RemoteInteractionInvokeResult = { status: "accepted" | "completed" };

export type RemoteInteractionInvoke = (operation: StudioOperation) => Promise<RemoteInteractionInvokeResult>;

export type RemoteInteractionDecision = "submit" | "cancel";

export interface RemoteInteractionRespondInput {
  interactionId: InteractionId;
  commandId: CommandId;
  decision: RemoteInteractionDecision;
  value?: unknown;
  owner: InteractionSurface;
  /** One-shot token; required for destructive confirm and approval submits. */
  confirmationToken?: string;
}

export interface PendingRemoteInteraction {
  interactionId: InteractionId;
  commandId: CommandId;
  title: string;
  owner: InteractionSurface;
  generation: number;
  request: RemoteInteractionRequest;
}

function isHighRisk(request: RemoteInteractionRequest): boolean {
  return request.kind === "approval" || (request.kind === "confirm" && request.destructive === true);
}

export class RemoteInteractionAdapter {
  #pending: PendingRemoteInteraction | undefined;
  #inFlight = false;

  constructor(
    private readonly arbiter: CommandArbiter,
    private readonly confirmations: HostConfirmationRegistry,
    private readonly invoke: RemoteInteractionInvoke,
  ) {}

  /**
   * Adopt a validated Runtime-issued interaction event. Registers the exact
   * interaction identity and generation with the arbiter and retains a single
   * path-free pending request. The adapter never auto-transfers, including on
   * TERMINAL_REQUIRED; transferToTui() is the only transfer path.
   */
  adopt(event: RemoteInteractionRequiredEvent): PendingRemoteInteraction {
    const ownership = this.arbiter.adoptInteraction(
      event.request.interactionId,
      event.request.commandId,
      event.owner,
      event.leaseGeneration,
    );
    const pending: PendingRemoteInteraction = {
      interactionId: ownership.interactionId,
      commandId: ownership.commandId,
      title: event.request.title,
      owner: ownership.owner,
      generation: ownership.generation,
      request: event.request,
    };
    this.#pending = pending;
    return this.#clonePending(pending);
  }

  /** Defensive clone of the pending interaction, or undefined while idle. */
  pending(): PendingRemoteInteraction | undefined {
    return this.#pending === undefined ? undefined : this.#clonePending(this.#pending);
  }

  /**
   * Respond to the pending interaction. Ownership and generation are asserted
   * against the arbiter; destructive confirm and approval submits require a
   * one-shot confirmation token bound to the exact respond operation and owner.
   * The host interaction completes only after invoke acknowledges the response;
   * every failure path leaves the interaction pending (fail closed).
   */
  async respond(input: RemoteInteractionRespondInput): Promise<void> {
    const pending = this.#pending;
    if (pending === undefined) {
      throw new StudioHostError("INTERACTION_STALE", "No interaction is pending");
    }
    if (this.#inFlight) {
      throw new StudioHostError("COMMAND_BLOCKED", "An interaction operation is already in flight");
    }
    const operation: RemoteInteractionResponse = {
      kind: "interaction.respond",
      interactionId: input.interactionId,
      commandId: input.commandId,
      decision: input.decision,
      ...(input.value === undefined ? {} : { value: input.value }),
    };
    const ownership = this.arbiter.assertInteraction(
      input.interactionId,
      input.commandId,
      input.owner,
      pending.generation,
    );
    this.#inFlight = true;
    try {
      if (input.decision === "submit" && isHighRisk(pending.request)) {
        if (input.confirmationToken === undefined) {
          throw new StudioHostError("INVALID_ARGUMENT", "Confirmation token is required for this interaction response");
        }
        this.confirmations.consume(input.confirmationToken, operation, input.owner);
      }
      await this.#acknowledged(operation);
      this.arbiter.completeInteraction(input.interactionId, input.commandId, input.owner, ownership.generation);
      this.#pending = undefined;
    } finally {
      this.#inFlight = false;
    }
  }

  /**
   * Explicitly transfer the pending interaction to the TUI. Requires current
   * gui ownership; the transfer operation is dispatched before the arbiter and
   * pending owner/generation advance. Any failure leaves ownership unchanged.
   */
  async transferToTui(): Promise<PendingRemoteInteraction> {
    const pending = this.#pending;
    if (pending === undefined) {
      throw new StudioHostError("INTERACTION_STALE", "No interaction is pending");
    }
    if (this.#inFlight) {
      throw new StudioHostError("COMMAND_BLOCKED", "An interaction operation is already in flight");
    }
    const ownership = this.arbiter.assertInteraction(
      pending.interactionId,
      pending.commandId,
      "gui",
      pending.generation,
    );
    this.#inFlight = true;
    try {
      await this.#acknowledged({
        kind: "tui.transfer",
        commandId: pending.commandId,
        interactionId: pending.interactionId,
      });
      const transferred = this.arbiter.transferInteraction(pending.interactionId, "gui", "tui");
      const updated: PendingRemoteInteraction = {
        ...pending,
        owner: transferred.owner,
        generation: transferred.generation,
      };
      this.#pending = updated;
      return this.#clonePending(updated);
    } finally {
      this.#inFlight = false;
    }
  }

  async #acknowledged(operation: StudioOperation): Promise<void> {
    const result = await this.invoke(operation);
    if (result.status !== "accepted" && result.status !== "completed") {
      throw new StudioHostError("INTERNAL_ERROR", "Interaction operation was not acknowledged");
    }
  }

  #clonePending(pending: PendingRemoteInteraction): PendingRemoteInteraction {
    return structuredClone(pending);
  }
}