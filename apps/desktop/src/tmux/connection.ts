import { randomBytes } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { TerminalOutputBatcher, TERMINAL_FLOW_LOW_BYTES, type TerminalOutputBatcherOptions } from "../terminal-batch.js";
import type { TerminalSessionListeners } from "../terminal-pty.js";
import { terminateProcessTree } from "../platform/process-tree.js";
import { TmuxControlClient } from "./control-client.js";
import { actionLines, sendKeysLines, splitTmuxFields, supportedTmuxVersion } from "./commands.js";
import { parseTmuxLayout } from "./layout.js";
import { TMUX_MAX_PANES_PER_CONNECTION, type TmuxAttachInput, type TmuxAction, type TmuxTopology } from "./tmux-shared.js";

export type TmuxLog = (level: "info" | "warn", event: string, detail: Record<string, unknown>) => void;
export interface TmuxListeners extends TerminalSessionListeners { onTopology(topology: TmuxTopology): void }
export interface TmuxConnectionOptions {
  id: string; windowId: number; input: TmuxAttachInput; session: string;
  process: ChildProcessWithoutNullStreams; listeners: TmuxListeners;
  release(): void; log?: TmuxLog;
  batchOptions?: Omit<TerminalOutputBatcherOptions, "sink">;
  detachTimeoutMs?: number;
}
const windowFormat = "#{window_id}\t#{window_index}\t#{window_active}\t#{window_flags}\t#{window_visible_layout}\t#{window_layout}\t#{window_name}";
const paneFormat = "#{pane_id}\t#{window_id}\t#{pane_active}\t#{pane_dead}\t#{alternate_on}\t#{cursor_x}\t#{cursor_y}\t#{keypad_cursor_flag}\t#{keypad_flag}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{wrap_flag}\t#{origin_flag}\t#{scroll_region_upper}\t#{scroll_region_lower}\t#{cursor_flag}\t#{pane_title}";
const id = () => randomBytes(16).toString("base64url");
const joinLines = (lines: Buffer[]) => Buffer.concat(lines.flatMap((line, index) => index ? [Buffer.from("\r\n"), line] : [line]));

export class TmuxConnection {
  readonly client: TmuxControlClient;
  readonly batcher: TerminalOutputBatcher;
  readonly topology: TmuxTopology;
  readonly exited: Promise<void>;
  #exit!: () => void;
  #ended = false;
  #detaching = false;
  #initialized = false;
  #startedAt = Date.now();
  #stderr = "";
  #noise = 0;
  #pausedSources = new Set<string>();
  #restoring = new Set<string>();
  #buffers = new Map<string, { chunks: Buffer[]; bytes: number }>();
  #paneInfo = new Map<string, string[]>();
  #refreshTimer: ReturnType<typeof setTimeout> | undefined;
  #topologyTimer: ReturnType<typeof setTimeout> | undefined;
  #resizeTimer: ReturnType<typeof setTimeout> | undefined;
  #resize: TmuxAction | undefined;
  #refreshing: Promise<void> | undefined;
  #again = false;
  #knownTerminals = new Set<string>();

  constructor(readonly options: TmuxConnectionOptions) {
    this.topology = { connectionId: options.id, targetId: options.input.targetId, workspaceId: options.input.workspaceId, state: "attaching", session: { id: "", name: options.session }, windows: [], panes: {} };
    this.exited = new Promise(resolve => { this.#exit = resolve; });
    this.batcher = new TerminalOutputBatcher({ ...options.batchOptions, sink: {
      send: (id, data, bytes) => options.listeners.onData({ id, data, bytes }),
      pauseSource: (id, paused) => {
        if (paused) this.#pausedSources.add(id); else this.#pausedSources.delete(id);
        if (this.#pausedSources.size) options.process.stdout.pause(); else options.process.stdout.resume();
        if (!paused) this.#resumePaused();
      },
    } });
    this.client = new TmuxControlClient(options.process.stdin, {
      onNotification: (name, args) => this.#notification(name, args.toString()),
      onPaneOutput: (pane, bytes) => this.#output(pane, Buffer.from(bytes)),
      onNoise: () => { if (this.#noise++ < 20) this.#log("noise", { lines: this.#noise }); },
      onProtocolError: kind => { this.#log("protocol_error", { kind }); this.#scheduleRefresh(); },
      onCommandError: () => this.#log("protocol_error", { kind: "command" }),
    });
    options.process.stdout.on("data", (chunk: Buffer) => this.client.parser.push(chunk));
    options.process.stderr.on("data", (chunk: Buffer) => { this.#stderr = (this.#stderr + chunk.toString()).slice(-2048); });
    options.process.on("error", error => { this.#finish("lost", error.message); this.#release(); });
    options.process.on("close", () => {
      if (!this.#ended) this.#finish(this.#detaching ? "exited" : "lost", this.#detaching ? "detached" : this.#stderr || "ssh-failed");
      this.#release();
    });
  }
  get alive(): boolean { return !this.#ended && !this.#detaching; }
  owns(terminalId: string): boolean { return this.#knownTerminals.has(terminalId); }
  async start(): Promise<void> {
    this.#publish();
    try {
      await this.client.ready;
      const version = (await this.client.run("display-message -p '#{version}'"))[0]!.toString();
      this.topology.version = version;
      if (!supportedTmuxVersion(version)) { this.#finish("exited", "too-old"); await this.detach(); return; }
      await this.client.run("refresh-client -f pause-after=15");
      await this.client.run(`refresh-client -C ${this.options.input.cols}x${this.options.input.rows}`);
      const session = splitTmuxFields((await this.client.run("display-message -p '#{session_id}\t#{session_name}'"))[0]!.toString(), 2);
      this.topology.session = { id: session[0]!, name: session[1]! };
      await this.#refresh();
      this.#initialized = true;
      await this.client.run("refresh-client -B 'studio-title:%*:#{pane_title}'");
      await this.client.run("refresh-client -B 'studio-cwd:%*:#{pane_current_path}'");
      this.#log("attach", { version, elapsedMs: Date.now() - this.#startedAt, result: "attached" });
    } catch (error) {
      if (!this.#ended) this.#finish("lost", this.#stderr || (error instanceof Error ? error.message : String(error)));
      await this.detach();
    }
  }
  #log(event: string, detail: Record<string, unknown>): void { this.options.log?.(event === "protocol_error" ? "warn" : "info", `desktop.tmux.${event}`, detail); }
  #publish(): void {
    clearTimeout(this.#topologyTimer); this.#topologyTimer = undefined;
    this.options.listeners.onTopology({ ...this.topology, windows: [...this.topology.windows], panes: Object.fromEntries(Object.entries(this.topology.panes).map(([id, pane]) => [id, { ...pane }])) });
  }
  #changed(): void {
    if (!this.#topologyTimer) this.#topologyTimer = setTimeout(() => this.#publish(), 16);
  }
  #scheduleRefresh(): void {
    if (!this.#initialized || !this.alive) return;
    if (this.#refreshing) { this.#again = true; return; }
    if (!this.#refreshTimer) this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined;
      void this.#refresh().catch(() => { if (this.alive) this.#log("protocol_error", { kind: "refresh" }); });
    }, 16);
  }
  #refresh(): Promise<void> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#readTopology().finally(() => {
      this.#refreshing = undefined;
      if (this.#again) { this.#again = false; this.#scheduleRefresh(); }
    });
    return this.#refreshing;
  }
  async #readTopology(): Promise<void> {
    const windows = await this.client.run(`list-windows -F '${windowFormat}'`);
    const panes = await this.client.run(`list-panes -s -F '${paneFormat}'`);
    if (!this.alive) return;
    const nextWindows: TmuxTopology["windows"] = [];
    for (const line of windows) {
      const [id, index, active, flags, layout, full, name] = splitTmuxFields(line.toString(), 7);
      const parsed = parseTmuxLayout(layout!);
      const fullLayout = parseTmuxLayout(full!);
      if (!parsed || !fullLayout) { this.#log("protocol_error", { kind: "layout" }); return; }
      nextWindows.push({ id: id!, index: Number(index), name: name!, zoomed: flags!.includes("Z"), layout: parsed.root, fullLayout: fullLayout.root, cols: parsed.root.cols, rows: parsed.root.rows });
      if (active === "1") this.topology.activeWindowId = id!;
    }
    const nextPanes: TmuxTopology["panes"] = {}, added: string[] = [];
    for (const [index, line] of panes.entries()) {
      const fields = splitTmuxFields(line.toString(), 17);
      const [paneId, windowId, active, dead] = fields;
      const previous = this.topology.panes[paneId!];
      const off = index >= TMUX_MAX_PANES_PER_CONNECTION || previous?.off === true;
      const terminalId = previous?.terminalId ?? id();
      nextPanes[paneId!] = { ...previous, terminalId, windowId: windowId!, active: active === "1", dead: dead === "1", title: fields[16]!, paused: previous?.paused ?? false, off };
      this.#paneInfo.set(paneId!, fields);
      if (!previous) {
        this.#knownTerminals.add(terminalId);
        if (!off) { this.batcher.open(terminalId, { flowControl: this.options.input.flowControl === true }); this.#restoring.add(paneId!); added.push(paneId!); }
        else { this.client.fire(`refresh-client -A '${paneId}:off'`); this.#buffers.delete(paneId!); }
      }
    }
    for (const [paneId, pane] of Object.entries(this.topology.panes)) if (!nextPanes[paneId]) {
      this.batcher.finish(pane.terminalId); this.batcher.close(pane.terminalId);
      this.#knownTerminals.delete(pane.terminalId); this.#pausedSources.delete(pane.terminalId);
      this.#buffers.delete(paneId); this.#restoring.delete(paneId); this.#paneInfo.delete(paneId);
    }
    this.topology.windows = nextWindows; this.topology.panes = nextPanes;
    this.topology.state = "attached";
    // Renderer learns every terminalId before any restore or live output is sent.
    this.#publish();
    for (const paneId of added) await this.#restore(paneId, false);
    if (!this.#pausedSources.size) this.options.process.stdout.resume();
  }
  #output(paneId: string, bytes: Buffer): void {
    if (this.#ended) return;
    const pane = this.topology.panes[paneId];
    if (pane?.off) return;
    if (!pane || this.#restoring.has(paneId)) {
      let buffer = this.#buffers.get(paneId);
      if (!buffer) {
        if (this.#buffers.size >= TMUX_MAX_PANES_PER_CONNECTION) { this.#scheduleRefresh(); return; }
        buffer = { chunks: [], bytes: 0 }; this.#buffers.set(paneId, buffer);
      }
      buffer.chunks.push(bytes); buffer.bytes += bytes.length;
      let dropped = 0;
      while (buffer.bytes > 1024 * 1024 && buffer.chunks.length) { const length = buffer.chunks.shift()!.length; buffer.bytes -= length; dropped += length; }
      if (dropped) this.#log("protocol_error", { kind: "restore-overflow", droppedBytes: dropped });
      if (!pane) this.#scheduleRefresh();
    } else this.batcher.push(pane.terminalId, bytes);
  }
  async #restore(paneId: string, visibleOnly: boolean, refreshInfo = false): Promise<void> {
    const pane = this.topology.panes[paneId];
    if (!pane || pane.off || !this.alive) return;
    this.#restoring.add(paneId);
    try {
      if (refreshInfo) this.#paneInfo.set(paneId, splitTmuxFields((await this.client.run(`display-message -p -t ${paneId} '${paneFormat}'`))[0]!.toString(), 17));
      const info = this.#paneInfo.get(paneId)!;
      const alternate = info[4] === "1";
      // -a is the SAVED normal screen while the application uses its alternate screen.
      const normal = await this.client.run(`capture-pane -p -e -J${alternate ? " -a" : ""} -t ${paneId}${visibleOnly ? "" : " -S -1000"}`);
      const parts = [Buffer.from("\x1b[?1049l\x1b[0m\x1b[?6l\x1b[r\x1b[H\x1b[2J"), joinLines(normal)];
      if (alternate) {
        const screen = await this.client.run(`capture-pane -p -e -t ${paneId}`);
        parts.push(Buffer.from("\x1b[?1049h\x1b[H\x1b[2J"), joinLines(screen));
      }
      let modes = "";
      for (const [index, mode] of [[7, 1], [9, 1003], [10, 1006], [11, 7], [12, 6], [15, 25]]) modes += `\x1b[?${mode}${info[index!] === "1" ? "h" : "l"}`;
      modes += info[8] === "1" ? "\x1b=" : "\x1b>";
      const upper = Number(info[13]), lower = Number(info[14]);
      modes += `\x1b[${upper + 1};${lower + 1}r\x1b[${Number(info[6]) + 1 - (info[12] === "1" ? upper : 0)};${Number(info[5]) + 1}H`;
      parts.push(Buffer.from(modes));
      this.batcher.push(pane.terminalId, Buffer.concat(parts));
      const buffer = this.#buffers.get(paneId);
      if (buffer) this.batcher.push(pane.terminalId, Buffer.concat(buffer.chunks, buffer.bytes));
    } finally { this.#buffers.delete(paneId); this.#restoring.delete(paneId); }
  }
  #notification(name: string, args: string): void {
    if (name === "%exit") { this.#finish("exited", args || "session-ended"); return; }
    if (this.#ended) return;
    if (name === "%pause" || name === "%continue") {
      const pane = this.topology.panes[args];
      if (pane) { pane.paused = name === "%pause"; this.#changed(); if (pane.paused) this.#resumePaused(); }
    } else if (name === "%layout-change") {
      const [windowId, layout, visible, flags] = args.split(" ");
      const parsed = parseTmuxLayout(visible ?? layout!);
      const full = parseTmuxLayout(layout!);
      const window = this.topology.windows.find(window => window.id === windowId);
      if (parsed && full && window) {
        this.topology.windows = this.topology.windows.map(item => item === window ? { ...item, layout: parsed.root, fullLayout: full.root, cols: parsed.root.cols, rows: parsed.root.rows, zoomed: flags?.includes("Z") ?? false } : item);
        this.#changed();
      }
      this.#scheduleRefresh();
    } else if (name === "%subscription-changed") {
      const delimiter = args.indexOf(" : ");
      const [subscription, , , , paneId] = args.slice(0, delimiter).split(" ");
      const pane = this.topology.panes[paneId!];
      if (pane) { if (subscription === "studio-title") pane.title = args.slice(delimiter + 3); if (subscription === "studio-cwd") pane.cwd = args.slice(delimiter + 3); this.#changed(); }
    } else if (name === "%session-changed") {
      const space = args.indexOf(" "); this.topology.session = { id: args.slice(0, space), name: args.slice(space + 1) }; this.#changed(); this.#scheduleRefresh();
    } else if (name === "%session-renamed") {
      if (this.topology.session) this.topology.session = { ...this.topology.session, name: args.startsWith("$") ? args.slice(args.indexOf(" ") + 1) : args }; this.#changed();
    } else if (name === "%config-error") {
      this.topology.configErrors = [...new Set([...(this.topology.configErrors ?? []), args])].slice(0, 20); this.#changed(); this.#log("protocol_error", { kind: "config" });
    } else if (["%window-add", "%window-close", "%window-renamed", "%window-pane-changed", "%session-window-changed", "%pane-mode-changed"].includes(name)) this.#scheduleRefresh();
  }
  #resumePaused(): void {
    if (!this.alive) return;
    for (const [id, pane] of Object.entries(this.topology.panes)) if (pane.paused && !this.#restoring.has(id) && !pane.off && (this.batcher.stats(pane.terminalId)?.unackedBytes ?? 0) <= (this.options.batchOptions?.lowWaterBytes ?? TERMINAL_FLOW_LOW_BYTES)) {
      this.#restoring.add(id);
      void this.client.run(`refresh-client -A '${id}:continue'`).then(() => this.#restore(id, true, true)).then(() => { pane.paused = false; this.#changed(); }).catch(() => { this.#restoring.delete(id); });
    }
  }
  write(terminalId: string, data: string): void {
    const entry = Object.entries(this.topology.panes).find(([, pane]) => pane.terminalId === terminalId);
    if (!this.alive || !entry || entry[1].dead || entry[1].paused || entry[1].off) return;
    for (const line of sendKeysLines(entry[0], data)) this.client.fire(line);
  }
  acknowledge(terminalId: string, bytes: number): void { this.batcher.acknowledge(terminalId, bytes); this.#resumePaused(); }
  async command(action: TmuxAction): Promise<void> {
    if (!this.alive) throw new Error("tmux connection closed");
    // Authorize native tmux targets against this connection's topology.
    const panes = "paneIds" in action ? action.paneIds : "paneId" in action ? [action.paneId] : [];
    const window = "windowId" in action ? action.windowId : "afterWindowId" in action ? action.afterWindowId : undefined;
    if (panes.some(id => !this.topology.panes[id]) || window && !this.topology.windows.some(item => item.id === window)) throw new Error("tmux target is not in this connection");
    if (action.kind === "resizeWindow") {
      this.#resize = action;
      if (!this.#resizeTimer) this.#resizeTimer = setTimeout(() => { this.#resizeTimer = undefined; if (this.alive && this.#resize) for (const line of actionLines(this.#resize)) this.client.fire(line); }, 16);
      return;
    }
    for (const line of actionLines(action)) await this.client.run(line);
    if (action.kind === "setPaneVisible") {
      for (const id of action.paneIds) {
        const pane = this.topology.panes[id]!; pane.off = !action.visible;
        if (action.visible) { this.batcher.open(pane.terminalId, { flowControl: this.options.input.flowControl === true }); await this.#restore(id, true, true); }
      }
      this.#changed();
    }
  }
  #finish(state: "exited" | "lost", reason: string): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#refreshTimer); clearTimeout(this.#resizeTimer); clearTimeout(this.#topologyTimer);
    this.topology.state = state; this.topology.reason = reason;
    this.client.close(new Error(reason));
    for (const pane of Object.values(this.topology.panes)) { this.batcher.finish(pane.terminalId); this.options.listeners.onExit({ id: pane.terminalId }); }
    this.#publish();
    this.#log("exit", { state, reason: state === "lost" ? "ssh-failed" : this.#detaching ? "detached" : "tmux-exit" });
  }
  #release(): void { this.options.release(); this.#exit(); }
  async detach(timeoutMs = this.options.detachTimeoutMs ?? 3000): Promise<void> {
    if (!this.#detaching) { this.#detaching = true; this.client.detach(); this.options.process.stdout.resume(); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.exited, new Promise<void>(resolve => { timer = setTimeout(() => { terminateProcessTree(this.options.process); resolve(); }, timeoutMs); })]);
    clearTimeout(timer);
    if (!this.#ended) this.#finish("exited", "detached");
    this.batcher.closeAll(); this.#buffers.clear(); this.#pausedSources.clear(); this.options.release();
  }
}
