export interface TmuxBlock { time: number; number: number; flags: number; ok: boolean; lines: Buffer[] }
export interface TmuxParserEvents {
  onBlock(block: TmuxBlock): void;
  onNotification(name: string, args: Buffer): void;
  onPaneOutput(paneId: string, bytes: Uint8Array): void;
  onNoise?(line: Buffer): void;
  onProtocolError?(kind: string): void;
}
export const TMUX_MAX_LINE_BYTES = 4 * 1024 * 1024;

export function decodeTmuxBytes(value: Buffer): Buffer {
  const output = Buffer.allocUnsafe(value.length);
  let length = 0;
  for (let at = 0; at < value.length; at++) {
    if (value[at] === 92 && at + 3 < value.length && value.subarray(at + 1, at + 4).every(byte => byte >= 48 && byte <= 55)) {
      output[length++] = ((value[++at]! - 48) << 6) | ((value[++at]! - 48) << 3) | (value[++at]! - 48);
    } else output[length++] = value[at]!;
  }
  return output.subarray(0, length);
}

/** Byte-oriented: output notifications may end halfway through a UTF-8 code point. */
export class TmuxControlParser {
  #parts: Buffer[] = [];
  #length = 0;
  #discard = false;
  #started = false;
  #block: Omit<TmuxBlock, "ok"> | undefined;
  constructor(readonly events: TmuxParserEvents) {}
  push(chunk: Buffer): void {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (!this.#discard) {
        this.#parts.push(part); this.#length += part.length;
        if (this.#length > TMUX_MAX_LINE_BYTES) {
          this.#discard = true; this.#parts = []; this.#length = 0;
          this.events.onProtocolError?.("line-too-long");
        }
      }
      if (end < 0) break;
      if (!this.#discard) {
        let line = Buffer.concat(this.#parts, this.#length);
        if (line.at(-1) === 13) line = line.subarray(0, -1);
        this.#line(line);
      }
      this.#parts = []; this.#length = 0; this.#discard = false; start = end + 1;
    }
  }
  #line(line: Buffer): void {
    const marker = /^%(begin|end|error) (\d+) (\d+) (\d+)$/.exec(line.subarray(0, 100).toString("ascii"));
    if (this.#block) {
      if (marker && marker[1] !== "begin" && Number(marker[2]) === this.#block.time && Number(marker[3]) === this.#block.number && Number(marker[4]) === this.#block.flags) {
        const block = this.#block; this.#block = undefined;
        this.events.onBlock({ ...block, ok: marker[1] === "end" });
      } else this.#block.lines.push(line);
      return;
    }
    if (marker?.[1] === "begin") { this.#started = true; this.#block = { time: Number(marker[2]), number: Number(marker[3]), flags: Number(marker[4]), lines: [] }; return; }
    if (!this.#started) { this.events.onNoise?.(line); return; }
    const space = line.indexOf(32);
    const name = line.subarray(0, space < 0 ? line.length : space).toString("ascii");
    const args = space < 0 ? Buffer.alloc(0) : line.subarray(space + 1);
    if (name === "%output" || name === "%extended-output") {
      const paneEnd = args.indexOf(32);
      const dataStart = name === "%output" ? paneEnd + 1 : args.indexOf(" : ") + 3;
      if (paneEnd < 0 || dataStart < 3) { this.events.onProtocolError?.("output-header"); return; }
      this.events.onPaneOutput(args.subarray(0, paneEnd).toString("ascii"), decodeTmuxBytes(args.subarray(dataStart)));
    } else this.events.onNotification(name, args);
  }
}
