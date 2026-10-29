import { stat, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname, relative } from "node:path";

const root = resolve(process.argv[2] ?? "apps/renderer/dist");
const reportPath = resolve(process.argv[3] ?? "outputs/perf/artifact-inventory.json");
const files = [];
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile()) files.push({ path: relative(root, path).split("\\").join("/"), bytes: (await stat(path)).size });
  }
}
await visit(root);
const groups = {};
for (const file of files) {
  const group = file.path.startsWith("graphics-xite/") ? "graphics-xite" : file.path.startsWith("runtime/") ? "runtime" : file.path.endsWith(".js") || file.path.endsWith(".mjs") ? "javascript" : file.path.endsWith(".css") ? "css" : "other";
  groups[group] = (groups[group] ?? 0) + file.bytes;
}
const report = { root, totalBytes: files.reduce((sum, file) => sum + file.bytes, 0), files: files.sort((a,b) => b.bytes-a.bytes), groups };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ totalBytes: report.totalBytes, groups, largest: report.files.slice(0,12), reportPath }, null, 2));
