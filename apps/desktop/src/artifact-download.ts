import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyMirror } from "./update-index.js";
import { UpdateTransportError, withUpdateRequest, type UpdateRequestLog, type UpdateRequestPolicy } from "./update-request.js";

export interface DownloadOneInput {
  readonly url: string;
  readonly destination: string;
  readonly expectedSha256: string;
  readonly expectedSize: number;
  readonly signal: AbortSignal;
  readonly onProgress: (receivedBytes: number, totalBytes: number) => void;
  readonly fetcher?: typeof fetch | undefined;
  readonly mirror?: string | undefined;
  readonly log?: UpdateRequestLog | undefined;
  readonly requestPolicy?: Partial<UpdateRequestPolicy> | undefined;
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
  readonly sha256?: string;
  readonly sourceUrl?: string;
  readonly etag?: string | undefined;
  readonly lastModified?: string | undefined;
  readonly totalBytes: number;
  readonly receivedBytes: number;
}

export async function downloadOne(input: DownloadOneInput): Promise<void> {
  const partFile = `${input.destination}.part`;
  const metaFile = `${input.destination}.part.json`;
  return withUpdateRequest({ ...input, stage: "artifact" }, async (attempt) => {
    let existingMeta: PartMeta | undefined;
    let startByte = 0;
    try {
      const parsed = JSON.parse(await readFile(metaFile, "utf8")) as PartMeta;
      const sameArtifact = parsed.sha256 !== undefined
        ? parsed.sha256 === input.expectedSha256 && parsed.totalBytes === input.expectedSize
        : (parsed.url === input.url || parsed.url === applyMirror(input.mirror ?? "", input.url)) &&
          (parsed.totalBytes === undefined || parsed.totalBytes === input.expectedSize);
      const st = await stat(partFile);
      if (sameArtifact && st.size === parsed.receivedBytes && st.size > 0 && st.size <= input.expectedSize) {
        existingMeta = parsed;
        startByte = st.size;
      }
    } catch { /* No matching checkpoint: start this signed artifact from zero. */ }

    // A completed checkpoint can be left by either a process exit or an
    // interrupted stream. Verify it before issuing an out-of-bounds Range.
    if (startByte > 0 && startByte === input.expectedSize) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(partFile)) {
        attempt.signal.throwIfAborted();
        hash.update(chunk);
      }
      if (hash.digest("hex") === input.expectedSha256.toLowerCase()) {
        attempt.signal.throwIfAborted();
        await rename(partFile, input.destination);
        await rm(metaFile, { force: true }).catch(() => {});
        input.onProgress(startByte, input.expectedSize);
        return;
      }
      await rm(partFile, { force: true }); await rm(metaFile, { force: true });
      startByte = 0;
    }

    const headers: Record<string, string> = {};
    if (startByte > 0) {
      headers["Range"] = `bytes=${startByte}-`;
      // ETags describe the chosen transport, not the signed artifact. A
      // different mirror/origin must not inherit another source's validator.
      if ((existingMeta?.sourceUrl ?? existingMeta?.url) === attempt.url) {
        const validator = existingMeta?.etag ?? existingMeta?.lastModified;
        if (validator) headers["If-Range"] = validator;
      }
    }
    const response = await attempt.request(headers);
    let resuming = false;
    const totalBytes = input.expectedSize;

    if (response.status === 206) {
      const contentRange = response.headers.get("content-range");
      if (!contentRange) throw new Error("Missing Content-Range for partial response");
      const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(contentRange);
      if (!match) throw new Error(`无法解析 Content-Range: ${contentRange}`);
      if (Number(match[1]) !== startByte) throw new Error(`Content-Range 起点不符: 期望 ${startByte}, 实际 ${match[1]}`);
      if (Number(match[3]) !== input.expectedSize || Number(match[2]) !== input.expectedSize - 1) throw new Error("Content-Range size mismatch");
      resuming = true;
    } else {
      // The source ignored Range: replace the checkpoint with the full body.
      startByte = 0;
      const cl = response.headers.get("content-length");
      if (cl && Number(cl) !== input.expectedSize) throw new Error("Download size mismatch");
    }
    const etag = response.headers.get("etag") ?? undefined;
    const lastModified = response.headers.get("last-modified") ?? undefined;
    const hash = createHash("sha256");
    if (resuming && startByte > 0) {
      for await (const chunk of createReadStream(partFile)) {
        attempt.signal.throwIfAborted();
        hash.update(chunk);
      }
    }
    const fileHandle = await open(partFile, resuming && startByte > 0 ? "a" : "w");
    let receivedBytes = startByte;
    input.onProgress(receivedBytes, totalBytes);
    const reader = response.body?.getReader();
    try {
      if (!reader) throw new Error("Response body is empty");
      for (;;) {
        const { done, value } = await attempt.read(reader);
        attempt.signal.throwIfAborted();
        if (done) break;
        if (value.length > 0) {
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
          const meta: PartMeta = { url: input.url, sourceUrl: attempt.url, sha256: input.expectedSha256,
            etag, lastModified, totalBytes, receivedBytes };
          await writeFile(metaFile, JSON.stringify(meta), "utf8").catch(() => {});
        }
      }
    } finally {
      const cancelled = reader?.cancel().catch(() => {});
      if (!attempt.signal.aborted) await cancelled;
      reader?.releaseLock();
      await fileHandle.close();
    }
    if (receivedBytes !== input.expectedSize) throw new UpdateTransportError("Download size mismatch: response ended before the signed size");
    attempt.signal.throwIfAborted();
    const actualSha256 = hash.digest("hex");
    if (actualSha256 !== input.expectedSha256.toLowerCase()) throw new Error(`SHA-256 校验失败: 期望 ${input.expectedSha256}, 实际 ${actualSha256}`);
    await rename(partFile, input.destination);
    await rm(metaFile, { force: true }).catch(() => {});
    input.onProgress(receivedBytes, totalBytes);
  });
}
