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

export class TerminalSessions {
  readonly hosts = new Map<string, TerminalScreenHost>();
  readonly pending = new Map<string, string>();
  readonly activeIds = new Map<string | null, string>();
  readonly #decoders = new Map<string, TerminalGraphicsDecoder>();
  readonly #listeners = new Set<() => void>();
  readonly #earlyExits = new Set<string>();
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
      const info = await this.api.create({ cols: 80, rows: 24, ...(targetId ? { targetId, ...(workspaceId ? { workspaceId } : {}) } : {}) });
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
      const host = this.hosts.get(event.id);
      if (host) host.term.write(decoded.text);
      else this.pending.set(event.id, ((this.pending.get(event.id) ?? "") + decoded.text).slice(-PENDING_MAX_CHARS));
    });
    const offExit = this.api.onExit(event => {
      if (this.#creating && !this.#state.sessions.some(session => session.id === event.id)) this.#earlyExits.add(event.id);
      this.#publish({ ...this.#state, sessions: this.#state.sessions.map(session => session.id === event.id ? { ...session, status: "ended" } : session) });
    });
    this.#off = () => { offData(); offExit(); };
  }

  #releaseScreen(id: string): void {
    this.hosts.get(id)?.term.dispose();
    this.hosts.delete(id);
    this.pending.delete(id);
    this.#decoders.delete(id);
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
