import { truncateUtf8 } from "@omp-studio/studio-protocol";

const MAX_CHUNKS = 1024;
const PAGE_UNITS = 8192;
const loneSurrogates = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Head-bounded UTF-8 text. Only new input is scanned on the append path. */
export class ReplayTextBuffer {
  #chunks: string[] = [];
  #materialized: string | undefined;
  #lastUnit = 0;
  #loneCount = 0;
  byteLength = 0;
  /** JSON string payload size, excluding the two quotes. */
  jsonBytes = 0;
  constructor(readonly maxBytes: number) {}

  get chunkCount(): number { return this.#chunks.length; }

  replace(text: string): boolean {
    this.clear();
    return this.append(text);
  }

  append(text: string): boolean {
    if (text.length === 0) return false;
    const first = text.charCodeAt(0);
    const pair = this.#lastUnit >= 0xd800 && this.#lastUnit <= 0xdbff && first >= 0xdc00 && first <= 0xdfff;
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.byteLength + bytes - (pair ? 2 : 0) > this.maxBytes) {
      if (this.#loneCount === 0) {
        const tail = truncateUtf8(text, this.maxBytes - this.byteLength);
        this.#add(tail.text);
        return true;
      }
      // At the boundary preserve truncateUtf8's normalization of lone UTF-16
      // surrogates exactly. This exceptional operation scans the prefix once.
      const bounded = truncateUtf8(this.materialize() + text, this.maxBytes);
      this.clear();
      this.#add(bounded.text);
      return bounded.truncated;
    }
    this.#add(text, bytes, pair);
    return false;
  }

  #add(text: string, bytes = Buffer.byteLength(text, "utf8"), pair = false): void {
    if (text.length === 0) return;
    this.byteLength += bytes - (pair ? 2 : 0);
    this.jsonBytes += Buffer.byteLength(JSON.stringify(text), "utf8") - 2 - (pair ? 8 : 0);
    this.#loneCount += (text.match(loneSurrogates)?.length ?? 0) - (pair ? 2 : 0);
    this.#lastUnit = text.charCodeAt(text.length - 1);
    this.#chunks.push(text);
    this.#materialized = undefined;
    if (this.#chunks.length > MAX_CHUNKS) {
      const value = this.materialize();
      this.#chunks = [];
      for (let offset = 0; offset < value.length; offset += PAGE_UNITS) {
        this.#chunks.push(value.slice(offset, offset + PAGE_UNITS));
      }
    }
  }

  materialize(): string {
    return this.#materialized ??= this.#chunks.join("");
  }

  clear(): void {
    this.#chunks = [];
    this.#materialized = undefined;
    this.#lastUnit = 0;
    this.#loneCount = 0;
    this.byteLength = 0;
    this.jsonBytes = 0;
  }
}
