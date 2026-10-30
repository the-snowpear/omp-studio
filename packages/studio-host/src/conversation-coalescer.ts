import { CONVERSATION_LIMITS, type ConversationRuntimeEvent, type StudioEventEnvelope } from "@omp-studio/studio-protocol";

type Envelope = StudioEventEnvelope<ConversationRuntimeEvent>;
type Group = { last: Envelope; chunks: string[]; bytes: number; truncated: boolean; hasOutput: boolean; items: number; retainedBytes: number; ascii: boolean };
export interface ConversationCoalescerOptions {
  readonly emit: (envelope: Envelope) => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /**
   * Continue a sliced flush on a later turn of the event loop. Default
   * `setImmediate`: Electron Main can service IPC, timers and IO between
   * slices instead of draining a whole backlog in one long task.
   */
  readonly schedule?: (callback: () => void) => unknown;
  readonly cancelSchedule?: (handle: unknown) => void;
  /** Envelopes one slice may emit before yielding (default 64). */
  readonly sliceEvents?: number;
  /** Wall-clock budget of one slice in milliseconds; 0 disables (default 4). */
  readonly sliceMs?: number;
  readonly now?: () => number;
}
const WINDOW_MS = 250;
const MAX_ITEMS = 500;
const MAX_BYTES = 1024 * 1024;
const DEFAULT_SLICE_EVENTS = 64;
const DEFAULT_SLICE_MS = 4;
/**
 * Hard ceiling on queued envelopes. Slicing trades one long task for pending
 * memory; past this depth the queue drains in one turn instead of growing while
 * a slow consumer keeps producing new work.
 */
const MAX_OUTBOX = 2_000;
const incremental = (event: ConversationRuntimeEvent) => event.kind === "conversation.message.delta" || event.kind === "conversation.tool.updated";
const payload = (event: ConversationRuntimeEvent): string => event.kind === "conversation.message.delta" ? event.delta
  : event.kind === "conversation.tool.updated" ? event.output ?? "" : "";

function adjacent(a: ConversationRuntimeEvent, b: ConversationRuntimeEvent): boolean {
  if (a.sessionId !== b.sessionId || !("turnId" in a) || !("turnId" in b) || a.turnId !== b.turnId) return false;
  if (a.kind === "conversation.message.delta" && b.kind === a.kind) {
    return a.messageId === b.messageId && a.blockId === b.blockId && a.blockType === b.blockType;
  }
  return a.kind === "conversation.tool.updated" && b.kind === a.kind && a.toolCallId === b.toolCallId
    && a.updateMode === "append" && b.updateMode === "append"
    // Replay's last-event truncated flag must not change through grouping.
    && a.truncated === b.truncated;
}

/** Bounded pre-streamSeq buffer. All callers pass already validated input. */
export class ConversationCoalescer {
  #visible: ReadonlySet<string> | undefined;
  #groups: Group[] = [];
  #tail: Group | undefined;
  #items = 0;
  #bytes = 0;
  #timer: unknown;
  #disposed = false;
  /**
   * Materialized envelopes waiting for delivery, in arrival order. Delivery is
   * split off from coalescing so a bulk flush can yield between slices without
   * changing which events end up grouped.
   */
  #outbox: Envelope[] = [];
  #outboxHead = 0;
  #scheduled: unknown;
  #draining = false;
  /** Set by an unbounded (barrier) drain: finish the queue in this turn. */
  #drainingUnbounded = false;
  /** Bumped by `reset()` so a stale scheduled slice cannot deliver a dropped epoch. */
  #generation = 0;
  readonly #setTimer: NonNullable<ConversationCoalescerOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<ConversationCoalescerOptions["clearTimer"]>;
  readonly #schedule: NonNullable<ConversationCoalescerOptions["schedule"]>;
  readonly #cancelSchedule: NonNullable<ConversationCoalescerOptions["cancelSchedule"]>;
  readonly #sliceEvents: number;
  readonly #sliceMs: number;
  readonly #now: () => number;

  constructor(readonly options: ConversationCoalescerOptions) {
    this.#setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; });
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#schedule = options.schedule ?? ((callback) => { const handle = setImmediate(callback); handle.unref?.(); return handle; });
    this.#cancelSchedule = options.cancelSchedule ?? ((handle) => clearImmediate(handle as ReturnType<typeof setImmediate>));
    this.#sliceEvents = Math.max(1, Math.trunc(options.sliceEvents ?? DEFAULT_SLICE_EVENTS));
    this.#sliceMs = Math.max(0, options.sliceMs ?? DEFAULT_SLICE_MS);
    this.#now = options.now ?? (() => Date.now());
  }

  setVisibleSessions(ids: ReadonlySet<string> | undefined): void {
    if (this.#disposed) return;
    // Reconcile before changing delivery policy: every pending group is
    // materialized with the old policy, but its delivery may still yield
    // between slices (the policy only decides how future pushes are grouped).
    this.flushSliced();
    this.#visible = ids === undefined ? undefined : new Set(ids);
  }

  push(envelope: Envelope): void {
    if (this.#disposed) return;
    const event = envelope.event;
    if (this.#visible === undefined || this.#visible.has(event.sessionId) || !incremental(event)) {
      // Barrier: this event must not overtake text that is already queued, so
      // materialize the backlog for this session first and drain it before
      // handing this envelope over.
      this.#materialize(event.sessionId);
      this.#tail = undefined;
      this.#enqueue(envelope);
      this.#drainPending();
      return;
    }
    // Conservatively account every original envelope, including metadata that
    // grouping can later discard. Never scan the growing aggregate to budget it.
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (this.#items + 1 > MAX_ITEMS || this.#bytes + bytes > MAX_BYTES) this.flushSliced();
    // An oversized envelope still joins the queue: jumping it would invert the
    // per-session order whenever a slice is pending.
    if (bytes > MAX_BYTES) { this.#enqueue(envelope); this.#drainPending(); return; }
    const text = payload(event);
    const textBytes = Buffer.byteLength(text);
    // Prefix truncation is not associative for arbitrary UTF-8: with one
    // byte free, appending "中" and then "a" retains "a", whereas one
    // append of "中a" retains neither. Lone-surrogate normalization is also
    // boundary-sensitive. Preserve those input boundaries; ASCII runs can
    // be joined without changing either the Host head or Renderer tail cap.
    const ascii = !/[^\x00-\x7f]/u.test(text);
    const last = this.#tail;
    // Limit either kind to the smaller delta budget. A group cannot create an
    // oversized wire event; a replace always remains an independent baseline.
    if (last !== undefined && last.ascii && ascii && adjacent(last.last.event, event) && last.bytes + textBytes <= CONVERSATION_LIMITS.DELTA_MAX_BYTES) {
      last.last = envelope;
      last.chunks.push(text);
      last.bytes += textBytes;
      last.truncated ||= event.kind === "conversation.tool.updated" && event.truncated === true;
      last.hasOutput ||= "output" in event;
      last.items++; last.retainedBytes += bytes;
    } else {
      const group = { last: envelope, chunks: [text], bytes: textBytes,
        truncated: event.kind === "conversation.tool.updated" && event.truncated === true, hasOutput: "output" in event, items: 1, retainedBytes: bytes, ascii };
      this.#groups.push(group); this.#tail = group;
    }
    this.#items++;
    this.#bytes += bytes;
    if (this.#items >= MAX_ITEMS || this.#bytes >= MAX_BYTES) { this.flushSliced(); return; }
    if (this.#timer === undefined) this.#timer = this.#setTimer(() => { this.#timer = undefined; this.flush(); }, WINDOW_MS);
  }

  /**
   * Coalesce pending groups and deliver them as a barrier: everything queued is
   * emitted before this returns. Used where a different channel must not
   * overtake the text (approvals/receipts, publication, runtime loss).
   */
  flush(sessionId?: string): void {
    this.#materialize(sessionId);
    this.#drainFully();
  }

  /**
   * Coalesce pending groups and deliver them in bounded slices, one slice per
   * event-loop turn. `conversation.open` uses this so the query returns after a
   * single slice instead of draining a whole background backlog: the remaining
   * envelopes keep their order and arrive as ordinary live events afterwards.
   */
  flushSliced(sessionId?: string): void {
    this.#materialize(sessionId);
    this.#drainPending();
  }

  #materialize(sessionId?: string): void {
    const groups = sessionId === undefined ? this.#groups : this.#groups.filter((group) => group.last.event.sessionId === sessionId);
    this.#groups = sessionId === undefined ? [] : this.#groups.filter((group) => group.last.event.sessionId !== sessionId);
    for (const group of groups) { this.#items -= group.items; this.#bytes -= group.retainedBytes; }
    this.#tail = undefined;
    if (this.#groups.length === 0) {
      if (this.#timer !== undefined) this.#clearTimer(this.#timer);
      this.#timer = undefined;
    }
    for (const group of groups) {
      if (this.#disposed) return;
      const original = group.last.event;
      const event: ConversationRuntimeEvent = original.kind === "conversation.message.delta"
        ? { ...original, delta: group.chunks.join("") }
        : original.kind === "conversation.tool.updated"
          ? { ...original, ...(group.hasOutput ? { output: group.chunks.join("") } : {}), ...(group.truncated ? { truncated: true } : {}) }
          : original;
      this.#outbox.push({ ...group.last, event });
    }
  }

  #enqueue(envelope: Envelope): void {
    this.#outbox.push(envelope);
  }

  #pending(): number {
    return this.#outbox.length - this.#outboxHead;
  }

  /** Slice normally; fall back to a full drain when the queue hits its ceiling. */
  #drainPending(): void {
    if (this.#pending() > MAX_OUTBOX) this.#drainFully();
    else this.#drainSliced();
  }

  #compactOutbox(): void {
    if (this.#outboxHead === 0) return;
    this.#outbox = this.#outbox.slice(this.#outboxHead);
    this.#outboxHead = 0;
  }

  #clearOutbox(): void {
    this.#outbox = [];
    this.#outboxHead = 0;
    this.#cancelScheduled();
  }

  #cancelScheduled(): void {
    if (this.#scheduled === undefined) return;
    this.#cancelSchedule(this.#scheduled);
    this.#scheduled = undefined;
  }

  /**
   * Emit at most one slice, then hand the rest to a later event-loop turn.
   * Ordering is FIFO across slices because new work always appends to the
   * outbox and nothing else consumes from it.
   */
  #drainSliced(): void {
    if (this.#disposed) { this.#clearOutbox(); return; }
    // A running drain or an already-scheduled slice owns the next turn; new
    // work stays queued behind it, so one turn can never emit two slices.
    if (this.#draining || this.#scheduled !== undefined) return;
    this.#draining = true;
    const generation = this.#generation;
    try {
      const started = this.#now();
      let emitted = 0;
      while (this.#outboxHead < this.#outbox.length) {
        const envelope = this.#outbox[this.#outboxHead] as Envelope;
        this.#outboxHead += 1;
        emitted += 1;
        this.options.emit(envelope);
        if (this.#disposed || generation !== this.#generation) return;
        if (this.#drainingUnbounded) continue;
        if (emitted < this.#sliceEvents && (this.#sliceMs === 0 || this.#now() - started < this.#sliceMs)) continue;
        if (this.#outboxHead >= this.#outbox.length) break;
        this.#compactOutbox();
        this.#scheduleSlice(generation);
        return;
      }
      this.#clearOutbox();
    } finally {
      this.#draining = false;
      this.#drainingUnbounded = false;
    }
  }

  /** Emit the whole queue in this turn (barrier semantics). */
  #drainFully(): void {
    if (this.#disposed) { this.#clearOutbox(); return; }
    this.#cancelScheduled();
    if (this.#draining) {
      // Re-entered from a listener: let the running drain finish the queue
      // instead of emitting nested events out of order.
      this.#drainingUnbounded = true;
      return;
    }
    this.#drainingUnbounded = true;
    this.#drainSliced();
  }

  #scheduleSlice(generation: number): void {
    this.#scheduled = this.#schedule(() => {
      this.#scheduled = undefined;
      if (this.#disposed || generation !== this.#generation) return;
      try {
        this.#drainSliced();
      } catch {
        // A throwing consumer must not wedge the pump: the failing envelope is
        // already consumed, so keep delivering the rest on later turns
        // (listener isolation itself is the fan-out's job).
        if (this.#outboxHead < this.#outbox.length) this.#scheduleSlice(generation);
      }
    });
  }

  getDiagnostics(): Readonly<Record<string, number>> { return { pendingItems: this.#items, pendingBytes: this.#bytes }; }

  reset(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#groups = [];
    this.#tail = undefined;
    this.#items = 0;
    this.#bytes = 0;
    this.#visible = undefined;
    // A new epoch must never deliver envelopes materialized from the old one.
    this.#generation += 1;
    this.#clearOutbox();
  }

  dispose(): void { this.#disposed = true; this.reset(); }
}
