import { CONVERSATION_LIMITS, type ConversationRuntimeEvent, type StudioEventEnvelope } from "@omp-studio/studio-protocol";

type Envelope = StudioEventEnvelope<ConversationRuntimeEvent>;
type Group = { last: Envelope; chunks: string[]; bytes: number; truncated: boolean; hasOutput: boolean };
export interface ConversationCoalescerOptions {
  readonly emit: (envelope: Envelope) => void;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}
const WINDOW_MS = 250;
const MAX_ITEMS = 500;
const MAX_BYTES = 1024 * 1024;
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
  #items = 0;
  #bytes = 0;
  #timer: unknown;
  #disposed = false;
  readonly #setTimer: NonNullable<ConversationCoalescerOptions["setTimer"]>;
  readonly #clearTimer: NonNullable<ConversationCoalescerOptions["clearTimer"]>;

  constructor(readonly options: ConversationCoalescerOptions) {
    this.#setTimer = options.setTimer ?? ((callback, ms) => { const timer = setTimeout(callback, ms); timer.unref?.(); return timer; });
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  setVisibleSessions(ids: ReadonlySet<string> | undefined): void {
    if (this.#disposed) return;
    this.flush(); // reconcile before changing delivery policy
    this.#visible = ids === undefined ? undefined : new Set(ids);
  }

  push(envelope: Envelope): void {
    if (this.#disposed) return;
    const event = envelope.event;
    if (this.#visible === undefined || this.#visible.has(event.sessionId) || !incremental(event)) {
      this.flush();
      this.options.emit(envelope);
      return;
    }
    // Conservatively account every original envelope, including metadata that
    // grouping can later discard. Never scan the growing aggregate to budget it.
    const bytes = Buffer.byteLength(JSON.stringify(envelope));
    if (this.#items + 1 > MAX_ITEMS || this.#bytes + bytes > MAX_BYTES) this.flush();
    if (bytes > MAX_BYTES) { this.options.emit(envelope); return; }
    const text = payload(event);
    const textBytes = Buffer.byteLength(text);
    const last = this.#groups.at(-1);
    // Limit either kind to the smaller delta budget. A group cannot create an
    // oversized wire event; a replace always remains an independent baseline.
    if (last !== undefined && adjacent(last.last.event, event) && last.bytes + textBytes <= CONVERSATION_LIMITS.DELTA_MAX_BYTES) {
      last.last = envelope;
      last.chunks.push(text);
      last.bytes += textBytes;
      last.truncated ||= event.kind === "conversation.tool.updated" && event.truncated === true;
      last.hasOutput ||= "output" in event;
    } else {
      this.#groups.push({ last: envelope, chunks: [text], bytes: textBytes,
        truncated: event.kind === "conversation.tool.updated" && event.truncated === true, hasOutput: "output" in event });
    }
    this.#items++;
    this.#bytes += bytes;
    if (this.#items >= MAX_ITEMS || this.#bytes >= MAX_BYTES) { this.flush(); return; }
    if (this.#timer === undefined) this.#timer = this.#setTimer(() => { this.#timer = undefined; this.flush(); }, WINDOW_MS);
  }

  flush(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    const groups = this.#groups;
    this.#groups = [];
    this.#items = 0;
    this.#bytes = 0;
    for (const group of groups) {
      if (this.#disposed) break;
      const original = group.last.event;
      const event: ConversationRuntimeEvent = original.kind === "conversation.message.delta"
        ? { ...original, delta: group.chunks.join("") }
        : original.kind === "conversation.tool.updated"
          ? { ...original, ...(group.hasOutput ? { output: group.chunks.join("") } : {}), ...(group.truncated ? { truncated: true } : {}) }
          : original;
      this.options.emit({ ...group.last, event });
    }
  }

  getDiagnostics(): Readonly<Record<string, number>> { return { pendingItems: this.#items, pendingBytes: this.#bytes }; }

  reset(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#groups = [];
    this.#items = 0;
    this.#bytes = 0;
    this.#visible = undefined;
  }

  dispose(): void { this.#disposed = true; this.reset(); }
}
