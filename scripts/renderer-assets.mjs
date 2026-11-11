/** Opt-in production-entry inventory. Static imports are counted once; lazy chunks stay separate. */
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = resolve(process.argv[2] ?? "apps/renderer/dist");
const output = process.argv[3];
const html = await readFile(join(root, "index.html"), "utf8");
const modules = new Map();
async function visit(file) {
  file = resolve(file);
  if (modules.has(file)) return;
  const text = await readFile(file, "utf8");
  const row = { file: relative(root, file).replaceAll("\\", "/"), bytes: Buffer.byteLength(text), gzipBytes: gzipSync(text).length };
  modules.set(file, row);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  for (const node of source.statements) {
    if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier) continue;
    const specifier = node.moduleSpecifier.text;
    if (specifier.startsWith(".")) await visit(resolve(dirname(file), specifier));
  }
}
for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) await visit(resolve(root, match[1]));
const styles = [];
for (const match of html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"/g)) {
  const bytes = await readFile(resolve(root, match[1]));
  styles.push({ file: match[1], bytes: bytes.length, gzipBytes: gzipSync(bytes).length });
}
async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await inventory(file));
    else files.push({ file: relative(root, file).replaceAll("\\", "/"), bytes: (await stat(file)).size });
  }
  return files;
}
const assets = await inventory(root);
const total = (rows, key = "bytes") => rows.reduce((sum, row) => sum + row[key], 0);
const report = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
  root, measuredAt: new Date().toISOString(),
  staticJs: { bytes: total([...modules.values()]), gzipBytes: total([...modules.values()], "gzipBytes"), files: [...modules.values()].sort((a, b) => b.bytes - a.bytes) },
  initialCss: { bytes: total(styles), gzipBytes: total(styles, "gzipBytes"), files: styles },
  distribution: { bytes: total(assets), files: assets.sort((a, b) => b.bytes - a.bytes) },
  limitations: ["Static import closure is not all startup work: rendered lazy panels can load further chunks.", "gzip is a comparison metric; Electron file URLs read raw bytes."]
};
if (output) { await mkdir(dirname(resolve(output)), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + "\n"); }
console.log(JSON.stringify({ revision: report.revision, staticJs: report.staticJs.bytes, initialCss: report.initialCss.bytes, distribution: report.distribution.bytes, output }, null, 2));
