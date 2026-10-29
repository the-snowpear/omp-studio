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
}
const PENDING_MAX_CHARS = 64 * 1024;

/**
 * UTF-8 byte length without allocating for ASCII (terminal output is almost
 * entirely ASCII). Flow control counts the same unit Main counts, so a
 * graphics-stripped payload is still credited for exactly what was sent.
 */
export function utf8Length(text: string): number {
  if (/^[\u0000-\u007f]*$/u.test(text)) return text.length;
  return new TextEncoder().encode(text).length;
}


export class TerminalSessions {
  readonly hosts = new Map<string, TerminalScreenHost>();
  readonly pending = new Map<string, string>();
  readonly activeIds = new Map<string | null, string>();
  readonly #decoders = new Map<string, TerminalGraphicsDecoder>();
  readonly #listeners = new Set<() => void>();
  readonly #earlyExits = new Set<string>();
  readonly #acked = new Map<string, number>();
  #ackScheduled = false;
  #state: TerminalState = { sessions: [], graphics: {}, graphicsErrors: {} };
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
    await this.api?.dispose(id);
    this.#releaseScreen(id);
    const { [id]: _graphic, ...graphics } = this.#state.graphics;
    const { [id]: _error, ...graphicsErrors } = this.#state.graphicsErrors;
    this.#publish({ sessions: this.#state.sessions.filter(session => session.id !== id), graphics, graphicsErrors });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#off?.();
    for (const session of this.#state.sessions) void this.api?.dispose(session.id).catch(() => {});
    for (const id of this.hosts.keys()) this.#releaseScreen(id);
    this.pending.clear();
    this.#acked.clear();
    this.#decoders.clear();
    this.#listeners.clear();
  }

  #listen(): void {
    if (!this.api || this.#off) return;
    const offData = this.api.onData(event => {
      if (!this.#creating && !this.#state.sessions.some(session => session.id === event.id)) return;
      let decoder = this.#decoders.get(event.id);
      if (!decoder) { decoder = new TerminalGraphicsDecoder(); this.#decoders.set(event.id, decoder); }
      const decoded = decoder.push(event.data);
      if (decoded.images.length || decoded.errors.length) this.#publish({
        ...this.#state,
        graphics: decoded.images.length ? { ...this.#state.graphics, [event.id]: [...(this.#state.graphics[event.id] ?? []), ...decoded.images].slice(-4) } : this.#state.graphics,
        graphicsErrors: decoded.errors.length ? { ...this.#state.graphicsErrors, [event.id]: decoded.errors.join("; ") } : this.#state.graphicsErrors,
      });
      // ACK accounting uses what Main sent (`event.data`), not the graphics-
      // stripped text: Main counts bytes on the wire, and crediting less would
      // eventually stall a graphics-heavy session.
      const bytes = typeof event.bytes === "number" ? event.bytes : utf8Length(event.data);
      const host = this.hosts.get(event.id);
      if (host) host.term.write(decoded.text, () => this.#ack(event.id, bytes));
      else {
        // No xterm attached (target view unmounted): the text is held here, so
        // credit it now instead of letting Main pause forever.
        this.pending.set(event.id, ((this.pending.get(event.id) ?? "") + decoded.text).slice(-PENDING_MAX_CHARS));
        this.#ack(event.id, bytes);
      }
    });
    const offExit = this.api.onExit(event => {
      if (this.#creating && !this.#state.sessions.some(session => session.id === event.id)) this.#earlyExits.add(event.id);
      this.#publish({ ...this.#state, sessions: this.#state.sessions.map(session => session.id === event.id ? { ...session, status: "ended" } : session) });
    });
    this.#off = () => { offData(); offExit(); };
  }

  /**
   * Credit `bytes` back to Main. Writes that complete in the same tick are
   * coalesced into one ACK, so a burst costs one small message per tick rather
   * than one per xterm write callback.
   */
  #ack(id: string, bytes: number): void {
    const api = this.api;
    if (api?.ack === undefined || this.#closed) return;
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
      // The terminal may have been closed while the microtask was queued.
      if (this.#closed || bytes <= 0) continue;
      try {
        api.ack(id, bytes);
      } catch {
        // A window mid-teardown can reject the IPC; the session is gone anyway.
      }
    }
  }

  #releaseScreen(id: string): void {
    this.hosts.get(id)?.term.dispose();
    this.hosts.delete(id);
    this.pending.delete(id);
    this.#decoders.delete(id);
    this.#acked.delete(id);
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
