import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";

export const RUNTIME_ARCHIVE_FILES = ["checksums.json", "omp.exe", "runtime-manifest.json", "runtime-signature.json"] as const;
const MAX_ARCHIVE = 768 * 1024 * 1024;
/** Fixed order, fixed timestamps and STORE preserve binary block reuse. */
export async function createRuntimeArchive(directory: string, destination: string): Promise<void> {
  const entries: Record<string, Uint8Array> = {};
  for (const name of RUNTIME_ARCHIVE_FILES) entries[name] = await readFile(join(directory, name));
  await writeFile(destination, zipSync(entries, { level: 0, mtime: new Date(1980, 0, 1), os: 0 }));
}
export async function extractRuntimeArchive(archive: string, destination: string): Promise<void> {
  if ((await stat(archive)).size > MAX_ARCHIVE) throw new Error("Runtime archive too large");
  const bytes = await readFile(archive);
  if (bytes.length > MAX_ARCHIVE) throw new Error("Runtime archive too large");
  let count = 0, total = 0;
  const seen = new Set<string>();
  const entries = unzipSync(bytes, { filter: (entry) => {
    if (!(RUNTIME_ARCHIVE_FILES as readonly string[]).includes(entry.name) || seen.has(entry.name) || entry.compression !== 0) throw new Error("Unexpected Runtime archive entry");
    seen.add(entry.name); count++; total += entry.originalSize;
    if (count > 4 || total > MAX_ARCHIVE || entry.originalSize !== entry.size) throw new Error("Invalid Runtime archive size");
    return true;
  } });
  if (count !== 4) throw new Error("Incomplete Runtime archive");
  await mkdir(destination, { recursive: true });
  for (const name of RUNTIME_ARCHIVE_FILES) await writeFile(join(destination, name), entries[name]!, { flag: "wx" });
}
