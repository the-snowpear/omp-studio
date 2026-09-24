const encoder = new TextEncoder();
export const renderBytes = (value: string): number => encoder.encode(value).byteLength;

/** Logical UTF-8 budgets, not measurements of retained V8 heap. */
export class RenderCache<T> {
  readonly #entries = new Map<string, { value: T; bytes: number }>();
  #bytes = 0;
  constructor(readonly maxEntries: number, readonly maxBytes: number) {}
  get(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    this.#entries.delete(key); this.#entries.set(key, entry);
    return entry.value;
  }
  put(key: string, value: T, valueBytes: number): void {
    const bytes = renderBytes(key) + valueBytes;
    if (bytes > this.maxBytes) return;
    const previous = this.#entries.get(key);
    if (previous !== undefined) { this.#bytes -= previous.bytes; this.#entries.delete(key); }
    while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
      const first = this.#entries.entries().next().value;
      if (first === undefined) break;
      this.#bytes -= first[1].bytes; this.#entries.delete(first[0]);
    }
    this.#entries.set(key, { value, bytes }); this.#bytes += bytes;
  }
  get size(): number { return this.#entries.size; }
  get bytes(): number { return this.#bytes; }
  clear(): void { this.#entries.clear(); this.#bytes = 0; }
}
