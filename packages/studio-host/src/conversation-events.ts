import {
  parseConversationRuntimeEvent,
  type ConversationRuntimeEvent,
  type StudioEventEnvelope,
} from "@omp-studio/studio-protocol";

export const CONVERSATION_RUNTIME_EVENT_KINDS = [
  "conversation.message.started",
  "conversation.message.delta",
  "conversation.message.completed",
  "conversation.tool.started",
  "conversation.tool.updated",
  "conversation.tool.completed",
  "conversation.turn.completed",
  "conversation.turn.aborted",
  "conversation.compaction.started",
  "conversation.compaction.completed",
  "conversation.notice",
] as const satisfies readonly ConversationRuntimeEvent["kind"][];

export function isAllowListedConversationKind(kind: unknown): kind is ConversationRuntimeEvent["kind"] {
  return typeof kind === "string" && (CONVERSATION_RUNTIME_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface StudioConversationForward {
  readonly envelope: StudioEventEnvelope<ConversationRuntimeEvent>;
}

/**
 * Live conversation fan-out. Events are delivered once to current
 * subscribers and are never retained for publication replay.
 */
export class ConversationEventFanout {
  readonly #listeners = new Set<(event: StudioConversationForward) => void>();
  readonly #resyncListeners = new Set<(reason: string) => void>();

  onEvent(listener: (event: StudioConversationForward) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onResync(listener: (reason: string) => void): () => void {
    this.#resyncListeners.add(listener);
    return () => {
      this.#resyncListeners.delete(listener);
    };
  }

  /**
   * Allow-list parse and deliver. Returns true when a conversation event was
   * forwarded. Mapping failure emits resync and drops the event.
   */
  forward(envelope: StudioEventEnvelope): boolean {
    const kind =
      envelope.event !== null && typeof envelope.event === "object" && "kind" in envelope.event
        ? (envelope.event as { readonly kind?: unknown }).kind
        : undefined;
    if (!isAllowListedConversationKind(kind)) {
      return false;
    }
    let parsed: ConversationRuntimeEvent;
    try {
      parsed = parseConversationRuntimeEvent(envelope.event);
    } catch {
      this.emitResync("conversation mapping failed; re-query session.transcript.read");
      return false;
    }
    const event: StudioConversationForward = {
      envelope: { ...envelope, event: parsed },
    };
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Sibling listener isolation: one throw must not skip the rest.
      }
    }
    return true;
  }

  emitResync(reason: string): void {
    for (const listener of [...this.#resyncListeners]) {
      try {
        listener(reason);
      } catch {
        // Isolate resync subscribers the same way as event listeners.
      }
    }
  }

  dispose(): void {
    this.#listeners.clear();
    this.#resyncListeners.clear();
  }
}
