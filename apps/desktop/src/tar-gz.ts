import { createReadStream } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { createGunzip } from "node:zlib";

export interface ExtractLimits {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  readonly maxRatio?: number;
}

const DEFAULT_LIMITS: Required<ExtractLimits> = {
  maxEntries: 20_000,
  maxTotalBytes: 512 * 1024 * 1024, // 512 MB
  maxRatio: 200,
};

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const str = buf.subarray(offset, offset + length).toString("ascii").replace(/\0/g, "").trim();
  if (!/^[0-7]+$/.test(str)) throw new Error("Invalid tar octal field");
  const result = parseInt(str, 8);
  if (!Number.isSafeInteger(result)) throw new Error("Invalid tar size");
  return result;
}

function readNullTerminatedString(buf: Buffer, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(offset, end).toString("utf8");
}

export async function extractTarGz(
  archivePath: string,
  destination: string,
  limits?: ExtractLimits,
  signal?: AbortSignal,
): Promise<void> {
  const maxEntries = limits?.maxEntries ?? DEFAULT_LIMITS.maxEntries;
  const maxTotalBytes = limits?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes;
  const maxRatio = limits?.maxRatio ?? DEFAULT_LIMITS.maxRatio;

  const archiveStat = await stat(archivePath);
  const compressedSize = archiveStat.size;

  await mkdir(destination, { recursive: true });

  const gunzip = createGunzip();
  const readStream = createReadStream(archivePath);

  let entryCount = 0;
  let totalExtractedBytes = 0;
  let nextLongName: string | undefined;
  const stream = readStream.pipe(gunzip);
  readStream.on("error", (error) => gunzip.destroy(error));
  const iterator = stream[Symbol.asyncIterator]();
  let buffered: Buffer = Buffer.alloc(0);
  let inflated = 0;
  const read = async (size: number): Promise<Buffer> => {
    const pieces: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      signal?.throwIfAborted();
      if (buffered.length === 0) {
        const next = await iterator.next();
        if (next.done) break;
        buffered = next.value as Buffer;
        inflated += buffered.length;
        if (inflated > maxTotalBytes + maxEntries * 1024 + 1024) throw new Error("解压总量超过上限");
        if (inflated > compressedSize * maxRatio) throw new Error("解压压缩比异常");
      }
      const take = Math.min(remaining, buffered.length);
      pieces.push(buffered.subarray(0, take));
      buffered = buffered.subarray(take);
      remaining -= take;
    }
    return Buffer.concat(pieces, size - remaining);
  };
  const readRequired = async (size: number): Promise<Buffer> => {
    const bytes = await read(size);
    if (bytes.length !== size) throw new Error("Truncated tar archive");
    return bytes;
  };
  try {
    let ended = false;
    while (true) {
      const header = await read(512);
      if (header.length === 0) break;
      if (header.length !== 512) throw new Error("Truncated tar header");
      if (header.every((byte) => byte === 0)) { ended = true; continue; }
      if (ended) throw new Error("Unexpected tar data after end marker");
      if (++entryCount > maxEntries) throw new Error(`条目数超过上限 (${maxEntries})`);
      const checksum = parseOctal(header, 148, 8);
      const calculated = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
      if (checksum !== calculated) throw new Error("Invalid tar header checksum");
      const rawName = readNullTerminatedString(header, 0, 100);
      const size = parseOctal(header, 124, 12);
      const typeflagByte = header[156]!;
      const typeflag = String.fromCharCode(typeflagByte);
      const prefix = readNullTerminatedString(header, 345, 155);

      totalExtractedBytes += size;
      if (totalExtractedBytes > maxTotalBytes) throw new Error(`解压总量超过上限 (${maxTotalBytes} 字节)`);
      const padding = (512 - size % 512) % 512;

      // GNU long name extension
      if (typeflag === "L") {
        if (size > 256) throw new Error("路径名称过长（超过 255 字节）");
        const entryData = await readRequired(size);
        nextLongName = readNullTerminatedString(entryData, 0, entryData.length);
        await readRequired(padding);
        continue;
      }

      const entryName = nextLongName ?? (prefix.length > 0 ? `${prefix}/${rawName}` : rawName);
      nextLongName = undefined;

      // Security validations
      if (entryName.includes("\\")) {
        throw new Error(`非法路径格式（含反斜杠）: ${entryName}`);
      }
      if (Buffer.byteLength(entryName, "utf8") > 255) {
        throw new Error(`路径名称过长（超过 255 字节）: ${entryName}`);
      }
      if (entryName.split("/").some((seg) => seg === "..")) {
        throw new Error(`非法路径段（含 ..）: ${entryName}`);
      }
      if (!entryName || entryName.startsWith("/") || /[:\x00-\x1f<>"|?*]/.test(entryName) || entryName.split("/").some((part) => /[. ]$/.test(part) && part !== "." || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
        throw new Error("非法路径格式");
      }
      const resolved = resolve(destination, entryName);
      if (!isInside(destination, resolved)) {
        throw new Error(`目标路径越界: ${entryName}`);
      }

      // Check typeflag: only '0', '\0' (file) and '5' (dir) are allowed
      if (typeflag === "5") {
        if (size !== 0) throw new Error("Tar directory must not contain data");
        await mkdir(resolved, { recursive: true });
        continue;
      }

      if (typeflag !== "0" && typeflagByte !== 0) {
        throw new Error(`不支持的条目类型: '${typeflag}' (${typeflagByte})`);
      }

      const parentDir = resolve(resolved, "..");
      await mkdir(parentDir, { recursive: true });
      const file = await open(resolved, "wx");
      try {
        let remaining = size;
        while (remaining > 0) {
          const data = await readRequired(Math.min(remaining, 64 * 1024));
          await file.writeFile(data);
          remaining -= data.length;
        }
      } finally {
        await file.close();
      }
      await readRequired(padding);
    }
    if (nextLongName !== undefined || !ended) throw new Error("Truncated tar archive");
  } finally {
    readStream.destroy();
    gunzip.destroy();
  }
}
