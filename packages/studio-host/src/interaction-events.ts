import type {
  CommandId,
  RemoteInteractionRequiredEvent,
  StudioEventEnvelope,
  StudioInteractionResolvedEvent,
} from "@omp-studio/studio-protocol";

export interface StudioInteractionForward {
  readonly envelope: StudioEventEnvelope<RemoteInteractionRequiredEvent | StudioInteractionResolvedEvent>;
  readonly clientRequestId?: string;
}

/**
 * Live interaction fan-out. Both `interaction.required` and
 * `interaction.resolved` are forwarded; events are delivered once to
 * current subscribers and are never retained for publication replay.
 * `clientRequestId` is optional — interactions without a correlated client
 * command are still forwarded.
 */
export class InteractionEventFanout {
  readonly #listeners = new Set<(event: StudioInteractionForward) => void>();

  onEvent(listener: (event: StudioInteractionForward) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Deliver a Runtime `interaction.required` / `interaction.resolved`
   * envelope. Returns true when the event was forwarded. Listener
   * exceptions are isolated; duplicate or higher-generation events are
   * forwarded as-is and never interrupt the Bridge path.
   */
  forward(
    envelope: StudioEventEnvelope,
    resolveRequestId: (commandId: CommandId) => string | undefined,
  ): boolean {
    const event = envelope.event;
    if (event === null || typeof event !== "object" || !("kind" in event)) {
      return false;
    }
    if (event.kind === "interaction.required") {
      const required = event as RemoteInteractionRequiredEvent;
      const clientRequestId = resolveRequestId(required.request.commandId);
      const forwarded: StudioInteractionForward = {
        envelope: { ...envelope, event: required },
        ...(clientRequestId === undefined ? {} : { clientRequestId }),
      };
      this.#deliver(forwarded);
      return true;
    }
    if (event.kind === "interaction.resolved") {
      const resolved = event as StudioInteractionResolvedEvent;
      this.#deliver({ envelope: { ...envelope, event: resolved } });
      return true;
    }
    return false;
  }

  #deliver(forwarded: StudioInteractionForward): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(forwarded);
      } catch {
        // Sibling listener isolation: one throw must not skip the rest.
      }
    }
  }

  dispose(): void {
    this.#listeners.clear();
  }
}
