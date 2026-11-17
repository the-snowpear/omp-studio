// Bazel's disk cache is disposable; finished native addons live separately as
// artifacts. Keep the most recently used action blobs within the per-target
// budget before saving main's cache to GitHub's shared repository quota.
import { readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function pruneBuildCache(directory, limit) {
  const files = [];
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const info = await stat(path);
        files.push({ path, size: info.size, accessed: info.atimeMs });
      }
    }
  }
  await visit(directory);
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.accessed - b.accessed)) {
    if (bytes <= limit) break;
    await rm(file.path);
    bytes -= file.size;
  }
  return bytes;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const directory = resolve(process.argv[2]);
  const limit = Number(process.argv[3]);
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("A positive byte budget is required");
  console.log(`Bazel cache retained ${(await pruneBuildCache(directory, limit) / 1024 ** 2).toFixed(1)} MiB`);
}
