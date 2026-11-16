// Keep electron-updater's pinned block planning in one place. Requests and
// cancellation are ours so an ignored Range cannot send full files repeatedly.
import { spawn } from "node:child_process";
import { open, type FileHandle } from "node:fs/promises";
import { computeOperations, OperationKind } from "electron-updater/out/differentialDownloader/downloadPlanBuilder.js";
import type { DifferentialInput } from "./differential-artifact.js";
import { withUpdateSignal } from "./update-request.js";

async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw new Error("Differential file write made no progress");
    offset += bytesWritten;
  }
}

/** Download exactly the changed byte ranges; reject ignored or incorrect ranges immediately. */
export function createDifferentialDownloader(fetcher: typeof fetch): NonNullable<DifferentialInput["differential"]> {
  return async (oldFile, newFile, url, oldMap, newMap, file, signal, progress) => {
    const operations = computeOperations(oldMap, newMap, { info() {}, warn() {}, error() {} });
    const total = operations.filter(op => op.kind === OperationKind.DOWNLOAD).reduce((sum, op) => sum + op.end - op.start, 0);
    let received = 0;
    const source = await open(oldFile, "r");
    try {
      const output = await open(newFile, "w");
      try {
        const buffer = Buffer.allocUnsafe(256 * 1024);
        for (const op of operations) {
          signal.throwIfAborted();
          if (op.kind === OperationKind.COPY) {
            for (let position = op.start; position < op.end;) {
              const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, op.end - position), position);
              if (bytesRead === 0) throw new Error("Differential baseline ended early");
              await writeAll(output, buffer.subarray(0, bytesRead));
              position += bytesRead;
              progress(received, total);
              signal.throwIfAborted();
            }
            continue;
          }
          const response = await withUpdateSignal(fetcher(url, { headers: { Range: `bytes=${op.start}-${op.end - 1}` }, signal }), signal);
          const range = /^bytes\s+(\d+)-(\d+)\/(\d+)$/iu.exec(response.headers.get("content-range") ?? "");
          if (response.status !== 206 || !range || Number(range[1]) !== op.start || Number(range[2]) !== op.end - 1 || Number(range[3]) !== file.size) {
            void response.body?.cancel().catch(() => {});
            throw new Error("Server returned an invalid Range response");
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Differential Range response is empty");
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await withUpdateSignal(reader.read(), signal);
              signal.throwIfAborted();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > op.end - op.start) throw new Error("Differential Range response is too large");
              await writeAll(output, value);
              received += value.byteLength;
              progress(received, total);
            }
          } finally {
            const cancelled = reader.cancel().catch(() => {});
            if (!signal.aborted) await cancelled;
            reader.releaseLock();
          }
          if (bytes !== op.end - op.start) throw new Error("Differential Range response ended early");
        }
      } finally { await output.close(); }
    } finally { await source.close(); }
  };
}

export const electronDifferentialDownload: NonNullable<DifferentialInput["differential"]> = async (...args) => {
  const { net } = await import("electron");
  return createDifferentialDownloader(net.fetch.bind(net) as typeof fetch)(...args);
};

/** Install only the path just re-verified against the persisted signed manifest. */
export class PreparedNsisUpdater {
  async installPrepared(path: string): Promise<void> {
    // Same NSIS arguments as NsisUpdater, but await spawn success and never
    // fall back to openPath (which would display an interactive installer).
    await new Promise<void>((resolve, reject) => {
      const child = spawn(path, ["--updated", "/S", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true, cwd: process.env.TEMP });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
}
