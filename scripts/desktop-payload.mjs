/** Inspect a real unpacked Electron directory; this is not an installer-size estimate. */
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const asar = require("@electron/asar");
const directory = resolve(process.argv[2]);
const output = process.argv[3];
const archive = join(directory, "resources", "app.asar");
const entries = [];
function walkArchive(files, prefix = "") {
  for (const [name, entry] of Object.entries(files)) {
    const path = `${prefix}/${name}`;
    if (entry.files) walkArchive(entry.files, path);
    else if (entry.size !== undefined) entries.push({ path, bytes: entry.size, unpacked: entry.unpacked === true });
  }
}
walkArchive(asar.getRawHeader(archive).header.files);
async function diskBytes(path) {
  const info = await stat(path);
  if (info.isFile()) return info.size;
  return (await Promise.all((await readdir(path)).map(name => diskBytes(join(path, name))))).reduce((sum, size) => sum + size, 0);
}
const sum = rows => rows.reduce((total, row) => total + row.bytes, 0);
const groups = Object.groupBy(entries, entry => {
  const parts = entry.path.split("/");
  return parts[1] === "node_modules" ? parts.slice(2, parts[2].startsWith("@") ? 4 : 3).join("/") : "application";
});
const manifest = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
const report = {
  directory, version: manifest.version, measuredAt: new Date().toISOString(),
  directoryBytes: await diskBytes(directory), archiveBytes: (await stat(archive)).size,
  archiveLogicalBytes: sum(entries), unpackedLogicalBytes: sum(entries.filter(entry => entry.unpacked)),
  mapsBytes: sum(entries.filter(entry => entry.path.endsWith(".map"))),
  groups: Object.entries(groups).map(([name, files]) => ({ name, bytes: sum(files), files: files.length })).sort((a, b) => b.bytes - a.bytes),
  entries,
};
if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
console.log(JSON.stringify({ directory, version: report.version, directoryBytes: report.directoryBytes, archiveBytes: report.archiveBytes, mapsBytes: report.mapsBytes, output }, null, 2));
