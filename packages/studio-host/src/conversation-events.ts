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
export const CONVERSATION_REPLAY_BYTE_LIMIT = 512 * 1024;
export const CONVERSATION_REPLAY_SESSION_LIMIT = 32;

export function isAllowListedConversationKind(kind: unknown): kind is ConversationRuntimeEvent["kind"] {
  return typeof kind === "string" && (CONVERSATION_RUNTIME_EVENT_KINDS as readonly string[]).includes(kind);
}

export interface StudioConversationForward {
  readonly envelope: StudioEventEnvelope<ConversationRuntimeEvent>;
}

type ReplaySession = {
  turnId?: string;
  overflowed?: boolean;
  byteLength: number;
  readonly events: Map<string, StudioConversationForward>;
  readonly eventBytes: Map<string, number>;
  readonly deltaChunks: Map<string, { totalBytes: number; lastKey: string; nextIndex: number }>;
  readonly toolChunks: Map<string, { totalBytes: number; lastKey: string; nextIndex: number }>;
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
  readonly #evictedSessions = new Map<string, string | undefined>();

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
    if (session === undefined && this.#evictedSessions.has(sessionId)) {
      this.emitResync("live conversation replay was evicted by the Host limit; re-read the open transcript");
      return;
    }
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
      this.#evictedSessions.delete(sessionId);
      return;
    }
    if (event.kind === "conversation.notice") return;
    if (event.kind === "conversation.compaction.completed") {
      const session = this.#replay.get(sessionId);
      if (session !== undefined) this.#delete(session, "compaction");
      return;
    }
    let session = this.#replay.get(sessionId);
    if (session === undefined) {
      if (this.#replay.size >= CONVERSATION_REPLAY_SESSION_LIMIT) {
        const oldest = this.#replay.entries().next().value as [string, ReplaySession] | undefined;
        if (oldest !== undefined) {
          this.#replay.delete(oldest[0]);
          this.#rememberEviction(oldest[0], oldest[1].turnId);
        }
        this.emitResync("live conversation replay session limit exceeded; re-read open transcripts");
      }
      const evictedTurnId = this.#evictedSessions.get(sessionId);
      const restored: ReplaySession = {
        byteLength: 0,
        events: new Map(),
        eventBytes: new Map(),
        deltaChunks: new Map(),
        toolChunks: new Map(),
      };
      if (this.#evictedSessions.has(sessionId)) restored.overflowed = true;
      if (evictedTurnId !== undefined) restored.turnId = evictedTurnId;
      session = restored;
      this.#replay.set(sessionId, session);
    }
    if (session === undefined) return;
    const turnId = turnIdOf(event);
    if (turnId !== undefined && session.turnId !== turnId) {
      this.#reset(session);
      session.turnId = turnId;
      session.overflowed = false;
      this.#evictedSessions.delete(sessionId);
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
        this.#deleteToolChunks(session, event.toolCallId);
        this.#store(session, `tool-started:${event.toolCallId}`, structuredClone(forward));
        return;
      case "conversation.tool.updated":
        this.#rememberToolUpdate(session, forward, event);
        return;
      case "conversation.tool.completed":
        this.#deleteToolChunks(session, event.toolCallId);
        this.#store(session, `tool-completed:${event.toolCallId}`, structuredClone(forward));
        return;
      case "conversation.compaction.started":
        this.#store(session, "compaction", structuredClone(forward));
        return;
      default:
        return;
    }
  }

  #store(session: ReplaySession, key: string, event: StudioConversationForward, bytes?: number): void {
    if (session.overflowed === true) return;
    const previousBytes = session.eventBytes.get(key) ?? 0;
    const nextBytes = bytes ?? Buffer.byteLength(JSON.stringify(event), "utf8");
    const nextTotal = session.byteLength - previousBytes + nextBytes;
    if (
      (previousBytes === 0 && session.events.size >= CONVERSATION_REPLAY_EVENT_LIMIT) ||
      nextTotal > CONVERSATION_REPLAY_BYTE_LIMIT
    ) {
      this.#reset(session);
      session.overflowed = true;
      return;
    }
    session.events.set(key, event);
    session.eventBytes.set(key, nextBytes);
    session.byteLength = nextTotal;
  }

  #delete(session: ReplaySession, key: string): void {
    if (!session.events.delete(key)) return;
    session.byteLength -= session.eventBytes.get(key) ?? 0;
    session.eventBytes.delete(key);
  }

  #reset(session: ReplaySession): void {
    session.events.clear();
    session.eventBytes.clear();
    session.deltaChunks.clear();
    session.toolChunks.clear();
    session.byteLength = 0;
  }

  #rememberEviction(sessionId: string, turnId: string | undefined): void {
    this.#evictedSessions.delete(sessionId);
    this.#evictedSessions.set(sessionId, turnId);
    while (this.#evictedSessions.size > CONVERSATION_REPLAY_SESSION_LIMIT) {
      const oldest = this.#evictedSessions.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.#evictedSessions.delete(oldest);
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
    const remainingBytes = CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES - meta.totalBytes;
    const addition = remainingBytes <= 0 ? "" : truncateUtf8(event.delta, remainingBytes).text;
    meta.totalBytes += Buffer.byteLength(addition, "utf8");
    if (addition.length === 0) {
      session.deltaChunks.set(blockKey, meta);
      return;
    }
    const previous = session.events.get(meta.lastKey);
    const previousEvent = previous?.envelope.event;
    if (previous !== undefined && previousEvent?.kind === "conversation.message.delta") {
      const combined = truncateUtf8(previousEvent.delta + addition, CONVERSATION_LIMITS.DELTA_MAX_BYTES);
      const previousBytes = session.eventBytes.get(meta.lastKey);
      const combinedBytes =
        previousBytes === undefined
          ? undefined
          : previousBytes - Buffer.byteLength(previousEvent.delta, "utf8") + Buffer.byteLength(combined.text, "utf8");
      this.#store(session, meta.lastKey, {
        envelope: {
          ...(combined.truncated ? previous.envelope : forward.envelope),
          event: { ...event, delta: combined.text },
        },
      }, combinedBytes);
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

  #rememberToolUpdate(
    session: ReplaySession,
    forward: StudioConversationForward,
    event: Extract<ConversationRuntimeEvent, { kind: "conversation.tool.updated" }>,
  ): void {
    if (session.overflowed === true) return;
    const toolCallId = event.toolCallId;
    if (event.updateMode === "replace") {
      this.#deleteToolChunks(session, toolCallId);
      const bounded = truncateUtf8(event.output ?? "", CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
      const key = `tool-updated:${toolCallId}:0`;
      this.#store(session, key, {
        envelope: {
          ...forward.envelope,
          event: {
            ...event,
            ...(bounded.text.length === 0 ? {} : { output: bounded.text }),
            ...(event.truncated === true || bounded.truncated ? { truncated: true } : {}),
          },
        },
      });
      if (session.events.has(key)) {
        session.toolChunks.set(toolCallId, {
          totalBytes: Buffer.byteLength(bounded.text, "utf8"),
          lastKey: key,
          nextIndex: 1,
        });
      }
      return;
    }

    const meta = session.toolChunks.get(toolCallId) ?? {
      totalBytes: 0,
      lastKey: `tool-updated:${toolCallId}:0`,
      nextIndex: 0,
    };
    const remainingBytes = CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES - meta.totalBytes;
    const incoming = event.output ?? "";
    const boundedAddition =
      remainingBytes <= 0
        ? { text: "", truncated: Buffer.byteLength(incoming, "utf8") > 0 }
        : truncateUtf8(incoming, remainingBytes);
    const addition = boundedAddition.text;
    const chunkEvent =
      event.truncated === true || boundedAddition.truncated ? { ...event, truncated: true as const } : event;
    meta.totalBytes += Buffer.byteLength(addition, "utf8");
    if (addition.length === 0) {
      if (boundedAddition.truncated) {
        const previous = session.events.get(meta.lastKey);
        const previousEvent = previous?.envelope.event;
        if (previous !== undefined && previousEvent?.kind === "conversation.tool.updated" && previousEvent.truncated !== true) {
          this.#store(session, meta.lastKey, {
            envelope: { ...previous.envelope, event: { ...previousEvent, truncated: true } },
          });
        }
      }
      session.toolChunks.set(toolCallId, meta);
      return;
    }

    const previous = session.events.get(meta.lastKey);
    const previousEvent = previous?.envelope.event;
    if (previous !== undefined && previousEvent?.kind === "conversation.tool.updated" && previousEvent.updateMode === "append") {
      const previousOutput = previousEvent.output ?? "";
      const combined = truncateUtf8(previousOutput + addition, CONVERSATION_LIMITS.DELTA_MAX_BYTES);
      const previousBytes = session.eventBytes.get(meta.lastKey);
      const combinedBytes =
        previousBytes === undefined
          ? undefined
          : previousBytes - Buffer.byteLength(previousOutput, "utf8") + Buffer.byteLength(combined.text, "utf8");
      this.#store(session, meta.lastKey, {
        envelope: { ...forward.envelope, event: { ...chunkEvent, output: combined.text } },
      }, combinedBytes);
      if (combined.truncated) {
        const remainder = (previousOutput + addition).slice(combined.text.length);
        if (remainder.length > 0) {
          meta.lastKey = `tool-updated:${toolCallId}:${meta.nextIndex}`;
          meta.nextIndex += 1;
          this.#store(session, meta.lastKey, {
            envelope: { ...forward.envelope, event: { ...chunkEvent, output: remainder } },
          });
        }
      }
    } else {
      meta.lastKey = `tool-updated:${toolCallId}:${meta.nextIndex}`;
      meta.nextIndex += 1;
      this.#store(session, meta.lastKey, {
        envelope: { ...forward.envelope, event: { ...chunkEvent, output: addition } },
      });
    }
    if (session.events.size > 0) session.toolChunks.set(toolCallId, meta);
  }

  #deleteToolChunks(session: ReplaySession, toolCallId: string): void {
    for (const key of [...session.events.keys()]) {
      if (key.startsWith(`tool-updated:${toolCallId}:`)) this.#delete(session, key);
    }
    session.toolChunks.delete(toolCallId);
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
    this.#evictedSessions.clear();
  }
}
