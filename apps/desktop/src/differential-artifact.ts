import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { sha256File, type ComponentRelease, type DownloadMethod, type UpdateFile } from "@omp-studio/runtime-installer";
import type { BlockMap } from "builder-util-runtime";
import { assertFreeSpace, downloadOne } from "./artifact-download.js";
import { applyMirror } from "./update-index.js";
import { withUpdateSignal, type UpdateRequestLog } from "./update-request.js";

export interface DifferentialInput {
  release: ComponentRelease; previous?: ComponentRelease | undefined;
  root: string; mirror: string; signal: AbortSignal; fetcher?: typeof fetch | undefined;
  log?: UpdateRequestLog | undefined;
  progress: (method: DownloadMethod, received: number, total: number, message?: string) => void;
  differential?: ((oldFile: string, newFile: string, url: string, oldMap: BlockMap, newMap: BlockMap, file: UpdateFile, signal: AbortSignal, progress: (received: number, total: number) => void) => Promise<void>) | undefined;
}
export function cachedUpdatePath(root: string, file: UpdateFile): string { return join(root, file.sha256, file.asset); }
export async function isVerifiedFile(path: string, file: UpdateFile): Promise<boolean> {
  try { return (await stat(path)).size === file.size && await sha256File(path) === file.sha256; } catch { return false; }
}
function parseBlockmap(bytes: Buffer, expectedSize: number): BlockMap {
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8")) as BlockMap;
  if (value.version !== "2" || !Array.isArray(value.files) || value.files.length !== 1) throw new Error("Unsupported blockmap");
  const file = value.files[0]!;
  if (file.offset !== 0 || file.sizes.length !== file.checksums.length || file.sizes.some(n => !Number.isSafeInteger(n) || n <= 0) || file.sizes.reduce((a, b) => a + b, 0) !== expectedSize) throw new Error("Invalid blockmap bounds");
  return value;
}
export async function downloadDifferentialArtifact(input: DifferentialInput): Promise<string> {
  const target = cachedUpdatePath(input.root, input.release.file);
  await mkdir(join(input.root, input.release.file.sha256), { recursive: true });
  if (await isVerifiedFile(target, input.release.file)) {
    input.progress("reuse", 0, 0); return target;
  }
  await assertFreeSpace(input.root, input.release.file.size * 3);
  const download = async (file: UpdateFile, onProgress: (r: number, t: number) => void): Promise<string> => {
    const path = cachedUpdatePath(input.root, file);
    await mkdir(join(input.root, file.sha256), { recursive: true });
    if (!await isVerifiedFile(path, file)) await downloadOne({ url: file.url, mirror: input.mirror, destination: path, expectedSha256: file.sha256, expectedSize: file.size, signal: input.signal, fetcher: input.fetcher, log: input.log, onProgress });
    return path;
  };
  let fallbackReason: string | undefined;
  const previous = input.previous;
  if (previous && input.differential && await isVerifiedFile(cachedUpdatePath(input.root, previous.file), previous.file)) {
    try {
      for (const map of [previous.blockmap, input.release.blockmap]) if (map.size > 8 * 1024 * 1024) throw new Error("Blockmap too large");
      const oldMap = parseBlockmap(await readFile(await download(previous.blockmap, () => {})), previous.file.size);
      const newMap = parseBlockmap(await readFile(await download(input.release.blockmap, () => {})), input.release.file.size);
      input.progress("differential", 0, input.release.file.size);
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      let idle = setTimeout(() => controller.abort(new Error("增量下载长时间没有进展")), 30_000);
      try {
        await withUpdateSignal(input.differential(cachedUpdatePath(input.root, previous.file), target, applyMirror(input.mirror, input.release.file.url), oldMap, newMap, input.release.file, signal, (r, t) => {
          clearTimeout(idle);
          idle = setTimeout(() => controller.abort(new Error("增量下载长时间没有进展")), 30_000);
          input.progress("differential", r, t);
        }), signal);
      } finally { clearTimeout(idle); controller.abort(); }
      if (!await isVerifiedFile(target, input.release.file)) throw new Error("Reconstructed artifact checksum mismatch");
      return target;
    } catch (error) {
      input.signal.throwIfAborted();
      const message = error instanceof Error ? error.message : "";
      const reason = /没有进展/u.test(message) ? "timeout" : /checksum/iu.test(message) ? "checksum" : /range/iu.test(message) ? "range" : "request";
      input.log?.write("warn", "update.differential.fallback", `stage=artifact reason=${reason}`);
      fallbackReason = "增量下载不可用，正在下载完整更新包";
    }
  }
  input.progress("full", 0, input.release.file.size, fallbackReason);
  return download(input.release.file, (r, t) => input.progress("full", r, t, fallbackReason));
}
