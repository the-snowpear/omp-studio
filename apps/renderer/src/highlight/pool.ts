import { RenderCache, renderBytes } from "../conversation/renderCache";
import { HIGHLIGHT_MAX_UNITS, validHighlightRequest, validateTokens, type HighlightRequest, type HighlightToken } from "./protocol";

export type HighlightResult = { ok: true; tokens: HighlightToken[] } | { ok: false; reason: string };
export interface HighlightWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(request: HighlightRequest): void;
  terminate(): void;
}
type Subscriber = { priority: () => "visible" | "overscan" | "none"; result: (result: HighlightResult) => void };
type Job = { key: string; request: HighlightRequest; bytes: number; subscribers: Set<Subscriber>; retries: number };
type Slot = { worker: HighlightWorkerPort; job?: Job; timeout?: ReturnType<typeof setTimeout> };
export class HighlightPool {
  readonly #cache = new RenderCache<HighlightToken[]>(128, 8 * 1024 * 1024);
  readonly #jobs = new Map<string, Job>();
  readonly #queue: Job[] = [];
  readonly #workers: Slot[] = [];
  readonly #slotListeners = new Set<() => void>();
  readonly #size: number;
  #queueBytes = 0;
  #nextId = 0;
  #started = 0;
  #timeouts = 0;
  #crashes = 0;
  #disabled = false;
  #disposed = false;
  #idle: ReturnType<typeof setTimeout> | undefined;
  #notifyPending = false;
  constructor(readonly options: { createWorker: () => HighlightWorkerPort; cores?: number }) {
    const cores = options.cores;
    this.#size = cores !== undefined && Number.isFinite(cores) && cores > 0 ? Math.max(1, Math.min(2, Math.floor(cores / 2))) : 1;
  }
  onSlot(callback: () => void): () => void { this.#slotListeners.add(callback); return () => { this.#slotListeners.delete(callback); }; }
  request(language: string, code: string, subscriber: Subscriber): { status: "accepted" | "full" | "rejected"; cancel: () => void } {
    const empty = () => {};
    if (this.#disposed || this.#disabled || code.length > HIGHLIGHT_MAX_UNITS || subscriber.priority() === "none"
      || !validHighlightRequest({ version: 1, jobId: 1, language, code })) return { status: "rejected", cancel: empty };
    const key = language + "\u0000" + code;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      let active = true;
      queueMicrotask(() => { if (active && !this.#disposed && subscriber.priority() !== "none") subscriber.result({ ok: true, tokens: cached }); });
      return { status: "accepted", cancel: () => { active = false; } };
    }
    let job = this.#jobs.get(key);
    if (job === undefined) {
      const bytes = renderBytes(code);
      if (this.#queue.length >= 32 || this.#queueBytes + bytes > 2 * 1024 * 1024) return { status: "full", cancel: empty };
      job = { key, request: { version: 1, jobId: ++this.#nextId, language, code }, bytes, subscribers: new Set(), retries: 0 };
      this.#jobs.set(key, job); this.#queue.push(job); this.#queueBytes += bytes;
    }
    job.subscribers.add(subscriber);
    this.#cancelIdle(); this.#pump();
    return { status: "accepted", cancel: () => {
      job.subscribers.delete(subscriber);
      if (job.subscribers.size === 0) {
        const index = this.#queue.indexOf(job);
        if (index !== -1) { this.#queue.splice(index, 1); this.#queueBytes -= job.bytes; this.#jobs.delete(key); this.#notify(); }
      }
      this.#scheduleIdle();
    } };
  }
  #notify(): void {
    if (this.#notifyPending || this.#disposed) return;
    this.#notifyPending = true;
    queueMicrotask(() => { this.#notifyPending = false; if (!this.#disposed) for (const callback of [...this.#slotListeners]) callback(); });
  }
  #priority(job: Job): number {
    let priority = 0;
    for (const subscriber of job.subscribers) {
      const value = subscriber.priority();
      if (value === "none") job.subscribers.delete(subscriber);
      else priority = Math.max(priority, value === "visible" ? 2 : 1);
    }
    return priority;
  }
  #pump(): void {
    if (this.#disposed || this.#disabled) return;
    while (this.#queue.length > 0) {
      let index = -1, priority = 0;
      for (let i = this.#queue.length - 1; i >= 0; i--) {
        const next = this.#priority(this.#queue[i]!);
        if (next === 0) { const [job] = this.#queue.splice(i, 1); this.#queueBytes -= job!.bytes; this.#jobs.delete(job!.key); if (index >= i) index--; continue; }
        if (next >= priority) { index = i; priority = next; }
      }
      if (index === -1) break;
      let slot = this.#workers.find((worker) => worker.job === undefined);
      if (slot === undefined) {
        if (this.#workers.length >= this.#size) break;
        try {
          slot = { worker: this.options.createWorker() }; this.#started++;
          this.#workers.push(slot);
          const owner = slot;
          owner.worker.onmessage = (event) => this.#message(owner, event.data);
          owner.worker.onerror = () => this.#crash(owner);
          owner.worker.onmessageerror = () => this.#crash(owner);
        } catch { this.#disable("worker-start-failed"); return; }
      }
      const [job] = this.#queue.splice(index, 1);
      this.#queueBytes -= job!.bytes;
      slot.job = job!;
      const owner = slot;
      owner.timeout = setTimeout(() => {
        if (owner.job !== job) return;
        this.#timeouts++;
        this.#removeWorker(owner);
        this.#finish(job!, { ok: false, reason: "timeout" });
        this.#pump();
      }, 5000);
      try { owner.worker.postMessage(job!.request); }
      catch { this.#crash(owner); }
      this.#notify();
    }
    this.#scheduleIdle();
  }
  #message(slot: Slot, value: unknown): void {
    const job = slot.job;
    if (job === undefined || !this.#workers.includes(slot) || this.#disposed || value === null || typeof value !== "object") return;
    const response = value as Record<string, unknown>;
    if (response.jobId !== job.request.jobId) return; // late, duplicate or out of order
    clearTimeout(slot.timeout); delete slot.timeout; delete slot.job;
    let result: HighlightResult;
    if (response.version === 1 && response.ok === true && Object.keys(response).length === 4 && validateTokens(response.tokens, job.request.code)) {
      result = { ok: true, tokens: response.tokens };
      if (job.subscribers.size > 0) this.#cache.put(job.key, result.tokens, renderBytes(JSON.stringify(result.tokens)));
    } else result = { ok: false, reason: "worker-result-rejected" };
    this.#finish(job, result); this.#pump();
  }
  #finish(job: Job, result: HighlightResult): void {
    this.#jobs.delete(job.key);
    for (const subscriber of job.subscribers) if (subscriber.priority() !== "none") subscriber.result(result);
    job.subscribers.clear(); this.#notify();
  }
  #crash(slot: Slot): void {
    const job = slot.job;
    if (!this.#workers.includes(slot)) return;
    this.#crashes++; this.#removeWorker(slot);
    if (this.#crashes >= 2) {
      if (job !== undefined) this.#finish(job, { ok: false, reason: "worker-crash" });
      this.#disable("worker-crash"); return;
    }
    if (job !== undefined && job.retries++ === 0 && job.subscribers.size > 0
      && this.#queue.length < 32 && this.#queueBytes + job.bytes <= 2 * 1024 * 1024) {
      // Retry uses a new ID so a late message from the old Worker cannot win.
      job.request = { ...job.request, jobId: ++this.#nextId };
      this.#queue.unshift(job); this.#queueBytes += job.bytes;
    } else if (job !== undefined) this.#finish(job, { ok: false, reason: "worker-crash" });
    this.#pump();
  }
  #removeWorker(slot: Slot): void {
    clearTimeout(slot.timeout);
    delete slot.timeout; delete slot.job;
    slot.worker.onmessage = null; slot.worker.onerror = null; slot.worker.onmessageerror = null;
    slot.worker.terminate();
    const index = this.#workers.indexOf(slot); if (index !== -1) this.#workers.splice(index, 1);
  }
  #disable(reason: string): void {
    this.#disabled = true;
    for (const slot of [...this.#workers]) this.#removeWorker(slot);
    const jobs = [...this.#jobs.values()]; this.#queue.length = 0; this.#queueBytes = 0;
    for (const job of jobs) this.#finish(job, { ok: false, reason });
    this.#cancelIdle();
  }
  #cancelIdle(): void { if (this.#idle !== undefined) clearTimeout(this.#idle); this.#idle = undefined; }
  #scheduleIdle(): void {
    if (this.#disposed || this.#idle !== undefined || this.#workers.length === 0 || this.#queue.length > 0 || this.#workers.some((slot) => slot.job !== undefined)) return;
    this.#idle = setTimeout(() => { this.#idle = undefined; for (const slot of [...this.#workers]) this.#removeWorker(slot); }, 30_000);
  }
  getDiagnostics(): Readonly<Record<string, number>> {
    return { workers: this.#workers.length, started: this.#started, running: this.#workers.filter((slot) => slot.job !== undefined).length,
      queued: this.#queue.length, queueBytes: this.#queueBytes, cacheEntries: this.#cache.size, cacheBytes: this.#cache.bytes,
      timeouts: this.#timeouts, crashes: this.#crashes, slotListeners: this.#slotListeners.size };
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#cancelIdle();
    for (const slot of [...this.#workers]) this.#removeWorker(slot);
    for (const job of this.#jobs.values()) job.subscribers.clear();
    this.#queue.length = 0; this.#queueBytes = 0; this.#jobs.clear(); this.#cache.clear(); this.#slotListeners.clear();
  }
}
