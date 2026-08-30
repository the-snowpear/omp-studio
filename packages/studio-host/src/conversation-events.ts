import {
  CONVERSATION_LIMITS,
  parseConversationRuntimeEvent,
  truncateUtf8,
  utf8ByteLength,
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

export const CONVERSATION_REPLAY_EVENT_LIMIT = CONVERSATION_LIMITS.LIVE_REPLAY_MAX_EVENTS;
/** Includes event envelopes and retained coalesced text, measured as UTF-8 JSON. */
export const CONVERSATION_REPLAY_MAX_BYTES = CONVERSATION_LIMITS.LIVE_REPLAY_MAX_BYTES;
export const CONVERSATION_REPLAY_GLOBAL_MAX_BYTES = 16 * 1024 * 1024;
export const CONVERSATION_REPLAY_SESSION_LIMIT = 32;

export function isAllowListedConversationKind(kind: unknown): kind is ConversationRuntimeEvent["kind"] {
  return typeof kind === "string" && (CONVERSATION_RUNTIME_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface StudioConversationForward {
  readonly envelope: StudioEventEnvelope<ConversationRuntimeEvent>;
  /** Monotonic within one conversation session and Runtime controller lifetime. */
  readonly streamSeq: number;
}

type ReplaySession = {
  turnId?: string;
  overflowed?: boolean;
  byteSize: number;
  readonly events: Map<string, StudioConversationForward>;
  readonly eventBytes: Map<string, number>;
  readonly deltaChunks: Map<string, { totalBytes: number; lastKey: string; nextIndex: number }>;
};

function turnIdOf(event: ConversationRuntimeEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
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
  readonly #streamSeq = new Map<string, number>();
  readonly #evictedTurns = new Map<string, string | undefined>();
  #replayBytes = 0;

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

  snapshot(sessionId: ConversationRuntimeEvent["sessionId"]):
    | { readonly status: "complete"; readonly watermark: number; readonly events: readonly StudioConversationForward[] }
    | { readonly status: "resyncRequired"; readonly watermark: number; readonly events: readonly []; readonly reason: string } {
    const session = this.#replay.get(sessionId);
    const watermark = this.#streamSeq.get(sessionId) ?? 0;
    if (session?.overflowed === true || this.#evictedTurns.has(sessionId)) {
      return {
        status: "resyncRequired",
        watermark,
        events: [],
        reason: "live conversation replay exceeded the Host byte or event limit; reopen the conversation",
      };
    }
    const events = [...(session?.events.values() ?? [])]
      .sort((left, right) => left.streamSeq - right.streamSeq)
      .map((event) => structuredClone(event));
    return { status: "complete", watermark, events };
  }

  replay(sessionId: ConversationRuntimeEvent["sessionId"], listener: (event: StudioConversationForward) => void): void {
    const snapshot = this.snapshot(sessionId);
    if (snapshot.status === "resyncRequired") {
      this.emitResync(snapshot.reason);
      return;
    }
    for (const event of snapshot.events) {
      try {
        listener(event);
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
    const sessionId = parsed.sessionId;
    const streamSeq = (this.#streamSeq.get(sessionId) ?? 0) + 1;
    this.#streamSeq.set(sessionId, streamSeq);
    const event: StudioConversationForward = {
      envelope: { ...envelope, event: parsed },
      streamSeq,
    };
    this.#remember(event);
    this.#enforceGlobalBudget(sessionId);
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
    let session = this.#replay.get(sessionId);
    const turnId = turnIdOf(event);
    if (session === undefined && this.#evictedTurns.has(sessionId)) {
      const evictedTurn = this.#evictedTurns.get(sessionId);
      if (turnId === undefined || turnId === evictedTurn) return;
      this.#evictedTurns.delete(sessionId);
    }
    if (session === undefined) {
      session = {
        events: new Map(),
        eventBytes: new Map(),
        deltaChunks: new Map(),
        byteSize: 0,
      };
      this.#replay.set(sessionId, session);
    }
    if (turnId !== undefined && session.turnId !== turnId) {
      this.#clear(session);
      session.turnId = turnId;
      session.overflowed = false;
      this.#evictedTurns.delete(sessionId);
    }
    switch (event.kind) {
      case "conversation.message.started":
        this.#store(session, `message-started:${event.messageId}`, structuredClone(forward));
        return;
      case "conversation.message.delta":
        this.#rememberDelta(session, forward, event);
        return;
      case "conversation.message.completed":
        this.#delete(session, `message-started:${event.messageId}`);
        for (const key of [...session.events.keys()]) {
          if (key.startsWith(`message-delta:${event.messageId}:`)) this.#delete(session, key);
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
          streamSeq: forward.streamSeq,
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
        this.#delete(session, `tool-updated:${event.toolCallId}`);
        this.#store(session, `tool-completed:${event.toolCallId}`, structuredClone(forward));
        return;
      case "conversation.turn.completed":
      case "conversation.turn.aborted":
        this.#store(session, "turn-terminal", structuredClone(forward));
        return;
      case "conversation.compaction.started":
        this.#store(session, "compaction", structuredClone(forward));
        return;
      case "conversation.compaction.completed":
        this.#delete(session, "compaction");
        this.#store(session, "compaction-completed", structuredClone(forward));
        return;
      case "conversation.notice":
        this.#store(session, `notice:${forward.streamSeq}`, structuredClone(forward));
        return;
      default:
        return;
    }
  }

  #store(session: ReplaySession, key: string, event: StudioConversationForward): void {
    if (session.overflowed === true) return;
    const previousBytes = session.eventBytes.get(key) ?? 0;
    const bytes = utf8ByteLength(JSON.stringify(event));
    session.events.set(key, event);
    session.eventBytes.set(key, bytes);
    session.byteSize += bytes - previousBytes;
    this.#replayBytes += bytes - previousBytes;
    if (session.events.size <= CONVERSATION_REPLAY_EVENT_LIMIT && session.byteSize <= CONVERSATION_REPLAY_MAX_BYTES) return;
    this.#clear(session);
    session.overflowed = true;
  }

  #delete(session: ReplaySession, key: string): void {
    const bytes = session.eventBytes.get(key);
    if (bytes !== undefined) {
      session.byteSize -= bytes;
      this.#replayBytes -= bytes;
    }
    session.eventBytes.delete(key);
    session.events.delete(key);
  }

  #clear(session: ReplaySession): void {
    this.#replayBytes -= session.byteSize;
    session.events.clear();
    session.eventBytes.clear();
    session.deltaChunks.clear();
    session.byteSize = 0;
  }

  #enforceGlobalBudget(recentSessionId: string): void {
    const recent = this.#replay.get(recentSessionId);
    if (recent !== undefined) {
      this.#replay.delete(recentSessionId);
      this.#replay.set(recentSessionId, recent);
    }
    while (
      this.#replay.size > CONVERSATION_REPLAY_SESSION_LIMIT ||
      this.#replayBytes > CONVERSATION_REPLAY_GLOBAL_MAX_BYTES
    ) {
      const oldest = this.#replay.entries().next().value as [string, ReplaySession] | undefined;
      if (oldest === undefined) return;
      const [sessionId, session] = oldest;
      this.#evictedTurns.set(sessionId, session.turnId);
      this.#clear(session);
      this.#replay.delete(sessionId);
    }
  }

  #rememberDelta(
    session: ReplaySession,
    forward: StudioConversationForward,
    event: Extract<ConversationRuntimeEvent, { kind: "conversation.message.delta" }>,
  ): void {
    if (session.overflowed === true) return;
    const blockKey = `${event.messageId}:${event.blockId}`;
    const meta = session.deltaChunks.get(blockKey) ?? {
      totalBytes: 0,
      lastKey: `message-delta:${blockKey}:0`,
      nextIndex: 1,
    };
    const remaining = Math.max(0, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES - meta.totalBytes);
    const addition = truncateUtf8(event.delta, remaining).text;
    meta.totalBytes += utf8ByteLength(addition);
    if (addition.length === 0) {
      session.deltaChunks.set(blockKey, meta);
      return;
    }
    const previous = session.events.get(meta.lastKey);
    const previousEvent = previous?.envelope.event;
    if (previous !== undefined && previousEvent?.kind === "conversation.message.delta") {
      const combined = truncateUtf8(previousEvent.delta + addition, CONVERSATION_LIMITS.DELTA_MAX_BYTES);
      this.#store(session, meta.lastKey, {
        streamSeq: forward.streamSeq,
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
            streamSeq: forward.streamSeq,
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
    this.#streamSeq.clear();
    this.#evictedTurns.clear();
    this.#replayBytes = 0;
  }
}
