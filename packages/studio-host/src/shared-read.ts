/** A read belongs to its consumers. Releasing a view must not abort other views. */
export class SharedRead<T> {
  readonly controller = new AbortController();
  readonly promise: Promise<T>;
  #consumers = new Set<object>();
  constructor(run: (signal: AbortSignal) => Promise<T>) {
    this.promise = Promise.resolve().then(() => { this.controller.signal.throwIfAborted(); return run(this.controller.signal); });
  }
  join(signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const consumer = {}; this.#consumers.add(consumer);
    return new Promise<T>((resolve, reject) => {
      const release = () => {
        this.#consumers.delete(consumer); signal?.removeEventListener("abort", abort);
        if (this.#consumers.size === 0) this.controller.abort();
      };
      const abort = () => { release(); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      this.promise.then(resolve, reject).finally(release);
    });
  }
}
