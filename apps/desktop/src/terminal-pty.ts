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

import { processGroupSpawnOptions, terminateProcessTree } from "./platform/process-tree.js";

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
}

export interface PtySpawnOptions {
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
  const child = spawn(options.file, shellArgs(options.file, { backend: "pipes" }), {
    cwd: options.cwd,
    env: terminalEnvironment(),
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
  child.on("exit", (code) => {
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
  const proc = pty.spawn(options.file, shellArgs(options.file, { backend: "pty" }), {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: terminalEnvironment(),
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
    onData: (listener) => {
      proc.onData(listener);
    },
    onExit: (listener) => {
      proc.onExit(listener);
    },
  };
}

export function createNodePtySpawner(): PtySpawner {
  let nodePtyOk: boolean | undefined;
  return {
    spawn(options) {
      if (nodePtyOk !== false) {
        try {
          const proc = spawnWithNodePty(options);
          nodePtyOk = true;
          return proc;
        } catch {
          nodePtyOk = false;
        }
      }
      return spawnWithPipes(options);
    },
  };
}

export interface TerminalSessionListeners {
  onData(event: { id: string; data: string }): void;
  onExit(event: { id: string }): void;
}

interface LiveSession {
  readonly info: TerminalSessionInfo;
  readonly proc: PtyProcess;
  ended: boolean;
  size: TerminalSize;
}

export interface TerminalSessionManagerOptions {
  readonly spawner: PtySpawner;
  readonly resolveShell?: () => ResolvedShell;
  readonly resolveCwd?: () => string;
  readonly newId?: () => string;
  readonly recording?: {
    output(windowId: number, id: string, data: string): void;
    resize(windowId: number, id: string, cols: number, rows: number): void;
    end(windowId: number, id: string): void;
    disposeWindow(windowId: number): void;
  };
}

export class TerminalSessionManager {
  readonly #windows = new Map<number, Map<string, LiveSession>>();
  readonly #spawner: PtySpawner;
  readonly #resolveShell: () => ResolvedShell;
  readonly #resolveCwd: () => string;
  readonly #newId: () => string;
  readonly #recording: TerminalSessionManagerOptions["recording"];

  constructor(options: TerminalSessionManagerOptions) {
    this.#spawner = options.spawner;
    this.#resolveShell = options.resolveShell ?? (() => resolveDefaultShell());
    this.#resolveCwd = options.resolveCwd ?? (() => resolveTerminalCwd());
    this.#newId = options.newId ?? (() => randomBytes(16).toString("base64url"));
    this.#recording = options.recording;
  }

  create(windowId: number, size: TerminalSize, listeners: TerminalSessionListeners): TerminalSessionInfo {
    const bucket = this.#bucket(windowId);
    if (bucket.size >= TERMINAL_MAX_SESSIONS) {
      throw new Error(`terminal: at most ${TERMINAL_MAX_SESSIONS} sessions per window`);
    }
    const shell = this.#resolveShell();
    const cwd = this.#resolveCwd();
    const id = this.#newId();
    const info: TerminalSessionInfo = { id, name: shell.name, cwd };
    const proc = this.#spawner.spawn({
      file: shell.file,
      name: shell.name,
      cwd,
      cols: size.cols,
      rows: size.rows,
    });
    const session: LiveSession = { info, proc, ended: false, size };
    proc.onData((data) => {
      if (!session.ended) { this.#recording?.output(windowId, id, data); listeners.onData({ id, data }); }
    });
    proc.onExit(() => {
      this.#markEnded(windowId, id, listeners);
    });
    bucket.set(id, session);
    return info;
  }

  write(windowId: number, id: string, data: string): void {
    // A session that has exited is deleted from the registry (see `#markEnded`),
    // so a late write must be a no-op rather than "unknown session": the
    // Renderer cannot have observed the exit before it sent this.
    const session = this.#windows.get(windowId)?.get(id);
    if (session === undefined || session.ended) return;
    session.proc.write(data);
  }

  resize(windowId: number, id: string, cols: number, rows: number): void {
    const session = this.#windows.get(windowId)?.get(id);
    if (session === undefined || session.ended) return;
    session.proc.resize(cols, rows);
    session.size = { cols, rows }; this.#recording?.resize(windowId, id, cols, rows);
  }

  recordingTarget(windowId: number, id: string): TerminalSize & { name: string; backend: "pty" | "pipes" } {
    const session = this.#require(windowId, id);
    if (session.ended) throw new Error("Terminal has exited");
    return { ...session.size, name: session.info.name, backend: session.proc.backend ?? "pipes" };
  }

  dispose(windowId: number, id: string, listeners?: TerminalSessionListeners): void {
    const bucket = this.#windows.get(windowId);
    const session = bucket?.get(id);
    if (session === undefined) return;
    this.#kill(session, windowId, id, listeners);
  }

  disposeWindow(windowId: number): void {
    this.#recording?.disposeWindow(windowId);
    const bucket = this.#windows.get(windowId);
    if (bucket === undefined) return;
    for (const [id, session] of bucket) {
      this.#kill(session, windowId, id);
    }
    this.#windows.delete(windowId);
  }

  disposeAll(): void {
    for (const windowId of [...this.#windows.keys()]) {
      this.disposeWindow(windowId);
    }
  }

  #bucket(windowId: number): Map<string, LiveSession> {
    const existing = this.#windows.get(windowId);
    if (existing !== undefined) return existing;
    const created = new Map<string, LiveSession>();
    this.#windows.set(windowId, created);
    return created;
  }

  #require(windowId: number, id: string): LiveSession {
    const session = this.#windows.get(windowId)?.get(id);
    if (session === undefined) {
      throw new Error("terminal: unknown session");
    }
    return session;
  }

  /**
   * A shell that exits on its own must free its registry slot, not just flip a
   * flag: the bucket is capped at `TERMINAL_MAX_SESSIONS`, so leaving dead rows
   * behind made `create` throw after that many natural exits. `#kill` already
   * deletes; this is the same cleanup for the path where the process is already
   * gone.
   */
  #markEnded(windowId: number, id: string, listeners: TerminalSessionListeners): void {
    const session = this.#windows.get(windowId)?.get(id);
    if (session === undefined || session.ended) return;
    session.ended = true;
    this.#recording?.end(windowId, id);
    this.#windows.get(windowId)?.delete(id);
    listeners.onExit({ id });
  }

  #kill(session: LiveSession, windowId: number, id: string, listeners?: TerminalSessionListeners): void {
    if (!session.ended) {
      session.ended = true;
      this.#recording?.end(windowId, id);
      try {
        session.proc.kill();
      } catch {
        // Process may already have exited.
      }
      listeners?.onExit({ id });
    }
    this.#windows.get(windowId)?.delete(id);
  }
}
