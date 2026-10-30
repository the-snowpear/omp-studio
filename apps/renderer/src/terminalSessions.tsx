import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TerminalGraphicsDecoder, type TerminalGraphic } from "./terminalGraphics";

type Api = NonNullable<typeof globalThis.ompStudioTerminal>;
export interface TerminalSession {
  readonly targetId: string | null;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly status: "running" | "ended";
}
export interface TerminalScreenHost { readonly term: Terminal; readonly fit: FitAddon; }
interface TerminalState {
  sessions: readonly TerminalSession[];
  graphics: Readonly<Record<string, TerminalGraphic[]>>;
  graphicsErrors: Readonly<Record<string, string>>;
  /** Explicit, user-visible loss notices per terminal — never a silent drop. */
  notices: Readonly<Record<string, string>>;
}

/**
 * Backlog cap per terminal while no xterm host is attached, in wire bytes.
 *
 * Main pauses the PTY at 500 KiB unacknowledged, but its own buffer can still
 * hand over up to its 2 MiB hard cap before the source actually stops, so this
 * side must be able to hold ~2.5 MiB without losing anything. 3 MiB leaves
 * headroom; exceeding it means the source could not be paused (abnormal), and
 * the overflow is reported instead of disappearing.
 */
export const PENDING_MAX_BYTES = 3 * 1024 * 1024;

/**
 * UTF-8 byte length without allocating for ASCII (terminal output is almost
 * entirely ASCII). Flow control counts the same unit Main counts, so a
 * graphics-stripped payload is still credited for exactly what was sent.
 */
export function utf8Length(text: string): number {
  if (/^[\u0000-\u007f]*$/u.test(text)) return text.length;
  return new TextEncoder().encode(text).length;
}

interface PendingBatch {
  readonly text: string;
  /** Wire bytes of this batch (`event.bytes`), the unit flow control counts. */
  readonly bytes: number;
}

/**
 * Ordered backlog of terminal output that arrived before its xterm host was
 * attached.
 *
 * Accounting is in the wire bytes Main counts, not characters: a queued byte is
 * a byte Main has not been credited for, which is what makes its flow control
 * pause the PTY instead of pretending the output was consumed. Nothing here is
 * acknowledged until it is actually written to xterm.
 */
export class TerminalPendingOutput {
  readonly batches: PendingBatch[] = [];
  /** Queued wire bytes not yet written to xterm (never credited while queued). */
  bytes = 0;
  /** Wire bytes dropped at the cap; surfaced as a notice, never silently. */
  droppedBytes = 0;

  get empty(): boolean {
    return this.batches.length === 0;
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  /** Concatenated text in arrival order (diagnostics and tests). */
  get text(): string {
    return this.batches.map((batch) => batch.text).join("");
  }

  /**
   * Append one batch, dropping the *oldest* output when the cap would be
   * exceeded (the newest output is what a returning user needs). Returns the
   * number of bytes this call dropped.
   */
  append(text: string, bytes: number, limit: number): number {
    if (text.length === 0) return 0;
    let dropped = 0;
    while (this.batches.length > 0 && this.bytes + bytes > limit) {
      const oldest = this.batches.shift();
      if (oldest === undefined) break;
      this.bytes -= oldest.bytes;
      dropped += oldest.bytes;
    }
    if (bytes > limit) {
      // A single batch larger than the whole backlog: keep nothing rather than
      // half a payload, but record it.
      this.droppedBytes += dropped + bytes;
      return dropped + bytes;
    }
    this.batches.push({ text, bytes });
    this.bytes += bytes;
    this.droppedBytes += dropped;
    return dropped;
  }

  /** Take every queued batch, leaving the backlog empty. */
  take(): PendingBatch[] {
    const batches = this.batches.splice(0, this.batches.length);
    this.bytes = 0;
    return batches;
  }

  clear(): void {
    this.batches.length = 0;
    this.bytes = 0;
    this.droppedBytes = 0;
  }
}

export class TerminalSessions {
  readonly hosts = new Map<string, TerminalScreenHost>();
  /** Ordered backlog per terminal that has no xterm host yet. */
  readonly pending = new Map<string, TerminalPendingOutput>();
  readonly activeIds = new Map<string | null, string>();
  readonly #decoders = new Map<string, TerminalGraphicsDecoder>();
  readonly #listeners = new Set<() => void>();
  readonly #earlyExits = new Set<string>();
  readonly #acked = new Map<string, number>();
  /**
   * Terminals whose flow-control session is over: Main has closed the batcher,
   * so nothing here may ACK any more (on exit or disposal). This says nothing
   * about whether output may still be *displayed*.
   */
  readonly #creditsClosed = new Set<string>();
  /**
   * Terminals whose removal is in flight (`remove()` awaits `dispose`, and Main
   * can still deliver a last batch while it does). Output for these is ignored
   * instead of being queued for a screen that is about to be destroyed.
   *
   * The set is bounded by construction: an id is added before the dispose call
   * and dropped when the screen is released, so it only holds terminals that are
   * mid-close right now - not every terminal ever closed.
   */
  readonly #removing = new Set<string>();
  #ackScheduled = false;
  #state: TerminalState = { sessions: [], graphics: {}, graphicsErrors: {}, notices: {} };
  #off: (() => void) | undefined;
  #creating = 0;
  #closed = false;

  constructor(readonly api: Api | undefined) {}
  snapshot = (): TerminalState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };

  async create(targetId: string | null, workspaceId?: string, sessionId?: string): Promise<string> {
    if (!this.api || this.#closed) throw new Error("Terminal is unavailable");
    this.#listen();
    this.#creating++;
    try {
      // `flowControl: true` is the opt-in handshake: Main then pauses the PTY
      // when this store falls behind, and resumes on our ACKs below.
      const info = await this.api.create({ cols: 80, rows: 24, flowControl: true, ...(targetId ? { targetId, ...(workspaceId ? { workspaceId } : {}) } : {}) });
      if (this.#closed) { await this.api.dispose(info.id); throw new Error("Terminal window has closed"); }
      const session: TerminalSession = { ...info, targetId, status: this.#earlyExits.delete(info.id) ? "ended" : "running", ...(workspaceId ? { workspaceId } : {}), ...(sessionId ? { sessionId } : {}) };
      this.#publish({ ...this.#state, sessions: [...this.#state.sessions, session] });
      this.activeIds.set(targetId, info.id);
      return info.id;
    } finally {
      this.#creating--;
      if (!this.#creating) {
        for (const id of this.pending.keys()) if (!this.#state.sessions.some(session => session.id === id)) this.pending.delete(id);
        this.#earlyExits.clear();
      }
    }
  }

  async remove(id: string): Promise<void> {
    if (!this.#state.sessions.some(session => session.id === id)) return;
    this.#removing.add(id);
    await this.api?.dispose(id);
    this.#releaseScreen(id);
    const { [id]: _graphic, ...graphics } = this.#state.graphics;
    const { [id]: _error, ...graphicsErrors } = this.#state.graphicsErrors;
    const { [id]: _notice, ...notices } = this.#state.notices;
    this.#publish({ ...this.#state, sessions: this.#state.sessions.filter(session => session.id !== id), graphics, graphicsErrors, notices });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#off?.();
    for (const session of this.#state.sessions) void this.api?.dispose(session.id).catch(() => {});
    for (const id of this.hosts.keys()) this.#releaseScreen(id);
    this.pending.clear();
    this.#acked.clear();
    this.#creditsClosed.clear();
    this.#decoders.clear();
    this.#listeners.clear();
  }

  /**
   * Register (or re-register) a terminal's xterm host and deliver the backlog
   * that accumulated while it was missing. `TerminalPane` calls this on mount.
   */
  attachHost(id: string, host: TerminalScreenHost): void {
    if (this.#removing.has(id)) return;
    this.hosts.set(id, host);
    // An ended terminal still owes the user everything it printed: replay the
    // backlog without crediting it, because the flow-control session is gone.
    if (this.#creditsClosed.has(id)) this.#deliverEnded(id);
    else this.#drain(id);
  }

  #listen(): void {
    if (!this.api || this.#off) return;
    const offData = this.api.onData(event => {
      if (this.#removing.has(event.id)) return;
      if (!this.#creating && !this.#state.sessions.some(session => session.id === event.id)) return;
      // An ended terminal still accepts output: Main keeps the batcher open for
      // one window after the exit notification because ConPTY can hand over the
      // shell's last line afterwards. Those bytes are shown (or queued, still
      // bounded) but never credited again - the flow-control session is over.
      let decoder = this.#decoders.get(event.id);
      if (!decoder) { decoder = new TerminalGraphicsDecoder(); this.#decoders.set(event.id, decoder); }
      const decoded = decoder.push(event.data);
      if (decoded.images.length || decoded.errors.length) this.#publish({
        ...this.#state,
        graphics: decoded.images.length ? { ...this.#state.graphics, [event.id]: [...(this.#state.graphics[event.id] ?? []), ...decoded.images].slice(-4) } : this.#state.graphics,
        graphicsErrors: decoded.errors.length ? { ...this.#state.graphicsErrors, [event.id]: decoded.errors.join("; ") } : this.#state.graphicsErrors,
      });
      // Wire bytes: what Main must be credited for. Graphics escapes are
      // stripped from `decoded.text`, so measuring the text would under-credit
      // a terminal that draws images.
      const bytes = typeof event.bytes === "number" ? event.bytes : utf8Length(event.data);
      const text = decoded.text;
      if (text.length === 0) {
        // Graphics-only / escape-only batch: nothing to display, so it occupies
        // no backlog and is consumed immediately. Leaving it unacknowledged
        // would park Main at its high watermark for ever.
        this.#ack(event.id, bytes);
        return;
      }
      const host = this.hosts.get(event.id);
      if (host !== undefined) {
        // Credited once xterm has written it, not when it was received - and
        // never after the process is gone (there is nothing left to credit).
        if (this.#creditsClosed.has(event.id)) host.term.write(text);
        else host.term.write(text, () => this.#ack(event.id, bytes));
        return;
      }
      // No xterm yet: keep it, in order, and do NOT acknowledge. The missing
      // credit is exactly what pauses the PTY at Main's high watermark; the
      // backlog is bounded, and overflow is reported (see `#notifyTruncation`).
      const queue = this.#queue(event.id);
      queue.append(text, bytes, PENDING_MAX_BYTES);
      if (queue.truncated) this.#notifyTruncation(event.id);
    });
    const offExit = this.api.onExit(event => {
      if (this.#creating && !this.#state.sessions.some(session => session.id === event.id)) this.#earlyExits.add(event.id);
      // The process ended; the tab did not. Stop crediting (Main closed the
      // batcher, and a late xterm callback must not ACK a dead session) but keep
      // the backlog until a screen exists: an unmounted terminal that printed
      // its error message and exited must still show it when the user opens it.
      this.#creditsClosed.add(event.id);
      this.#acked.delete(event.id);
      this.#deliverEnded(event.id);
      this.#publish({ ...this.#state, sessions: this.#state.sessions.map(session => session.id === event.id ? { ...session, status: "ended" } : session) });
    });
    this.#off = () => { offData(); offExit(); };
  }

  #queue(id: string): TerminalPendingOutput {
    let queue = this.pending.get(id);
    if (queue === undefined) { queue = new TerminalPendingOutput(); this.pending.set(id, queue); }
    return queue;
  }

  /** Deliver the backlog in arrival order, crediting each batch as it is written. */
  #drain(id: string): void {
    const host = this.hosts.get(id);
    const queue = this.pending.get(id);
    if (host === undefined || queue === undefined) return;
    for (const batch of queue.take()) {
      // xterm keeps its own ordered write queue, so issuing every batch here
      // preserves order; each callback credits exactly one batch.
      host.term.write(batch.text, () => this.#ack(id, batch.bytes));
    }
    this.#creditDropped(id, queue);
  }

  /**
   * Credit output that was dropped at the cap, after the retained tail is on its
   * way to xterm. Without this the PTY would stay paused for ever: Main can only
   * resume below its low watermark and the dropped bytes are never written. The
   * loss itself is already visible through `notices`, so this is explicit
   * recovery of a known-bad backlog, not a silent acknowledgement.
   */
  #creditDropped(id: string, queue: TerminalPendingOutput): void {
    if (queue.droppedBytes <= 0) return;
    const dropped = queue.droppedBytes;
    queue.droppedBytes = 0;
    this.#ack(id, dropped);
  }

  /**
   * Display an ended terminal's backlog, in arrival order, without crediting it
   * (the flow-control session is over) and without touching its account.
   *
   * With no screen attached the backlog stays queued - still bounded by
   * `PENDING_MAX_BYTES` - for the first attach; releasing it here is exactly the
   * bug this method replaced. The truncation notice, if any, stays in state
   * until the user closes the terminal, so a loss that happened before the exit
   * stays visible.
   */
  #deliverEnded(id: string): void {
    const queue = this.pending.get(id);
    if (queue === undefined) return;
    const host = this.hosts.get(id);
    if (host === undefined) return;
    this.pending.delete(id);
    const text = queue.text;
    queue.clear();
    if (text.length > 0) host.term.write(text);
  }

  #notifyTruncation(id: string): void {
    if (this.#state.notices[id] !== undefined) return;
    const limit = Math.round(PENDING_MAX_BYTES / (1024 * 1024));
    this.#publish({
      ...this.#state,
      notices: { ...this.#state.notices, [id]: `后台输出超过 ${limit} MiB 上限，较早的输出已被丢弃。` },
    });
  }

  /**
   * Credit `bytes` back to Main. Writes that complete inside one tick are
   * coalesced into a single ACK, so a burst costs one small message per tick
   * rather than one per xterm write callback.
   */
  #ack(id: string, bytes: number): void {
    const api = this.api;
    if (api?.ack === undefined || this.#closed || bytes <= 0) return;
    // Only a live terminal may credit. A disposed/ended session must not ACK,
    // and xterm callbacks queued before teardown can still fire afterwards.
    if (this.#creditsClosed.has(id) || this.#removing.has(id)) return;
    if (this.#creating === 0 && !this.#state.sessions.some(session => session.id === id)) return;
    this.#acked.set(id, (this.#acked.get(id) ?? 0) + bytes);
    if (this.#ackScheduled) return;
    this.#ackScheduled = true;
    queueMicrotask(() => {
      this.#ackScheduled = false;
      this.#flushAcks();
    });
  }

  #flushAcks(): void {
    const api = this.api;
    if (api?.ack === undefined) return;
    const pending = [...this.#acked];
    this.#acked.clear();
    for (const [id, bytes] of pending) {
      // The terminal may have ended or been closed while the microtask queued.
      if (this.#closed || this.#creditsClosed.has(id) || this.#removing.has(id) || bytes <= 0) continue;
      try {
        api.ack(id, bytes);
      } catch {
        // A window mid-teardown can reject the IPC; the session is gone anyway.
      }
    }
  }

  #releaseScreen(id: string): void {
    this.#removing.add(id);
    this.hosts.get(id)?.term.dispose();
    this.hosts.delete(id);
    this.pending.delete(id);
    this.#decoders.delete(id);
    this.#acked.delete(id);
    this.#creditsClosed.delete(id);
    // The session is gone from `#state` by the time this returns, so the
    // unknown-session guard blocks later output on its own.
    this.#removing.delete(id);
  }
  #publish(state: TerminalState): void { this.#state = state; for (const listener of this.#listeners) listener(); }
}

const Context = createContext<TerminalSessions | undefined>(undefined);
export function TerminalSessionsProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new TerminalSessions(globalThis.ompStudioTerminal), []);
  useEffect(() => () => store.close(), [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTerminalSessions() {
  const store = useContext(Context);
  if (!store) throw new Error("Terminal sessions need their window provider");
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return { store, ...state };
}
