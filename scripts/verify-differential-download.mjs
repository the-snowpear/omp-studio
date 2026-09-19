// Local HTTP range integration check using the exact pinned production downloader.
// Usage: node scripts/verify-differential-download.mjs OLD NEW OUTPUT_DIR
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildBlockMap } from "app-builder-lib/out/targets/blockmap/blockmap.js";
import { NodeHttpExecutor } from "builder-util/out/nodeHttpExecutor.js";
import { GenericDifferentialDownloader } from "electron-updater/out/differentialDownloader/GenericDifferentialDownloader.js";
import { CancellationToken } from "builder-util-runtime";

const [oldArg, newArg, outputArg] = process.argv.slice(2);
if (!oldArg || !newArg || !outputArg) throw new Error("Expected OLD NEW OUTPUT_DIR");
const oldFile = resolve(oldArg), source = resolve(newArg), output = resolve(outputArg);
await mkdir(output, { recursive: true });
const newFile = join(output, "reconstructed.bin");
if ([oldFile, source].includes(newFile)) throw new Error("Output must differ from inputs");
const size = (await stat(source)).size;
const metadata = await buildBlockMap(source, "gzip", join(output, "new.blockmap"));
await buildBlockMap(oldFile, "gzip", join(output, "old.blockmap"));
const oldMap = JSON.parse(gunzipSync(await readFile(join(output, "old.blockmap"))));
const newMap = JSON.parse(gunzipSync(await readFile(join(output, "new.blockmap"))));
let transferred = 0, requests = 0;
const server = createServer((req, res) => {
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
  if (!range) { res.writeHead(400); res.end(); return; }
  const start = Number(range[1]), end = Number(range[2]);
  if (end < start || end >= size) { res.writeHead(416); res.end(); return; }
  requests++; transferred += end - start + 1;
  res.writeHead(206, { "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1, "accept-ranges": "bytes" });
  createReadStream(source, { start, end }).pipe(res);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  await new GenericDifferentialDownloader({ size, sha512: metadata.sha512 }, new NodeHttpExecutor(), {
    oldFile, newFile, newUrl: new URL(`http://127.0.0.1:${server.address().port}/artifact`), logger: { info() {}, warn() {}, error: console.error }, requestHeaders: null, isUseMultipleRangeRequest: false, cancellationToken: new CancellationToken(),
  }).download(oldMap, newMap);
  const digest = async path => { const h = createHash("sha256"); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest("hex"); };
  if (await digest(source) !== await digest(newFile)) throw new Error("Reconstructed artifact mismatch");
  const report = { oldFile, source, fullBytes: size, transferredBytes: transferred, requests, savedPercent: Math.round((1 - transferred / size) * 10000) / 100, verified: true };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally { await new Promise(resolve => server.close(resolve)); }
