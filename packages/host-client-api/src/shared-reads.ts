/** Host-owned display data only. Never cache commands, capabilities or Runtime state. */
export class SharedProjectReads {
  #values = new Map<string, { value: unknown; bytes: number; expires: number }>();
  #pending = new Map<string, Promise<unknown>>();
  #epoch = 0;
  #bytes = 0;
  async read<T>(key: string, run: () => Promise<T>, ttl = 30_000): Promise<T> {
    const cached = this.#values.get(key);
    if (cached && cached.expires > Date.now()) {
      this.#values.delete(key); this.#values.set(key, cached); return cached.value as T;
    }
    const pending = this.#pending.get(key);
    if (pending) return pending as Promise<T>;
    const epoch = this.#epoch;
    const task = Promise.resolve().then(run).then(value => {
      if (epoch !== this.#epoch) return value;
      const bytes = JSON.stringify(value).length * 2;
      this.#bytes -= this.#values.get(key)?.bytes ?? 0; this.#values.delete(key);
      if (bytes <= 16 * 1024 * 1024) {
        this.#values.set(key, { value, bytes, expires: Date.now() + ttl }); this.#bytes += bytes;
      }
      while (this.#bytes > 16 * 1024 * 1024 || this.#values.size > 128) {
        const [oldest, entry] = this.#values.entries().next().value!;
        this.#values.delete(oldest); this.#bytes -= entry.bytes;
      }
      return value;
    }).finally(() => { if (this.#pending.get(key) === task) this.#pending.delete(key); });
    this.#pending.set(key, task);
    return task;
  }
  invalidate(): void { this.#epoch++; this.#values.clear(); this.#pending.clear(); this.#bytes = 0; }
  diagnostics() { return { entries: this.#values.size, estimatedBytes: this.#bytes, inFlight: this.#pending.size }; }
}

type Flight<T> = { controller: AbortController; consumers: Set<object>; promise: Promise<T> };

/** Serializes expensive archive probes and owns copy → process → cleanup as one flight.
 * A view closing releases just its consumer, never another view's request. */
export class SharedArchiveTelemetry<T> {
  #flights = new Map<string, Flight<T>>();
  #cache = new Map<string, { value: T; expires: number }>();
  #tail: Promise<unknown> = Promise.resolve();
  read(key: string, signal: AbortSignal, run: (signal: AbortSignal) => Promise<T>, refresh = false): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const cached = this.#cache.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
    let flight = this.#flights.get(key);
    if (!flight || flight.controller.signal.aborted) {
      const controller = new AbortController();
      const created: Flight<T> = { controller, consumers: new Set(), promise: Promise.resolve(undefined as T) };
      created.promise = this.#tail.catch(() => {}).then(() => {
        controller.signal.throwIfAborted(); return run(controller.signal);
      }).then(value => {
        if (value !== undefined && !controller.signal.aborted) {
          this.#cache.delete(key); this.#cache.set(key, { value, expires: Date.now() + 60_000 });
          while (this.#cache.size > 16) this.#cache.delete(this.#cache.keys().next().value!);
        }
        return value;
      }).finally(() => { if (this.#flights.get(key) === created) this.#flights.delete(key); });
      this.#tail = created.promise.catch(() => {});
      this.#flights.set(key, created); flight = created;
    }
    const owner = {}, current = flight;
    current.consumers.add(owner);
    return new Promise<T>((resolve, reject) => {
      const release = () => {
        current.consumers.delete(owner); signal.removeEventListener("abort", cancel);
        if (current.consumers.size === 0) current.controller.abort();
      };
      const cancel = () => { release(); reject(signal.reason); };
      signal.addEventListener("abort", cancel, { once: true });
      current.promise.then(resolve, reject).finally(release);
    });
  }
  dispose(): void { for (const flight of this.#flights.values()) flight.controller.abort(); this.#cache.clear(); }
  diagnostics() { return { entries: this.#cache.size, inFlight: this.#flights.size }; }
}
