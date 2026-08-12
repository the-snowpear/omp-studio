import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { SessionBinding } from "@omp-studio/studio-protocol";
import type { RuntimeProcessPort } from "./runtime-actor.js";

export interface RuntimeProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface RuntimeContainmentPort {
  attach?(process: ChildProcess): Promise<void> | void;
  requestStop(process: ChildProcess): Promise<void> | void;
  forceStop(process: ChildProcess): Promise<void> | void;
  release?(process: ChildProcess): Promise<void> | void;
}

export interface NodeRuntimeProcessPortOptions {
  executable: string;
  cwd: string;
  args(binding: SessionBinding): readonly string[];
  containment: RuntimeContainmentPort;
  waitUntilReady?: (process: ChildProcess, binding: SessionBinding) => Promise<void>;
  requestGracefulShutdown?: (process: ChildProcess, binding: SessionBinding) => Promise<void>;
  spawnOptions?: Omit<SpawnOptions, "cwd" | "env">;
  env?: NodeJS.ProcessEnv;
  stopTimeoutMs?: number;
  forceStopTimeoutMs?: number;
  readyTimeoutMs?: number;
  spawnProcess?: typeof spawn;
}

export class NodeRuntimeProcessPort implements RuntimeProcessPort {
  #process: ChildProcess | undefined;
  #exitPromise: Promise<RuntimeProcessExit> | undefined;
  #ready = false;
  #binding: SessionBinding | undefined;
  readonly #exitListeners = new Set<() => void>();

  constructor(private readonly options: NodeRuntimeProcessPortOptions) {
    if (options.executable.length === 0 || options.cwd.length === 0) {
      throw new TypeError("Runtime executable and cwd are required");
    }
  }

  async start(binding: SessionBinding): Promise<void> {
    if (this.#process !== undefined) throw new Error("Runtime process is already active");
    const spawnProcess = this.options.spawnProcess ?? spawn;
    const child = spawnProcess(this.options.executable, [...this.options.args(binding)], {
      ...this.options.spawnOptions,
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      windowsHide: this.options.spawnOptions?.windowsHide ?? true,
    });
    this.#process = child;
    this.#ready = false;
    let exitResult: RuntimeProcessExit | undefined;
    const exit = deferred<RuntimeProcessExit>();
    this.#exitPromise = exit.promise;
    child.once("exit", (code, signal) => {
      exitResult = { code, signal };
      exit.resolve(exitResult);
      if (this.#process === child) this.#process = undefined;
      if (this.#ready) {
        this.#ready = false;
        for (const listener of this.#exitListeners) listener();
      }
      void this.options.containment.release?.(child);
    });

    const spawned = deferred<void>();
    child.once("spawn", spawned.resolve);
    child.once("error", spawned.reject);
    try {
      await Promise.race([spawned.promise, exit.promise.then((result) => Promise.reject(processExitError(result)))]);
      await this.options.containment.attach?.(child);
      if (this.options.waitUntilReady !== undefined) {
        await Promise.race([
          withTimeout(
            this.options.waitUntilReady(child, binding),
            this.options.readyTimeoutMs ?? 10_000,
            "Runtime process readiness timed out",
          ),
          exit.promise.then((result) => Promise.reject(processExitError(result))),
        ]);
      }
      if (exitResult !== undefined) throw processExitError(exitResult);
      this.#ready = true;
      this.#binding = structuredClone(binding);
    } catch (error) {
      let cleanupError: unknown;
      if (this.#process === child) {
        try {
          await this.options.containment.forceStop(child);
          await settlesWithin(exit.promise, this.options.forceStopTimeoutMs ?? 5_000);
        } catch (forceError) {
          cleanupError = forceError;
        }
        if (this.#process === child) this.#process = undefined;
      }
      if (cleanupError !== undefined) {
        throw new AggregateError([error, cleanupError], "Runtime startup failed and containment cleanup also failed");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const child = this.#process;
    const exit = this.#exitPromise;
    if (child === undefined || exit === undefined) return;
    if (this.options.requestGracefulShutdown !== undefined && this.#binding !== undefined) {
      try {
        await withTimeout(
          this.options.requestGracefulShutdown(child, structuredClone(this.#binding)),
          this.options.stopTimeoutMs ?? 5_000,
          "Runtime graceful shutdown timed out",
        );
        if (await settlesWithin(exit, this.options.stopTimeoutMs ?? 5_000)) return;
      } catch {
        // Fall through to containment; the old owner must still be proven gone.
      }
    }
    await this.options.containment.requestStop(child);
    if (await settlesWithin(exit, this.options.stopTimeoutMs ?? 5_000)) return;
    await this.options.containment.forceStop(child);
    if (!(await settlesWithin(exit, this.options.forceStopTimeoutMs ?? 5_000))) {
      throw new Error("Runtime process did not exit after forced containment stop");
    }
  }

  onExit(listener: () => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }
}

function processExitError(result: RuntimeProcessExit): Error {
  return new Error(`Runtime process exited before ready (code=${result.code}, signal=${result.signal})`);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = deferred<boolean>();
  const timer = setTimeout(() => timeout.resolve(false), timeoutMs);
  try {
    return await Promise.race([promise.then(() => true), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
