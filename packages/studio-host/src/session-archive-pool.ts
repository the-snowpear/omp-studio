import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { StudioSessionArchiveReader } from "./session-archive-reader.js";

export type SessionArchiveReaderPort = Pick<StudioSessionArchiveReader,
  "readPage" | "prefetch" | "readRevision" | "readCompaction" | "listPersistedAgents" | "createProbeCopy" | "readTimeTravel">;
export type ArchiveWorkerMethod = keyof SessionArchiveReaderPort;
// Remote bundling supplies a content-addressed sibling; local tsc output uses .js.
declare const __OMP_ARCHIVE_WORKER_FILE__: string | undefined;

/** One lazy Worker per Host. Full parsed archives never cross back to Main. */
export class SessionArchiveWorkerPool {
  #worker: Worker | undefined;
  #next = 0;
  #closed = false;
  readonly #secret = randomBytes(32);
  readonly #pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; release(): void }>();
  #stats: Record<string, number> = { entries: 0, rawBytes: 0, estimatedBytes: 0, workerHeapBytes: 0 };
  constructor(readonly options: { sessionsRoot?: string; archiveRoot?: string } = {}) {}
  diagnostics(): Readonly<Record<string, number>> { return { ...this.#stats, workers: this.#worker ? 1 : 0, inFlight: this.#pending.size }; }
  reader(cwd: string): SessionArchiveReaderPort {
    return {
      readPage: (input, signal) => this.#request(cwd, "readPage", [input], signal),
      prefetch: sessionId => this.#request(cwd, "prefetch", [sessionId]),
      readRevision: sessionId => this.#request(cwd, "readRevision", [sessionId]),
      readCompaction: sessionId => this.#request(cwd, "readCompaction", [sessionId]),
      listPersistedAgents: sessionId => this.#request(cwd, "listPersistedAgents", [sessionId]),
      createProbeCopy: (sessionId, directory) => this.#request(cwd, "createProbeCopy", [sessionId, directory]),
      readTimeTravel: input => this.#request(cwd, "readTimeTravel", [input]),
    };
  }
  #start(): Worker {
    if (this.#worker) return this.#worker;
    const entry = typeof __OMP_ARCHIVE_WORKER_FILE__ === "string" ? __OMP_ARCHIVE_WORKER_FILE__ : "./session-archive-worker.js";
    const worker = new Worker(new URL(entry, import.meta.url), { workerData: { ...this.options, cursorSecret: this.#secret }, name: "studio-archive" });
    this.#worker = worker;
    worker.on("message", (reply: { id: number; value?: unknown; error?: { name: string; message: string; code?: string }; stats: Record<string, number> }) => {
      this.#stats = reply.stats;
      const pending = this.#pending.get(reply.id);
      if (!pending) return;
      this.#pending.delete(reply.id); pending.release();
      if (reply.error) pending.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name, ...(reply.error.code ? { code: reply.error.code } : {}) }));
      else pending.resolve(reply.value);
      if (!this.#pending.size) worker.unref();
    });
    const failed = (error: Error) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      for (const pending of this.#pending.values()) { pending.release(); pending.reject(error); }
      this.#pending.clear(); this.#stats = { entries: 0, rawBytes: 0, estimatedBytes: 0, workerHeapBytes: 0 };
    };
    worker.on("error", failed);
    worker.on("exit", code => failed(new Error(`Archive worker exited (${code})`)));
    return worker;
  }
  #request<T>(cwd: string, method: ArchiveWorkerMethod, args: unknown[], signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Archive worker pool is closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const worker = this.#start(), id = ++this.#next;
    worker.ref();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(id); worker.postMessage({ abort: id }); reject(signal?.reason);
        if (!this.#pending.size) worker.unref();
      };
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, release: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
      worker.postMessage({ id, cwd, method, args });
    });
  }
  async dispose(): Promise<void> {
    this.#closed = true;
    const worker = this.#worker;
    if (worker) await worker.terminate();
  }
}
