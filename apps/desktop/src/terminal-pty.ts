/**
 * Per-window local shell sessions for the Desktop chrome terminal.
 *
 * Spawns a real ConPTY / PTY. This is not Runtime TUI attach and never
 * talks to the Host. Tests inject a fake {@link PtySpawner}.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { win32 } from "node:path";
import { randomBytes } from "node:crypto";
import { commandArguments, resolveCommandShell } from "./terminal-command.js";
import type { TerminalCommand } from "./terminal-shared.js";

import { processGroupSpawnOptions, terminateProcessTree } from "./platform/process-tree.js";
import { TerminalOutputBatcher, type TerminalBatchTimers, type TerminalFlowStats } from "./terminal-batch.js";

import { TERMINAL_MAX_SESSIONS, type TerminalSessionInfo, type TerminalSize } from "./terminal-shared.js";

export interface PtyExitInfo {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface PtyProcess {
  readonly backend?: "pty" | "pipes";
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (info: PtyExitInfo) => void): void;
  /**
   * Stop reading the source (flow control: the Renderer is behind). Optional:
   * a backend without it simply keeps buffering up to the hard cap.
   */
  pause?(): void;
  /** Resume reading after {@link pause}. */
  resume?(): void;
}

export interface PtySpawnOptions {
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly file: string;
  readonly name: string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
}

export interface PtySpawner {
  spawn(options: PtySpawnOptions): PtyProcess;
}

export interface ResolvedShell {
  readonly name: string;
  readonly file: string;
}

export interface ShellResolveOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
  /** macOS account shell (`os.userInfo().shell`); test seam. */
  readonly accountShell?: () => string | undefined;
}

function accountShell(): string | undefined {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

export function resolveDefaultShell(options: ShellResolveOptions = {}): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform === "win32") {
    // Windows path semantics follow the requested platform, not the host.
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const candidates: ReadonlyArray<ResolvedShell> = [
      { name: "pwsh", file: win32.join(programFiles, "PowerShell", "7", "pwsh.exe") },
      { name: "pwsh", file: win32.join(programFiles, "PowerShell", "7-preview", "pwsh.exe") },
      { name: "powershell", file: win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") },
      { name: "cmd", file: env.ComSpec ?? win32.join(systemRoot, "System32", "cmd.exe") },
    ];
    for (const candidate of candidates) {
      if (exists(candidate.file)) return candidate;
    }
    return { name: "cmd", file: env.ComSpec ?? "cmd.exe" };
  }

  // macOS: the account's login shell wins over an inherited $SHELL, like Terminal.app.
  const configured = platform === "darwin" ? (options.accountShell ?? accountShell)() : undefined;
  const unix = configured || (env.SHELL && env.SHELL.length > 0 ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/bash");
  const slash = unix.lastIndexOf("/");
  return { name: slash >= 0 ? unix.slice(slash + 1) : unix, file: unix };
}

export function resolveTerminalCwd(options: { cwd?: string; home?: () => string } = {}): string {
  const cwd = options.cwd ?? process.cwd();
  if (cwd.length > 0) return cwd;
  return options.home?.() ?? homedir();
}

interface NodePtyModule {
  spawn(
    file: string,
    args: readonly string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConpty?: boolean;
    },
  ): {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
    pause(): void;
    resume(): void;
    onData(listener: (data: string) => void): void;
    onExit(listener: (info: { exitCode: number; signal?: number }) => void): void;
  };
}

function loadNodePty(): NodePtyModule {
  const require = createRequire(import.meta.url);
  return require("node-pty") as NodePtyModule;
}

/**
 * The shell's environment. `process.env` already carries the macOS login
 * shell's PATH and LANG (`platform/login-env.ts`); macOS also names the
 * terminal and keeps Electron's own switches out of the user's shell.
 */
export function terminalEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (platform === "darwin" && key.startsWith("ELECTRON_")) continue;
    env[key] = value;
  }
  env.TERM = env.TERM ?? "xterm-256color";
  env.COLORTERM = env.COLORTERM ?? "truecolor";
  if (platform === "darwin") env.TERM_PROGRAM = "OMP-Studio";
  return env;
}

/**
 * Shell arguments. macOS terminals start login shells so profile files run as
 * in Terminal.app; without a PTY the shell must also be told it is interactive.
 */
export function shellArgs(
  file: string,
  options: { readonly platform?: NodeJS.Platform; readonly backend?: "pty" | "pipes" } = {},
): string[] {
  const base = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (base === "pwsh.exe" || base === "pwsh" || base === "powershell.exe" || base === "powershell") {
    return ["-NoLogo"];
  }
  if ((options.platform ?? process.platform) === "darwin") {
    if (base === "csh" || base === "tcsh") return options.backend === "pipes" ? ["-i", "-l"] : ["-l"];
    return options.backend === "pipes" ? ["-il"] : ["-l"];
  }
  return [];
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  // The shell leads its own process group; SIGHUP reaches its jobs like a closed terminal.
  terminateProcessTree(child, "SIGHUP");
}

function spawnWithPipes(options: PtySpawnOptions): PtyProcess {
  const child = spawn(options.file, options.args ?? shellArgs(options.file, { backend: "pipes" }), {
    cwd: options.cwd,
    env: terminalEnvironment(options.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    ...processGroupSpawnOptions(),
  });
  if (child.pid === undefined) {
    throw new Error(`terminal: failed to spawn ${options.name}`);
  }
  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(info: PtyExitInfo) => void> = [];
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    for (const listener of dataListeners) listener(chunk);
  });
  child.stderr?.on("data", (chunk: string) => {
    for (const listener of dataListeners) listener(chunk);
  });
  // Process exit can precede the readable tail, especially while flow control
  // has paused the pipes. `close` means both output streams have drained.
  child.on("close", (code) => {
    for (const listener of exitListeners) listener({ exitCode: code ?? 0 });
  });
  return {
    backend: "pipes",
    write: (data) => {
      child.stdin?.write(data);
    },
    resize: () => {
      // Piped stdio has no console buffer to resize.
    },
    kill: () => {
      killProcessTree(child);
    },
    // Pausing the readable streams lets the OS pipe fill and blocks the child,
    // which is the same back-pressure a real terminal applies.
    pause: () => {
      child.stdout?.pause();
      child.stderr?.pause();
    },
    resume: () => {
      child.stdout?.resume();
      child.stderr?.resume();
    },
    onData: (listener) => {
      dataListeners.push(listener);
    },
    onExit: (listener) => {
      exitListeners.push(listener);
    },
  };
}

function spawnWithNodePty(options: PtySpawnOptions): PtyProcess {
  const pty = loadNodePty();
  const proc = pty.spawn(options.file, options.args ?? shellArgs(options.file, { backend: "pty" }), {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnvironment(options.env),
    useConpty: process.platform === "win32",
  });
  return {
    backend: "pty",
    write: (data) => {
      proc.write(data);
    },
    resize: (cols, rows) => {
      proc.resize(cols, rows);
    },
    kill: () => {
      proc.kill();
    },
    pause: () => {
      proc.pause();
    },
    resume: () => {
      proc.resume();
    },
    onData: (listener) => {
      proc.onData(listener);
    },
    onExit: (listener) => {
      proc.onExit(listener);
    },
  };
}

export function createNodePtySpawner(requirePty = false): PtySpawner {
  let nodePtyOk: boolean | undefined;
  return {
    spawn(options) {
      if (nodePtyOk !== false) {
        try {
          const proc = spawnWithNodePty(options);
          nodePtyOk = true;
          return proc;
        } catch (error) {
          nodePtyOk = false;
          if (requirePty) throw error;
        }
      }
      if (requirePty) throw new Error("SSH terminal requires a working PTY backend");
      return spawnWithPipes(options);
    },
  };
}

export interface TerminalSessionListeners {
  /** One batched payload; `bytes` is its UTF-8 length (for flow control). */
  onData(event: { id: string; data: string; bytes?: number }): void;
  onExit(event: { id: string }): void;
}

interface TerminalSessionRecord {
  readonly windowId: number;
  readonly info: TerminalSessionInfo;
  readonly proc: PtyProcess;
  readonly listeners: TerminalSessionListeners;
  lifecycle: "running" | "draining";
  size: TerminalSize;
}

/** Output batching / flow-control tuning; defaults live in `terminal-batch.ts`. */
export interface TerminalSessionOutputOptions {
  readonly batchMs?: number;
  readonly highWaterBytes?: number;
  readonly lowWaterBytes?: number;
  readonly hardCapBytes?: number;
  readonly timers?: TerminalBatchTimers;
}

export interface TerminalSessionManagerOptions {
  readonly spawner: PtySpawner;
  readonly resolveShell?: () => ResolvedShell;
  readonly resolveCwd?: () => string;
  readonly newId?: () => string;
  readonly recording?: {
    /** Fed from the batcher, not per PTY chunk (see `terminal-batch.ts`). */
    output(windowId: number, id: string, data: string): void;
    resize(windowId: number, id: string, cols: number, rows: number): void;
    end(windowId: number, id: string): void;
    disposeWindow(windowId: number): void;
  };
  readonly output?: TerminalSessionOutputOptions;
}

export class TerminalSessionManager {
  readonly #sessions = new Map<string, TerminalSessionRecord>();
  readonly #spawner: PtySpawner;
  readonly #resolveShell: () => ResolvedShell;
  readonly #resolveCwd: () => string;
  readonly #newId: () => string;
  readonly #recording: TerminalSessionManagerOptions["recording"];
  readonly #batcher: TerminalOutputBatcher;
  #capFlushes = 0;

  constructor(options: TerminalSessionManagerOptions) {
    this.#spawner = options.spawner;
    this.#resolveShell = options.resolveShell ?? (() => resolveDefaultShell());
    this.#resolveCwd = options.resolveCwd ?? (() => resolveTerminalCwd());
    this.#newId = options.newId ?? (() => randomBytes(16).toString("base64url"));
    this.#recording = options.recording;
    const output = options.output;
    this.#batcher = new TerminalOutputBatcher({
      sink: {
        send: (id, data, bytes) => {
          this.#sessions.get(id)?.listeners.onData({ id, data, bytes });
        },
        record: (id, data) => {
          const session = this.#sessions.get(id);
          if (session !== undefined) this.#recording?.output(session.windowId, id, data);
        },
        pauseSource: (id, paused) => {
          const proc = this.#sessions.get(id)?.proc;
          if (paused) proc?.pause?.();
          else proc?.resume?.();
        },
        capReached: () => {
          this.#capFlushes += 1;
        },
        release: (id) => {
          const session = this.#sessions.get(id);
          if (session === undefined) return;
          this.#sessions.delete(id);
          this.#recording?.end(session.windowId, id);
        },
      },
      ...(output?.timers === undefined ? {} : { timers: output.timers }),
      ...(output?.batchMs === undefined ? {} : { batchMs: output.batchMs }),
      ...(output?.highWaterBytes === undefined ? {} : { highWaterBytes: output.highWaterBytes }),
      ...(output?.lowWaterBytes === undefined ? {} : { lowWaterBytes: output.lowWaterBytes }),
      ...(output?.hardCapBytes === undefined ? {} : { hardCapBytes: output.hardCapBytes }),
    });
  }

  /** Cap-forced flushes and open buffers (diagnostics/tests). */
  get flow(): { readonly capFlushes: number; readonly openBuffers: number } {
    return { capFlushes: this.#capFlushes, openBuffers: this.#batcher.openSessions };
  }

  create(
    windowId: number,
    size: TerminalSize & { readonly flowControl?: boolean; readonly command?: TerminalCommand },
    listeners: TerminalSessionListeners,
    workspaceCwd?: string,
  ): TerminalSessionInfo {
    let running = 0;
    for (const session of this.#sessions.values()) {
      if (session.windowId === windowId && session.lifecycle === "running") running++;
    }
    if (running >= TERMINAL_MAX_SESSIONS) {
      throw new Error(`terminal: at most ${TERMINAL_MAX_SESSIONS} sessions per window`);
    }
    const args = size.command ? commandArguments(size.command) : undefined;
    const shell = size.command ? resolveCommandShell(size.command) : this.#resolveShell();
    const cwd = workspaceCwd ?? this.#resolveCwd();
    const id = this.#newId();
    const info: TerminalSessionInfo = { id, name: shell.name, cwd };
    const proc = this.#spawner.spawn({
      file: shell.file,
      ...(args ? { args } : {}),
      name: shell.name,
      cwd,
      cols: size.cols,
      rows: size.rows,
    });
    const session: TerminalSessionRecord = { windowId, info, proc, listeners, lifecycle: "running", size };
    this.#sessions.set(id, session);
    // `flowControl` is only true when the Renderer acknowledges xterm writes.
    this.#batcher.open(id, { flowControl: size.flowControl === true });
    if (size.command) this.#batcher.push(id, size.command.text.replace(/\r?\n/g, "\r\n") + "\r\n\r\n");
    proc.onData((data) => {
      // Draining records still accept ConPTY's late output for one window.
      this.#batcher.push(id, data);
    });
    proc.onExit(() => this.#markEnded(id));
    return info;
  }

  /** Renderer wrote `bytes` of this terminal's output to xterm (flow control). */
  acknowledge(windowId: number, id: string, bytes: number): void {
    const session = this.#sessions.get(id);
    if (session?.windowId !== windowId) return;
    this.#batcher.acknowledge(id, bytes);
  }

  /** Flow-control state for tests and diagnostics (`undefined` once released). */
  flowStats(id: string): TerminalFlowStats | undefined {
    return this.#batcher.stats(id);
  }

  write(windowId: number, id: string, data: string): void {
    // A write sent before the renderer observes exit must remain a no-op.
    const session = this.#sessions.get(id);
    if (session?.windowId !== windowId || session.lifecycle !== "running") return;
    session.proc.write(data);
  }

  resize(windowId: number, id: string, cols: number, rows: number): void {
    const session = this.#sessions.get(id);
    if (session?.windowId !== windowId || session.lifecycle !== "running") return;
    // Earlier output belongs to the old recording geometry.
    this.#batcher.flush(id);
    session.proc.resize(cols, rows);
    session.size = { cols, rows };
    this.#recording?.resize(windowId, id, cols, rows);
  }

  recordingTarget(windowId: number, id: string): TerminalSize & { name: string; backend: "pty" | "pipes" } {
    const session = this.#require(windowId, id);
    if (session.lifecycle !== "running") throw new Error("Terminal has exited");
    return { ...session.size, name: session.info.name, backend: session.proc.backend ?? "pipes" };
  }

  dispose(windowId: number, id: string, listeners?: TerminalSessionListeners): void {
    const session = this.#sessions.get(id);
    if (session?.windowId === windowId) this.#kill(session, id, listeners);
  }

  /** Recording boundaries drain output while the recording is still open. */
  flushOutput(windowId: number, id?: string): void {
    if (id !== undefined) {
      if (this.#sessions.get(id)?.windowId === windowId) this.#batcher.flush(id);
      return;
    }
    for (const [terminalId, session] of this.#sessions) {
      if (session.windowId === windowId) this.#batcher.flush(terminalId);
    }
  }

  disposeWindow(windowId: number): void {
    for (const [id, session] of this.#sessions) {
      if (session.windowId === windowId) this.#kill(session, id);
    }
    this.#recording?.disposeWindow(windowId);
  }

  disposeAll(): void {
    const windows = new Set<number>();
    for (const [id, session] of this.#sessions) {
      windows.add(session.windowId);
      this.#kill(session, id);
    }
    for (const windowId of windows) this.#recording?.disposeWindow(windowId);
  }

  #require(windowId: number, id: string): TerminalSessionRecord {
    const session = this.#sessions.get(id);
    if (session?.windowId !== windowId) throw new Error("terminal: unknown session");
    return session;
  }

  /** Draining records retain their sink but no longer occupy a running slot. */
  #markEnded(id: string): void {
    const session = this.#sessions.get(id);
    if (session === undefined || session.lifecycle !== "running") return;
    session.lifecycle = "draining";
    this.#batcher.finish(id);
    session.listeners.onExit({ id });
  }

  #kill(session: TerminalSessionRecord, id: string, listeners?: TerminalSessionListeners): void {
    const running = session.lifecycle === "running";
    session.lifecycle = "draining";
    // Output, recording end and release precede process termination / exit.
    this.#batcher.close(id);
    if (!running) return;
    try {
      session.proc.kill();
    } catch {
      // Process may already have exited.
    }
    listeners?.onExit({ id });
  }
}
