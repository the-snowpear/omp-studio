interface Lease {
  start(): void;
  cancelled: boolean;
}
/** Bounds simultaneous parsers and retained GPU previews across the transcript and artifact library. */
export class GraphicLeasePool {
  readonly #active = new Set<Lease>();
  readonly #waiting: Lease[] = [];
  constructor(
    readonly maximum = 2,
    readonly queued = 16,
  ) {}
  request(start: () => void): () => void {
    if (this.#waiting.length >= this.queued)
      throw new Error(
        "Too many visible graphics. Close a preview to continue.",
      );
    const lease: Lease = { start, cancelled: false };
    this.#waiting.push(lease);
    this.#pump();
    return () => {
      if (lease.cancelled) return;
      lease.cancelled = true;
      this.#active.delete(lease);
      const index = this.#waiting.indexOf(lease);
      if (index >= 0) this.#waiting.splice(index, 1);
      this.#pump();
    };
  }
  #pump(): void {
    while (this.#active.size < this.maximum && this.#waiting.length) {
      const lease = this.#waiting.shift()!;
      if (lease.cancelled) continue;
      this.#active.add(lease);
      queueMicrotask(() => {
        if (!lease.cancelled) lease.start();
      });
    }
  }
}
export const graphicLeasePool = new GraphicLeasePool();
