import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface DownloadOneInput {
  readonly url: string;
  readonly destination: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
  readonly signal: AbortSignal;
  readonly onProgress: (receivedBytes: number, totalBytes: number) => void;
  readonly fetcher?: typeof fetch | undefined;
}

export function createProgressThrottle(
  emit: (r: number, t: number) => void,
  intervalMs = 250,
): { report(r: number, t: number): void; flush(): void; dispose(): void } {
  let lastReportTime = 0;
  let pendingR: number | undefined;
  let pendingT: number | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    report(r: number, t: number): void {
      pendingR = r;
      pendingT = t;
      const now = Date.now();

      if (now - lastReportTime >= intervalMs) {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        lastReportTime = now;
        emit(r, t);
      } else if (timer === null) {
        const remaining = intervalMs - (now - lastReportTime);
        timer = setTimeout(() => {
          timer = null;
          lastReportTime = Date.now();
          if (pendingR !== undefined && pendingT !== undefined) {
            emit(pendingR, pendingT);
          }
        }, remaining);
      }
    },
    flush(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pendingR !== undefined && pendingT !== undefined) {
        lastReportTime = Date.now();
        emit(pendingR, pendingT);
      }
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pendingR = pendingT = undefined;
    },
  };
}

async function findExistingAncestor(p: string): Promise<string> {
  let cur = resolve(p);
  while (true) {
    try {
      await stat(cur);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

export async function assertFreeSpace(path: string, requiredBytes: number): Promise<void> {
  const checkPath = await findExistingAncestor(path);
  const stats = await statfs(checkPath);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  if (freeBytes < requiredBytes) {
    const freeMb = Math.round(freeBytes / (1024 * 1024));
    const reqMb = Math.round(requiredBytes / (1024 * 1024));
    throw new Error(`磁盘空间不足: 可用 ${freeMb} MB, 至少需要 ${reqMb} MB`);
  }
}

interface PartMeta {
  readonly url: string;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly totalBytes: number;
  readonly receivedBytes: number;
}

export async function downloadOne(input: DownloadOneInput): Promise<void> {
  if (input.signal.aborted) {
    throw input.signal.reason ?? new Error("Download aborted");
  }

  const fetchFn = input.fetcher ?? fetch;
  const partFile = `${input.destination}.part`;
  const metaFile = `${input.destination}.part.json`;

  let existingMeta: PartMeta | undefined;
  try {
    const raw = await readFile(metaFile, "utf8");
    const parsed = JSON.parse(raw) as PartMeta;
    if (parsed && parsed.url === input.url && typeof parsed.receivedBytes === "number") {
      existingMeta = parsed;
    }
  } catch {
    existingMeta = undefined;
  }

  let startByte = 0;
  if (existingMeta !== undefined) {
    try {
      const st = await stat(partFile);
      if (st.size === existingMeta.receivedBytes && st.size > 0 && st.size <= input.expectedSize) {
        startByte = st.size;
      }
    } catch {
      startByte = 0;
    }
  }

  // If the .part file already has all expected bytes (download completed but
  // rename was interrupted), skip re-downloading and jump to hash verification.
  if (startByte > 0 && startByte === input.expectedSize) {
    const hash = createHash("sha256");
    const existingStream = createReadStream(partFile);
    for await (const chunk of existingStream) {
      input.signal.throwIfAborted();
      hash.update(chunk);
    }
    const actualSha256 = hash.digest("hex").toLowerCase();
    if (actualSha256 !== input.expectedSha256.toLowerCase()) {
      // Corrupted complete file, delete and restart from scratch
      await rm(partFile, { force: true });
      await rm(metaFile, { force: true });
      startByte = 0;
    } else {
      input.signal.throwIfAborted();
      await rename(partFile, input.destination);
      await rm(metaFile, { force: true }).catch(() => {});
      input.onProgress(startByte, input.expectedSize);
      return;
    }
  }

  const headers: Record<string, string> = {};
  if (startByte > 0) {
    headers["Range"] = `bytes=${startByte}-`;
    const validator = existingMeta?.etag ?? existingMeta?.lastModified;
    if (validator) {
      headers["If-Range"] = validator;
    }
  }

  const response = await fetchFn(input.url, {
    headers,
    signal: input.signal,
  });

  if (!response.ok && response.status !== 206) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  let resuming = false;
  const totalBytes = input.expectedSize;

  if (response.status === 206) {
    const contentRange = response.headers.get("content-range");
    if (contentRange) {
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
      if (match) {
        const rangeStart = Number(match[1]);
        if (rangeStart !== startByte) {
          throw new Error(`Content-Range 起点不符: 期望 ${startByte}, 实际 ${rangeStart}`);
        }
        if (Number(match[3]) !== input.expectedSize || Number(match[2]) !== input.expectedSize - 1) {
          await response.body?.cancel();
          throw new Error("Content-Range size mismatch");
        }
        resuming = true;
      } else {
        throw new Error(`无法解析 Content-Range: ${contentRange}`);
      }
    } else {
      await response.body?.cancel();
      throw new Error("Missing Content-Range for partial response");
    }
  } else {
    // Received 200: server does not support or ignored Range. Start from beginning.
    startByte = 0;
    const cl = response.headers.get("content-length");
    if (cl && Number(cl) !== input.expectedSize) {
      await response.body?.cancel();
      throw new Error("Download size mismatch");
    }
  }

  const etag = response.headers.get("etag") ?? undefined;
  const lastModified = response.headers.get("last-modified") ?? undefined;

  const hash = createHash("sha256");

  if (resuming && startByte > 0) {
    // Hash existing part file content using streaming to avoid loading the
    // entire file into memory (can be 150+ MB for Runtime downloads).
    const existingStream = createReadStream(partFile);
    for await (const chunk of existingStream) {
      input.signal.throwIfAborted();
      hash.update(chunk);
    }
  }

  const openMode = resuming && startByte > 0 ? "a" : "w";
  const fileHandle = await open(partFile, openMode);

  let receivedBytes = startByte;
  input.onProgress(receivedBytes, totalBytes);
  const reader = response.body?.getReader();

  try {
    if (!reader) {
      throw new Error("Response body is empty");
    }

    while (true) {
      if (input.signal.aborted) {
        throw input.signal.reason ?? new Error("Download aborted");
      }

      const { done, value } = await reader.read();
      input.signal.throwIfAborted();
      if (done) break;

      if (value && value.length > 0) {
        if (receivedBytes + value.length > input.expectedSize) throw new Error("Download size exceeds signed size");
        let offset = 0;
        while (offset < value.length) {
          const { bytesWritten } = await fileHandle.write(value.subarray(offset));
          if (bytesWritten === 0) throw new Error("Download file write made no progress");
          offset += bytesWritten;
        }
        hash.update(value);
        receivedBytes += value.length;
        input.onProgress(receivedBytes, totalBytes);

        // Update part metadata
        const meta: PartMeta = {
          url: input.url,
          etag,
          lastModified,
          totalBytes,
          receivedBytes,
        };
        await writeFile(metaFile, JSON.stringify(meta), "utf8").catch(() => {});
      }
    }
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
    await fileHandle.close();
  }

  if (receivedBytes !== input.expectedSize) throw new Error("Download size mismatch");
  input.signal.throwIfAborted();
  const actualSha256 = hash.digest("hex").toLowerCase();
  if (actualSha256 !== input.expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 校验失败: 期望 ${input.expectedSha256}, 实际 ${actualSha256}`);
  }

  await rename(partFile, input.destination);
  await rm(metaFile, { force: true }).catch(() => {});
  input.onProgress(receivedBytes, totalBytes);
}
