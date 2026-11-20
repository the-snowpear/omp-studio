import { open, type FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { EvaluationResultPage } from "@omp-studio/studio-protocol";

type Row = EvaluationResultPage["rows"][number];
const MAX_ROWS = (2 * 1024 * 1024) / (2 * Float64Array.BYTES_PER_ELEMENT);

function fileVersion(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function buildOffsets(file: FileHandle, size: number): Promise<Float64Array | undefined> {
  if (!size) return new Float64Array();
  const positions = new Map<string, number>();
  const offsets: number[] = [];
  function addRow(line: Buffer, start: number): boolean {
    if (line.at(-1) === 13) line = line.subarray(0, -1);
    if (!line.length) return true;
    const row = JSON.parse(line.toString("utf8")) as Row;
    let index = positions.get(row.key);
    if (index === undefined) {
      if (positions.size === MAX_ROWS) return false;
      index = offsets.length;
      positions.set(row.key, index);
    }
    offsets[index] = start;
    offsets[index + 1] = line.length;
    return true;
  }

  const stream = file.createReadStream({ autoClose: false, start: 0, end: size - 1 });
  let fileOffset = 0;
  let lineOffset = 0;
  let fragments: Buffer[] = [];
  // Use raw byte lengths for seek positions. Retain chunks of a split line
  // until its newline instead of repeatedly copying a large row.
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const tail = chunk.subarray(start, end);
        const line = fragments.length ? Buffer.concat([...fragments, tail]) : tail;
        if (!addRow(line, lineOffset)) return undefined;
        start = end + 1;
        lineOffset = fileOffset + start;
        fragments = [];
      }
      if (start < chunk.length) fragments.push(chunk.subarray(start));
      fileOffset += chunk.length;
    }
    if (fragments.length && !addRow(Buffer.concat(fragments), lineOffset)) return undefined;
  } catch (error) {
    // The stream reader remains authoritative for legacy delimiters and parse errors.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return new Float64Array(offsets);
}

type CachedOffsets = {
  path: string;
  version: string;
  building: boolean;
  offsets: Promise<Float64Array | undefined>;
};

/** Keep only the most recently used completed report's offsets. */
export class EvaluationRowIndex {
  #cached: CachedOffsets | undefined;

  async page(path: string, offset: number, limit: number): Promise<EvaluationResultPage | undefined> {
    const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!file) return undefined;
    try {
      const stat = await file.stat({ bigint: true });
      const version = fileVersion(stat);
      let cached = this.#cached;
      if (cached?.path !== path || cached.version !== version) {
        if (cached?.building) return undefined;
        const entry: CachedOffsets = {
          path, version, building: true,
          offsets: buildOffsets(file, Number(stat.size)),
        };
        this.#cached = cached = entry;
        try {
          await entry.offsets;
        } catch (error) {
          this.#cached = undefined;
          throw error;
        } finally {
          entry.building = false;
        }
      }
      const locations = await cached.offsets;
      if (!locations) return undefined;
      const total = locations.length / 2;
      const rows: Row[] = [];
      const end = Math.min(total, offset + limit);
      for (let index = offset; index < end; index++) {
        const start = locations[index * 2]!;
        const length = locations[index * 2 + 1]!;
        const bytes = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(bytes, 0, length, start);
        if (bytesRead !== length) return undefined;
        rows.push(JSON.parse(bytes.toString("utf8")) as Row);
      }
      if (fileVersion(await file.stat({ bigint: true })) !== version) return undefined;
      return { rows, offset, nextOffset: offset + rows.length, total };
    } catch (error) {
      // A writer can replace the bytes at a cached offset during a page read.
      if (error instanceof SyntaxError) return undefined;
      throw error;
    } finally {
      await file.close();
    }
  }
}
