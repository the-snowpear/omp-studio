import {
  CONVERSATION_LIMITS,
  parseConversationRuntimeEvent,
  truncateUtf8,
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

export const CONVERSATION_REPLAY_EVENT_LIMIT = 512;

export function isAllowListedConversationKind(kind: unknown): kind is ConversationRuntimeEvent["kind"] {
  return typeof kind === "string" && (CONVERSATION_RUNTIME_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface StudioConversationForward {
  readonly envelope: StudioEventEnvelope<ConversationRuntimeEvent>;
}

type ReplaySession = {
  turnId?: string;
  overflowed?: boolean;
  readonly events: Map<string, StudioConversationForward>;
  readonly deltaChunks: Map<string, { total: string; lastKey: string; nextIndex: number }>;
};

function turnIdOf(event: ConversationRuntimeEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

function eventSeqOf(event: StudioConversationForward): number {
  return Number(event.envelope.eventSeq);
}

/**
 * Live conversation fan-out. Besides current delivery, it retains a bounded,
 * normalized reconstruction of each session's open turn. Desktop session
 * selection can explicitly replay that reconstruction after publishing the
 * selected Runtime identity; ordinary facade reloads do not replay it.
 */
export class ConversationEventFanout {
  readonly #listeners = new Set<(event: StudioConversationForward) => void>();
  readonly #resyncListeners = new Set<(reason: string) => void>();
  readonly #replay = new Map<string, ReplaySession>();

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

  replay(sessionId: ConversationRuntimeEvent["sessionId"], listener: (event: StudioConversationForward) => void): void {
    const session = this.#replay.get(sessionId);
    if (session?.overflowed === true) {
      this.emitResync("live conversation replay exceeded the Host limit; re-read the open transcript");
      return;
    }
    const events = [...(session?.events.values() ?? [])]
      .sort((left, right) => eventSeqOf(left) - eventSeqOf(right));
    for (const event of events) {
      try {
        listener(structuredClone(event));
      } catch {
        // Replay consumers are isolated just like live subscribers.
      }
    }
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
      this.emitResync("conversation mapping failed; re-read open transcripts");
      return false;
    }
    const event: StudioConversationForward = {
      envelope: { ...envelope, event: parsed },
    };
    this.#remember(event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Sibling listener isolation: one throw must not skip the rest.
      }
    }
    return true;
  }

  #remember(forward: StudioConversationForward): void {
    const event = forward.envelope.event;
    const sessionId = event.sessionId;
    if (event.kind === "conversation.turn.completed" || event.kind === "conversation.turn.aborted") {
      this.#replay.delete(sessionId);
      return;
    }
    if (event.kind === "conversation.notice") return;
    if (event.kind === "conversation.compaction.completed") {
      this.#replay.get(sessionId)?.events.delete("compaction");
      return;
    }
    let session = this.#replay.get(sessionId);
    if (session === undefined) {
      session = { events: new Map(), deltaChunks: new Map() };
      this.#replay.set(sessionId, session);
    }
    const turnId = turnIdOf(event);
    if (turnId !== undefined && session.turnId !== turnId) {
      session.events.clear();
      session.deltaChunks.clear();
      session.turnId = turnId;
      session.overflowed = false;
    }
    switch (event.kind) {
      case "conversation.message.started":
        this.#store(session, `message-started:${event.messageId}`, structuredClone(forward));
        return;
      case "conversation.message.delta":
        this.#rememberDelta(session, forward, event);
        return;
      case "conversation.message.completed":
        session.events.delete(`message-started:${event.messageId}`);
        for (const key of [...session.events.keys()]) {
          if (key.startsWith(`message-delta:${event.messageId}:`)) session.events.delete(key);
        }
        for (const key of [...session.deltaChunks.keys()]) {
          if (key.startsWith(`${event.messageId}:`)) session.deltaChunks.delete(key);
        }
        this.#store(session, `message-completed:${event.messageId}`, structuredClone(forward));
        return;
      case "conversation.tool.started":
        this.#store(session, `tool-started:${event.toolCallId}`, structuredClone(forward));
        return;
      case "conversation.tool.updated": {
        const key = `tool-updated:${event.toolCallId}`;
        const previous = session.events.get(key)?.envelope.event;
        const previousOutput = previous?.kind === "conversation.tool.updated" ? (previous.output ?? "") : "";
        const raw = event.updateMode === "replace" ? (event.output ?? "") : previousOutput + (event.output ?? "");
        const bounded = truncateUtf8(raw, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
        this.#store(session, key, {
          envelope: {
            ...forward.envelope,
            event: {
              ...event,
              updateMode: "replace",
              ...(bounded.text.length === 0 ? {} : { output: bounded.text }),
              ...(event.truncated === true || bounded.truncated ? { truncated: true } : {}),
            },
          },
        });
        return;
      }
      case "conversation.tool.completed":
        session.events.delete(`tool-updated:${event.toolCallId}`);
        this.#store(session, `tool-completed:${event.toolCallId}`, structuredClone(forward));
        return;
      case "conversation.compaction.started":
        this.#store(session, "compaction", structuredClone(forward));
        return;
      default:
        return;
    }
  }

  #store(session: ReplaySession, key: string, event: StudioConversationForward): void {
    if (session.overflowed === true) return;
    session.events.set(key, event);
    if (session.events.size <= CONVERSATION_REPLAY_EVENT_LIMIT) return;
    session.events.clear();
    session.deltaChunks.clear();
    session.overflowed = true;
  }

  #rememberDelta(
    session: ReplaySession,
    forward: StudioConversationForward,
    event: Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }>,
  ): void {
    if (session.overflowed === true) return;
    const blockKey = `${event.messageId}:${event.blockId}`;
    const meta = session.deltaChunks.get(blockKey) ?? {
      total: "",
      lastKey: `message-delta:${blockKey}:0`,
      nextIndex: 1,
    };
    const boundedTotal = truncateUtf8(meta.total + event.delta, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
    const addition = boundedTotal.text.slice(meta.total.length);
    meta.total = boundedTotal.text;
    if (addition.length === 0) {
      session.deltaChunks.set(blockKey, meta);
      return;
    }
    const previous = session.events.get(meta.lastKey);
    const previousEvent = previous?.envelope.event;
    if (previous !== undefined && previousEvent?.kind === "conversation.message.delta") {
      const combined = truncateUtf8(previousEvent.delta + addition, CONVERSATION_LIMITS.DELTA_MAX_BYTES);
      this.#store(session, meta.lastKey, {
        envelope: {
          ...(combined.truncated ? previous.envelope : forward.envelope),
          event: { ...event, delta: combined.text },
        },
      });
      if (combined.truncated) {
        const remainder = (previousEvent.delta + addition).slice(combined.text.length);
        if (remainder.length > 0) {
          meta.lastKey = `message-delta:${blockKey}:${meta.nextIndex}`;
          meta.nextIndex += 1;
          this.#store(session, meta.lastKey, {
            envelope: { ...forward.envelope, event: { ...event, delta: remainder } },
          });
        }
      }
    } else {
      this.#store(session, meta.lastKey, structuredClone(forward));
    }
    if (session.events.size > 0) session.deltaChunks.set(blockKey, meta);
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
    this.#replay.clear();
  }
}
