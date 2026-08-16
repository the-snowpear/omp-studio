import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { CommandRequestId, OperationProgress } from "@omp-studio/client-contract";

const DEFAULT_OUTPUT_LIMIT = 4 * 1024 * 1024;

export interface ProcessRunOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly outputLimit?: number;
  readonly readOnly?: boolean;
  readonly requestId?: CommandRequestId;
  readonly domain?: "git" | "github";
  readonly phase?: string;
  readonly allowedExitCodes?: ReadonlyArray<number>;
}

export interface ProcessRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class HostProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    readonly kind: "exit" | "timeout" | "overflow" | "cancelled" = "exit",
  ) {
    super(message);
    this.name = "HostProcessError";
  }
}

function safeTail(value: string): string {
  return value.slice(-4_096).replace(/https?:\/\/[^\s/@]+@/giu, "https://[redacted]@").replace(/\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_]+\b/gu, "[redacted]");
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    killer.on("error", () => { /* best effort */ });
    killer.unref();
    return;
  }
  child.kill("SIGKILL");
}

export class HostProcessRunner {
  readonly #running = new Map<CommandRequestId, ChildProcessWithoutNullStreams>();
  readonly #pending = new Set<CommandRequestId>();
  readonly #cancelled = new Set<CommandRequestId>();
  readonly #listeners = new Set<(progress: OperationProgress) => void>();

  onProgress(listener: (progress: OperationProgress) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(progress: OperationProgress): void {
    for (const listener of [...this.#listeners]) {
      try { listener(progress); } catch { /* isolate listeners */ }
    }
  }

  track(requestId: CommandRequestId): void {
    this.#pending.add(requestId);
  }

  untrack(requestId: CommandRequestId): void {
    this.#pending.delete(requestId);
    this.#cancelled.delete(requestId);
  }

  assertNotCancelled(requestId: CommandRequestId): void {
    if (this.#cancelled.has(requestId)) {
      throw new HostProcessError("process cancelled", null, "", "", "cancelled");
    }
  }

  cancel(requestId: CommandRequestId): boolean {
    const child = this.#running.get(requestId);
    const known = child !== undefined || this.#pending.has(requestId);
    if (!known) return false;
    this.#cancelled.add(requestId);
    if (child !== undefined) killTree(child);
    return known;
  }

  cancelAll(): void {
    for (const requestId of this.#pending) this.#cancelled.add(requestId);
    for (const requestId of this.#running.keys()) this.#cancelled.add(requestId);
    for (const child of this.#running.values()) killTree(child);
  }

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    if (options.requestId !== undefined) this.assertNotCancelled(options.requestId);
    const outputLimit = options.outputLimit ?? DEFAULT_OUTPUT_LIMIT;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      LC_ALL: "C",
      LANG: "C",
      ...(options.readOnly === true ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
    };
    const child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    if (options.requestId !== undefined) {
      this.#running.set(options.requestId, child);
      this.emit({
        requestId: options.requestId,
        domain: options.domain ?? "git",
        phase: options.phase ?? "running",
        message: options.phase ?? "running",
      });
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    child.stdin.on("error", () => { /* early child exit can close stdin before end() */ });
    child.stdout.on("error", () => { /* close/error is handled by the child lifecycle */ });
    child.stderr.on("error", () => { /* close/error is handled by the child lifecycle */ });
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > outputLimit) { overflow = true; killTree(child); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > outputLimit) { overflow = true; killTree(child); return; }
      stderr.push(chunk);
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const completion = new Promise<ProcessRunResult>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => {
          const out = Buffer.concat(stdout).toString("utf8");
          const err = Buffer.concat(stderr).toString("utf8");
          const exitCode = code ?? -1;
          if (overflow) {
            reject(new HostProcessError("process output exceeded the safe limit", code, out, safeTail(err), "overflow"));
          } else if (options.requestId !== undefined && this.#cancelled.has(options.requestId)) {
            reject(new HostProcessError("process cancelled", code, out, safeTail(err), "cancelled"));
          } else if (timedOut) {
            reject(new HostProcessError("process timed out", code, out, safeTail(err), "timeout"));
          } else if (exitCode !== 0 && !options.allowedExitCodes?.includes(exitCode)) {
            reject(new HostProcessError(safeTail(err).trim() || `process exited with code ${exitCode}`, exitCode, out, safeTail(err)));
          } else {
            resolve({ stdout: out, stderr: err, exitCode });
          }
        });
    });
    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin, "utf8");
    try {
      return await completion;
    } finally {
      clearTimeout(timer);
      if (options.requestId !== undefined) this.#running.delete(options.requestId);
    }
  }
}

/** FIFO write serialization keyed by the canonical Git common directory. */
export class GitWriteQueue {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const normalized = process.platform === "win32" ? key.toLowerCase() : key;
    const previous = this.#tails.get(normalized) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => current);
    this.#tails.set(normalized, tail);
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      release();
      if (this.#tails.get(normalized) === tail) this.#tails.delete(normalized);
    }
  }
}
