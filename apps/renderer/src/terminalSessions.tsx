import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { utf8ByteLength } from "@omp-studio/client-contract";
import { TerminalGraphicsDecoder, type TerminalGraphic } from "./terminalGraphics";
import { isZh } from "./i18n";
import type { TerminalCommand } from "../../desktop/src/terminal-shared";
import type { TmuxAction, TmuxTopology } from "../../desktop/src/tmux/tmux-shared";

type Api = NonNullable<typeof globalThis.ompStudioTerminal>;
export interface TerminalSession {
  readonly kind?: "shell" | "tmux-pane";
  readonly tmux?: { connectionId: string; paneId: string; windowId: string };
  readonly conversationId?: string;
  readonly targetId: string | null;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly status: "running" | "ended";
}
export interface TerminalScreenHost { readonly term: Terminal; readonly fit?: FitAddon; }
interface TerminalState {
  restoring: boolean;
  sessions: readonly TerminalSession[];
  graphics: Readonly<Record<string, TerminalGraphic[]>>;
  graphicsErrors: Readonly<Record<string, string>>;
  /** Explicit, user-visible loss notices per terminal — never a silent drop. */
  notices: Readonly<Record<string, string>>;
  controlMode: Readonly<Record<string, boolean>>;
  tmux: Readonly<Record<string, TmuxTopology>>;
  tmuxOwners: Readonly<Record<string, string>>;
  hiddenWindows: Readonly<Record<string, readonly string[]>>;
}
type TerminalOwner = { targetId: string | null; workspaceId: string | undefined; sessionId: string | undefined; conversationId: string | undefined };

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
  return utf8ByteLength(text);
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
  readonly #sessionIds = new Set<string>();
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
  readonly #forgettingTmux = new Set<string>();
  #ackScheduled = false;
  #state: TerminalState = { restoring: false, sessions: [], graphics: {}, graphicsErrors: {}, notices: {}, controlMode: {}, tmux: {}, tmuxOwners: {}, hiddenWindows: {} };
  #off: (() => void) | undefined;
  #creating = 0;
  #closed = false;
  readonly #sharedSequences = new Map<string, number>();
  readonly #pendingOwners = new Set<TerminalOwner>();
  readonly #sharedBindings = new Map<string, string>();

  constructor(readonly api: Api | undefined) { this.#state.restoring = Boolean(api?.list); }
  restore(): () => void {
    if (!this.api?.list) return () => {};
    this.#listen();
    const apply = (rows: import("../../desktop/src/web/terminals").SharedTerminal[]) => {
      if (this.#closed) return;
      for (const row of rows) {
        const previous = this.#sharedSequences.get(row.id);
        if (previous !== undefined && previous >= row.sequence) continue;
        this.#sessionIds.add(row.id);
        this.#sharedSequences.set(row.id, row.sequence);
        this.#queue(row.id).clear();
        this.hosts.get(row.id)?.term.reset();
        this.#queue(row.id).append(row.output, 0, PENDING_MAX_BYTES);
        if (row.truncated) this.#state = { ...this.#state, notices: { ...this.#state.notices, [row.id]: "host-replay-truncated" } };
      }
      const known = new Set(rows.map(row => row.id));
      const remote = this.#state.sessions.filter(row => row.targetId !== null);
      const local = rows.map(row => {
        const existing = this.#state.sessions.find(item => item.id === row.id);
        const binding = this.#sharedBindings.get(row.id);
        const sessionId = binding ?? row.sessionId;
        if (binding === row.sessionId) this.#sharedBindings.delete(row.id);
        const { sessionId: _previousSession, conversationId, ...previous } = existing ?? {};
        const owner = binding !== undefined || existing?.sessionId === sessionId ? conversationId : undefined;
        return { ...previous, id: row.id, name: row.name, cwd: row.cwd, status: row.status, targetId: null,
          ...(owner ? { conversationId: owner } : {}), ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}), ...(sessionId ? { sessionId } : {}) };
      });
      for (const previous of this.#state.sessions) if (previous.targetId === null && !known.has(previous.id)) this.#releaseScreen(previous.id);
      this.#publish({ ...this.#state, restoring: false, sessions: [...remote, ...local] });
      for (const row of rows) this.#drain(row.id);
    };
    const off = this.api.onSessions?.(apply);
    void this.api.list().then(apply).catch(() => { if (!this.#closed) this.#publish({ ...this.#state, restoring: false }); });
    return () => off?.();
  }
  snapshot = (): TerminalState => this.#state;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };

  async create(targetId: string | null, workspaceId?: string, sessionId?: string, conversationId?: string, command?: TerminalCommand): Promise<string> {
    if (!this.api || this.#closed) throw new Error("Terminal is unavailable");
    this.#listen();
    this.#creating++;
    const owner: TerminalOwner = { targetId, workspaceId, sessionId, conversationId };
    this.#pendingOwners.add(owner);
    try {
      // `flowControl: true` is the opt-in handshake: Main then pauses the PTY
      // when this store falls behind, and resumes on our ACKs below.
      const info = await this.api.create({ cols: 80, rows: 24, ...(this.api.ack ? { flowControl: true } : {}), ...(workspaceId ? { workspaceId } : {}), ...(this.api.persistent && !targetId && sessionId ? { sessionId } : {}), ...(targetId ? { targetId } : {}), ...(command ? { command } : {}) });
      if (this.#closed) { await this.api.dispose(info.id); throw new Error("Terminal window has closed"); }
      const scope = this.api.persistent && !targetId && !this.api.rebind ? sessionId : owner.sessionId;
      const session: TerminalSession = { ...info, targetId, ...(owner.conversationId ? { conversationId: owner.conversationId } : {}), status: this.#earlyExits.delete(info.id) ? "ended" : "running", ...(workspaceId ? { workspaceId } : {}), ...(scope ? { sessionId: scope } : {}) };
      this.activeIds.set(terminalOwnerKey(targetId, workspaceId, owner.conversationId ?? scope), info.id);
      if (this.api.persistent && !targetId && owner.sessionId && owner.sessionId !== sessionId && this.api.rebind) this.#sharedBindings.set(info.id, owner.sessionId);
      this.#publish({ ...this.#state, sessions: [...this.#state.sessions.filter(row => row.id !== session.id), session] });
      if (this.#sharedBindings.has(info.id)) await this.#rebindShared([info.id], owner.sessionId!, new Map([[info.id, sessionId]]));
      return info.id;
    } finally {
      this.#pendingOwners.delete(owner);
      this.#creating--;
      if (!this.#creating) {
        for (const id of this.pending.keys()) if (!this.#sessionIds.has(id)) this.pending.delete(id);
        this.#earlyExits.clear();
      }
    }
  }

  /** Move the existing screens and PTYs before the old conversation unmounts. */
  transferConversation(from: string, to: string): void {
    for (const owner of this.#pendingOwners) if (owner.conversationId === from) owner.conversationId = to;
    const suffix = `,${JSON.stringify(from)}]`;
    const keyFor = (key: string) => key.endsWith(suffix) ? `${key.slice(0, -suffix.length)},${JSON.stringify(to)}]` : key;
    for (const [key, id] of [...this.activeIds]) if (key) {
      const next = keyFor(key);
      if (next !== key) { this.activeIds.delete(key); this.activeIds.set(next, id); }
    }
    this.#publish({ ...this.#state,
      sessions: this.#state.sessions.map(session => session.conversationId === from ? { ...session, conversationId: to } : session),
      tmuxOwners: Object.fromEntries(Object.entries(this.#state.tmuxOwners).map(([id, key]) => [id, keyFor(key)])),
    });
  }

  /** A ready context gives transferred and restored terminals their actual session. */
  async rebindConversation(conversationId: string, sessionId: string, targetId: string | null, workspaceId?: string): Promise<void> {
    for (const owner of this.#pendingOwners) if (owner.conversationId === conversationId) owner.sessionId = sessionId;
    const ids: string[] = [], previous = new Map<string, string | undefined>();
    let changed = false;
    const sessions = this.#state.sessions.map(session => {
      if (session.kind === "tmux-pane" || session.targetId !== targetId || session.workspaceId !== workspaceId
        || !(session.conversationId === conversationId || !session.conversationId && session.sessionId === sessionId)) return session;
      const scope = this.api?.persistent && !targetId && !this.api.rebind ? session.sessionId : sessionId;
      if (session.conversationId === conversationId && session.sessionId === scope) return session;
      changed = true;
      if (this.api?.persistent && !targetId && this.api.rebind && session.sessionId !== sessionId) {
        ids.push(session.id); previous.set(session.id, session.sessionId); this.#sharedBindings.set(session.id, sessionId);
      }
      return { ...session, conversationId, ...(scope ? { sessionId: scope } : {}) };
    });
    if (changed) this.#publish({ ...this.#state, sessions });
    if (ids.length) await this.#rebindShared(ids, sessionId, previous);
  }

  async #rebindShared(ids: string[], sessionId: string, previous: Map<string, string | undefined>): Promise<void> {
    try { await this.api!.rebind!({ ids, sessionId }); }
    catch (error) {
      const restore = new Set(ids.filter(id => this.#sharedBindings.get(id) === sessionId));
      for (const id of restore) this.#sharedBindings.delete(id);
      this.#publish({ ...this.#state, sessions: this.#state.sessions.map(session => {
        if (!restore.has(session.id)) return session;
        const { sessionId: _scope, ...rest } = session;
        const scope = previous.get(session.id);
        return { ...rest, ...(scope ? { sessionId: scope } : {}) };
      }) });
      throw error;
    }
  }

  async remove(id: string): Promise<void> {
    if (!this.#sessionIds.has(id)) return;
    this.#removing.add(id);
    try {
      await this.api?.dispose(id);
    } catch (error) {
      this.#removing.delete(id);
      throw error;
    }
    this.#releaseScreen(id);
    for (const [ownerKey, activeId] of this.activeIds) {
      if (activeId === id) this.activeIds.delete(ownerKey);
    }
    const { [id]: _graphic, ...graphics } = this.#state.graphics;
    const { [id]: _error, ...graphicsErrors } = this.#state.graphicsErrors;
    const { [id]: _notice, ...notices } = this.#state.notices;
    const { [id]: _control, ...controlMode } = this.#state.controlMode;
    this.#publish({ ...this.#state, sessions: this.#state.sessions.filter(session => session.id !== id), graphics, graphicsErrors, notices, controlMode });
  }

  async disposeConversation(conversationId: string): Promise<void> {
    if (!conversationId) return;
    const matching = this.#state.sessions.filter(
      session => session.kind !== "tmux-pane" && session.conversationId === conversationId,
    );
    const ownerSuffix = `,${JSON.stringify(conversationId)}]`;
    for (const [connectionId, ownerKey] of Object.entries(this.#state.tmuxOwners)) {
      if (ownerKey.endsWith(ownerSuffix)) this.forgetTmux(connectionId);
    }
    for (const key of [...this.activeIds.keys()]) {
      if (key?.endsWith(ownerSuffix)) this.activeIds.delete(key);
    }
    await Promise.allSettled(matching.map(session => this.remove(session.id)));
  }

  listTmuxSessions(targetId: string, workspaceId: string) {
    if (!this.api?.tmuxSessions) throw new Error("tmux is unavailable");
    return this.api.tmuxSessions({ targetId, workspaceId });
  }
  async attachTmux(targetId: string, workspaceId: string, session?: string, options: { size?: { cols: number; rows: number }; replaceId?: string; ownerKey?: string } = {}): Promise<string> {
    if (!this.api?.tmuxAttach || this.#closed) throw new Error("tmux is unavailable");
    this.#listen(); this.#creating++;
    try {
      const { size = { cols: 120, rows: 32 }, replaceId, ownerKey = terminalOwnerKey(targetId, workspaceId) } = options;
      const result = await this.api.tmuxAttach({ targetId, workspaceId, ...size, ...(session ? { session } : {}), flowControl: !!this.api.ack });
      if (this.#closed) { await this.api.tmuxDetach?.(result.connectionId); throw new Error("Terminal window has closed"); }
      this.#publish({ ...this.#state, tmuxOwners: { ...this.#state.tmuxOwners, [result.connectionId]: ownerKey } });
      if (replaceId && replaceId !== result.connectionId) {
        const replacement = this.#state.tmux[result.connectionId];
        if (replacement) {
          const tmux = Object.fromEntries(Object.entries(this.#state.tmux).flatMap(([id, value]) => id === replaceId ? [[result.connectionId, replacement]] : id === result.connectionId ? [] : [[id, value]]));
          this.#publish({ ...this.#state, tmux });
        }
        this.forgetTmux(replaceId);
      }
      return result.connectionId;
    } finally {
      this.#creating--;
      if (!this.#creating) for (const id of this.pending.keys()) if (!this.#sessionIds.has(id)) this.pending.delete(id);
    }
  }
  async tmuxCommand(connectionId: string, action: TmuxAction): Promise<void> {
    if (!this.api?.tmuxCommand) throw new Error("tmux is unavailable");
    await this.api.tmuxCommand({ connectionId, action });
  }
  async detachTmux(connectionId: string): Promise<void> { await this.api?.tmuxDetach?.(connectionId); }
  async hideTmuxWindow(connectionId: string, windowId: string, hidden: boolean): Promise<void> {
    await this.tmuxCommand(connectionId, { kind: "setWindowVisible", windowId, visible: !hidden });
    const current = this.#state.hiddenWindows[connectionId] ?? [];
    this.#publish({ ...this.#state, hiddenWindows: { ...this.#state.hiddenWindows, [connectionId]: hidden ? [...new Set([...current, windowId])] : current.filter(id => id !== windowId) } });
  }
  forgetTmux(connectionId: string): void {
    this.#forgettingTmux.add(connectionId);
    void this.api?.tmuxDetach?.(connectionId).catch(() => {}).finally(() => this.#forgettingTmux.delete(connectionId));
    const panes = this.#state.sessions.filter(session => session.tmux?.connectionId === connectionId);
    for (const pane of panes) this.#releaseScreen(pane.id);
    const { [connectionId]: _topology, ...tmux } = this.#state.tmux;
    const { [connectionId]: _owner, ...tmuxOwners } = this.#state.tmuxOwners;
    const { [connectionId]: _hidden, ...hiddenWindows } = this.#state.hiddenWindows;
    const ids = new Set(panes.map(pane => pane.id));
    const prefix = `tmux:${connectionId}:`;
    for (const [ownerKey, activeId] of this.activeIds) {
      if (ids.has(activeId) || activeId.startsWith(prefix)) this.activeIds.delete(ownerKey);
    }
    const keep = <T,>(record: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(record).filter(([id]) => !ids.has(id)));
    this.#publish({ ...this.#state, tmux, tmuxOwners, hiddenWindows, sessions: this.#state.sessions.filter(session => !ids.has(session.id)), graphics: keep(this.#state.graphics), graphicsErrors: keep(this.#state.graphicsErrors), notices: keep(this.#state.notices), controlMode: keep(this.#state.controlMode) });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#off?.();
    for (const session of this.#state.sessions) if (session.kind !== "tmux-pane" && (!this.api?.persistent || session.targetId !== null)) void this.api?.dispose(session.id).catch(() => {});
    for (const id of Object.keys(this.#state.tmux)) void this.api?.tmuxDetach?.(id).catch(() => {});
    for (const id of this.hosts.keys()) this.#releaseScreen(id);
    this.activeIds.clear();
    this.pending.clear();
    this.#acked.clear();
    this.#creditsClosed.clear();
    this.#sessionIds.clear();
    this.#sharedSequences.clear();
    this.#sharedBindings.clear();
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
    this.#drain(id);
  }

  #listen(): void {
    if (!this.api || this.#off) return;
    const offTmux = this.api.onTmux?.(topology => {
      if (this.#forgettingTmux.has(topology.connectionId)) return;
      const previous = this.#state.sessions.filter(session => session.tmux?.connectionId === topology.connectionId);
      const liveIds = new Set(Object.values(topology.panes).map(pane => pane.terminalId));
      const removed = new Set(previous.filter(pane => !liveIds.has(pane.id)).map(pane => pane.id));
      for (const id of removed) this.#releaseScreen(id);
      const panes: TerminalSession[] = Object.entries(topology.panes).map(([paneId, pane]) => ({
        id: pane.terminalId, kind: "tmux-pane", tmux: { connectionId: topology.connectionId, paneId, windowId: pane.windowId },
        targetId: topology.targetId, workspaceId: topology.workspaceId, name: pane.title, cwd: pane.cwd ?? "",
        status: topology.state === "lost" || topology.state === "exited" ? "ended" : "running",
      }));
      const keep = <T,>(record: Readonly<Record<string, T>>) => Object.fromEntries(Object.entries(record).filter(([id]) => !removed.has(id)));
      this.#publish({ ...this.#state, tmux: { ...this.#state.tmux, [topology.connectionId]: topology }, sessions: [...this.#state.sessions.filter(session => session.tmux?.connectionId !== topology.connectionId), ...panes], ...(removed.size ? { graphics: keep(this.#state.graphics), graphicsErrors: keep(this.#state.graphicsErrors), notices: keep(this.#state.notices), controlMode: keep(this.#state.controlMode) } : {}) });
      for (const pane of panes) this.#drain(pane.id);
    });
    const offData = this.api.onData(event => {
      if (this.#removing.has(event.id)) return;
      if (!this.#creating && !this.#sessionIds.has(event.id)) return;
      if (event.sequence !== undefined) {
        if ((this.#sharedSequences.get(event.id) ?? -1) >= event.sequence) return;
        this.#sharedSequences.set(event.id, event.sequence);
      }
      // An ended terminal still accepts output: Main keeps the batcher open for
      // one window after the exit notification because ConPTY can hand over the
      // shell's last line afterwards. Those bytes are shown (or queued, still
      // bounded) but never credited again - the flow-control session is over.
      let decoder = this.#decoders.get(event.id);
      if (!decoder) { decoder = new TerminalGraphicsDecoder(); this.#decoders.set(event.id, decoder); }
      const decoded = decoder.push(event.data);
      if (decoded.controlMode) {
        const { [event.id]: _previous, ...controlMode } = this.#state.controlMode;
        this.#publish({ ...this.#state, controlMode: decoded.controlMode === "enter" ? { ...controlMode, [event.id]: true } : controlMode });
      }
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
        else host.term.write(text, this.#consumed(event.id, bytes));
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
      if (this.#creating && !this.#sessionIds.has(event.id)) this.#earlyExits.add(event.id);
      // The process ended; the tab did not. Stop crediting even while Main's
      // tail window is draining; a late xterm callback must not ACK it. Keep
      // the backlog until a screen exists: an unmounted terminal that printed
      // its error message and exited must still show it when the user opens it.
      this.#creditsClosed.add(event.id);
      this.#acked.delete(event.id);
      this.#drain(event.id);
      this.#publish({ ...this.#state, sessions: this.#state.sessions.map(session => session.id === event.id ? { ...session, status: "ended" } : session) });
    });
    this.#off = () => { offData(); offExit(); offTmux?.(); };
  }

  #queue(id: string): TerminalPendingOutput {
    let queue = this.pending.get(id);
    if (queue === undefined) { queue = new TerminalPendingOutput(); this.pending.set(id, queue); }
    return queue;
  }

  /** Only scalar credit is retained while xterm queues a potentially large write. */
  #consumed(id: string, bytes: number): () => void {
    return () => this.#ack(id, bytes);
  }

  /** Ended and running terminals share ordered replay; only running ones credit. */
  #drain(id: string): void {
    const host = this.hosts.get(id);
    const queue = this.pending.get(id);
    if (host === undefined || queue === undefined) return;
    const ended = this.#creditsClosed.has(id);
    if (ended) this.pending.delete(id);
    for (const batch of queue.take()) {
      // xterm owns the write queue and preserves the original batch order.
      host.term.write(batch.text, ended ? undefined : this.#consumed(id, batch.bytes));
    }
    if (ended) queue.clear();
    else this.#creditDropped(id, queue);
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

  #notifyTruncation(id: string): void {
    if (this.#state.notices[id] !== undefined) return;
    const limit = Math.round(PENDING_MAX_BYTES / (1024 * 1024));
    this.#publish({
      ...this.#state,
      notices: {
        ...this.#state.notices,
        [id]: isZh()
          ? `后台输出超过 ${limit} MiB 上限，较早的输出已被丢弃。`
          : `Background output exceeded the ${limit} MiB limit; earlier output was discarded.`,
      },
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
    if (this.#creating === 0 && !this.#sessionIds.has(id)) return;
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
    this.#sharedBindings.delete(id);
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
  #publish(state: TerminalState): void {
    if (state.sessions !== this.#state.sessions) {
      this.#sessionIds.clear();
      for (const session of state.sessions) this.#sessionIds.add(session.id);
    }
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

const Context = createContext<TerminalSessions | undefined>(undefined);
export const terminalOwnerKey = (targetId: string | null, workspaceId?: string, sessionId?: string) => JSON.stringify([targetId, workspaceId ?? null, sessionId ?? null]);
export function TerminalSessionsProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new TerminalSessions(globalThis.ompStudioTerminal), []);
  useEffect(() => () => store.close(), [store]);
  useEffect(() => store.restore(), [store]);
  return <Context.Provider value={store}>{children}</Context.Provider>;
}
export function useTerminalStore() {
  const store = useContext(Context);
  if (!store) throw new Error("Terminal sessions need their window provider");
  return store;
}
export function useTerminalSessions() {
  const store = useTerminalStore();
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  return { store, ...state };
}
