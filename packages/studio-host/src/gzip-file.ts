import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";

export type GzipFileErrorCode = "TOO_LARGE" | "CORRUPT";

export class GzipFileError extends Error {
  constructor(readonly code: GzipFileErrorCode, message: string) {
    super(message);
    this.name = "GzipFileError";
  }
}

/**
 * Read a gzip file fully into memory with a hard cap on the decompressed
 * size. The compressed size is checked first so an oversized member is
 * rejected without streaming it at all.
 */
export async function readGunzipCapped(path: string, maxBytes: number): Promise<Buffer> {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata !== undefined && metadata.size > maxBytes) {
    throw new GzipFileError("TOO_LARGE", "compressed session exceeds the configured read limit");
  }
  return await gunzipStream(path, maxBytes);
}

/**
 * Read only the first `prefixBytes` decompressed bytes of a gzip file. The
 * stream is destroyed as soon as the prefix is complete, so header scans of
 * large archives stay cheap. `maxTotalBytes` still bounds a pathological
 * member whose prefix never completes.
 */
export async function readGunzipPrefix(path: string, prefixBytes: number, maxTotalBytes: number): Promise<Buffer> {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata !== undefined && metadata.size > maxTotalBytes) {
    throw new GzipFileError("TOO_LARGE", "compressed session exceeds the configured read limit");
  }
  return await gunzipStream(path, maxTotalBytes, prefixBytes);
}

function gunzipStream(path: string, maxBytes: number, earlyStopBytes?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const source = createReadStream(path);
    const gunzip = createGunzip();
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      source.destroy();
      gunzip.destroy();
      reject(error);
    };
    const succeed = (buffer: Buffer): void => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(new GzipFileError("TOO_LARGE", "decompressed session exceeds the configured read limit"));
        return;
      }
      chunks.push(chunk);
      if (earlyStopBytes !== undefined && total >= earlyStopBytes) {
        source.destroy();
        gunzip.destroy();
        succeed(Buffer.concat(chunks, total));
      }
    });
    gunzip.on("error", (error: NodeJS.ErrnoException) => {
      fail(new GzipFileError("CORRUPT", `gzip stream is corrupt: ${error.message}`));
    });
    source.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        fail(Object.assign(new Error(`gzip file is not available: ${error.message}`), { code: "ENOENT" }));
        return;
      }
      fail(new GzipFileError("CORRUPT", `gzip file could not be read: ${error.message}`));
    });
    gunzip.on("end", () => succeed(Buffer.concat(chunks, total)));
    gunzip.on("close", () => {
      // Destroy-after-prefix stops the stream without `end`; nothing to do
      // because success already resolved.
    });
    source.pipe(gunzip);
  });
}
