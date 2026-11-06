import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Worker } from "node:worker_threads";

export interface FileDigests {
  digests: string[];
  bytes: number;
}

// Static, self-contained code also works inside the packaged Main and remote
// Host bundles. Only the path and hash prefixes cross into the Worker.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { createHash } = require("node:crypto");
const { openSync, readSync, closeSync } = require("node:fs");
const hashes = workerData.prefixes.map(prefix => createHash("sha256").update(prefix));
const buffer = Buffer.allocUnsafe(1024 * 1024);
const file = openSync(workerData.path, "r");
let bytes = 0;
try {
  for (;;) {
    const count = readSync(file, buffer, 0, buffer.length, null);
    if (count === 0) break;
    const chunk = buffer.subarray(0, count);
    for (const hash of hashes) hash.update(chunk);
    bytes += count;
  }
} finally {
  closeSync(file);
}
parentPort.postMessage({ digests: hashes.map(hash => hash.digest("hex")), bytes });
`;

/** Each scan owns a Worker that exits before the result is returned. No pool or cache. */
export function readFileDigestsInWorker(path: string, prefixes: readonly string[]): Promise<FileDigests> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { path, prefixes } });
    let result: FileDigests | undefined;
    worker.once("message", (value: FileDigests) => { result = value; });
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code === 0 && result !== undefined) resolve(result);
      else reject(new Error(`File verification worker exited without a result (code=${code})`));
    });
  });
}

/** SHA-256 digests over the same file bytes, optionally salted with fixed prefixes. */
export async function readFileDigests(path: string, prefixes: readonly string[] = [""]): Promise<FileDigests> {
  // Keep small metadata and ordinary Node CLI reads cheap. Electron's shared
  // Main loop pays heavily for repeated async file reads; bulk work runs off it.
  if (process.versions.electron && (await stat(path)).size >= 32 * 1024 * 1024) {
    return readFileDigestsInWorker(path, prefixes);
  }
  const hashes = prefixes.map(prefix => createHash("sha256").update(prefix));
  let bytes = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    for (const hash of hashes) hash.update(chunk);
    bytes += (chunk as Buffer).length;
  }
  return { digests: hashes.map(hash => hash.digest("hex")), bytes };
}
