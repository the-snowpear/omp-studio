import { tailUtf8, utf8ByteLength } from "@omp-studio/client-contract";

// In Unicode mode this range matches lone surrogates, not supplementary code points.
// At a truncation boundary TextDecoder normalizes them and strips a leading BOM.
const needsDecoder = /[\uD800-\uDFFF\uFEFF]/u;

/** The head is consumed from the left while new output accumulates on the right.
 * Published strings stay immutable. Each ordinary code point is counted on entry
 * and visited at most once more when it leaves the byte window. */
export class ToolOutputTail {
  private head = "";
  private start = 0;
  private appended = "";
  private bytes = 0;
  private needsDecoder = false;

  constructor(private readonly limit: number) {}

  get text(): string { return this.head.slice(this.start) + this.appended; }

  replace(value: string): boolean {
    const { text, truncated } = tailUtf8(value, this.limit);
    this.head = text;
    this.start = 0;
    this.appended = "";
    this.bytes = utf8ByteLength(text);
    this.needsDecoder = needsDecoder.test(text);
    return truncated;
  }

  append(value: string): boolean {
    if (!value) return false;
    if (this.needsDecoder || needsDecoder.test(value)) return this.replace(this.text + value);
    const incoming = utf8ByteLength(value);
    if (incoming > this.limit) return this.replace(value);
    this.appended += value;
    this.bytes += incoming;
    if (this.bytes <= this.limit) return false;
    while (this.bytes > this.limit) {
      if (this.start === this.head.length) {
        this.head = this.appended;
        this.start = 0;
        this.appended = "";
      }
      const code = this.head.codePointAt(this.start)!;
      this.start += code > 0xffff ? 2 : 1;
      this.bytes -= code < 0x80 ? 1 : code < 0x800 ? 2 : code <= 0xffff ? 3 : 4;
    }
    return true;
  }
}
