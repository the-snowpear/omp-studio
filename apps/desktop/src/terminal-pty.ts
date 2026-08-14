/**
 * Per-window local shell sessions for the Desktop chrome terminal.
 *
 * Spawns a real ConPTY / PTY. This is not Runtime TUI attach and never
 * talks to the Host. Tests inject a fake {@link PtySpawner}.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { TERMINAL_MAX_SESSIONS, type TerminalSessionInfo, type TerminalSize } from "./terminal-shared.js";

export interface PtyExitInfo {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface PtyProcess {
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
}

export function resolveDefaultShell(options: ShellResolveOptions = {}): ResolvedShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    const systemRoot = env.SystemRoot ?? env.windir ?? "C:\\Windows";
    const candidates: ReadonlyArray<ResolvedShell> = [
      { name: "pwsh", file: join(programFiles, "PowerShell", "7", "pwsh.exe") },
      { name: "pwsh", file: join(programFiles, "PowerShell", "7-preview", "pwsh.exe") },
      { name: "powershell", file: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") },
      { name: "cmd", file: env.ComSpec ?? join(systemRoot, "System32", "cmd.exe") },
    ];
    for (const candidate of candidates) {
      if (exists(candidate.file)) return candidate;
    }
    return { name: "cmd", file: env.ComSpec ?? "cmd.exe" };
  }

  const unix = env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/bash";
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

function processEnvRecord(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.TERM = env.TERM ?? "xterm-256color";
  env.COLORTERM = env.COLORTERM ?? "truecolor";
  return env;
}

function shellArgs(file: string): string[] {
  const base = file.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (base === "pwsh.exe" || base === "pwsh" || base === "powershell.exe" || base === "powershell") {
    return ["-NoLogo"];
  }
  return [];
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

function spawnWithPipes(options: PtySpawnOptions): PtyProcess {
  const child = spawn(options.file, shellArgs(options.file), {
    cwd: options.cwd,
    env: processEnvRecord(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
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
    write: (data) => {
      child.stdin?.write(data);
    },
    resize: () => {
      // Piped stdio has no console buffer to resize.
    },
    kill: () => {
      if (child.pid !== undefined) killProcessTree(child.pid);
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
  const proc = pty.spawn(options.file, shellArgs(options.file), {
    name: "xterm-256color",
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: processEnvRecord(),
    useConpty: process.platform === "win32",
  });
  return {
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
}

export interface TerminalSessionManagerOptions {
  readonly spawner: PtySpawner;
  readonly resolveShell?: () => ResolvedShell;
  readonly resolveCwd?: () => string;
  readonly newId?: () => string;
}

export class TerminalSessionManager {
  readonly #windows = new Map<number, Map<string, LiveSession>>();
  readonly #spawner: PtySpawner;
  readonly #resolveShell: () => ResolvedShell;
  readonly #resolveCwd: () => string;
  readonly #newId: () => string;

  constructor(options: TerminalSessionManagerOptions) {
    this.#spawner = options.spawner;
    this.#resolveShell = options.resolveShell ?? (() => resolveDefaultShell());
    this.#resolveCwd = options.resolveCwd ?? (() => resolveTerminalCwd());
    this.#newId = options.newId ?? (() => randomBytes(16).toString("base64url"));
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
    const session: LiveSession = { info, proc, ended: false };
    proc.onData((data) => {
      if (!session.ended) listeners.onData({ id, data });
    });
    proc.onExit(() => {
      this.#markEnded(windowId, id, listeners);
    });
    bucket.set(id, session);
    return info;
  }

  write(windowId: number, id: string, data: string): void {
    const session = this.#require(windowId, id);
    if (session.ended) return;
    session.proc.write(data);
  }

  resize(windowId: number, id: string, cols: number, rows: number): void {
    const session = this.#require(windowId, id);
    if (session.ended) return;
    session.proc.resize(cols, rows);
  }

  dispose(windowId: number, id: string, listeners?: TerminalSessionListeners): void {
    const bucket = this.#windows.get(windowId);
    const session = bucket?.get(id);
    if (session === undefined) return;
    this.#kill(session, windowId, id, listeners);
  }

  disposeWindow(windowId: number): void {
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

  #markEnded(windowId: number, id: string, listeners: TerminalSessionListeners): void {
    const session = this.#windows.get(windowId)?.get(id);
    if (session === undefined || session.ended) return;
    session.ended = true;
    listeners.onExit({ id });
  }

  #kill(session: LiveSession, windowId: number, id: string, listeners?: TerminalSessionListeners): void {
    if (!session.ended) {
      session.ended = true;
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
