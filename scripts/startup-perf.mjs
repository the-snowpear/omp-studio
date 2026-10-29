import { build } from "vite";
import { createRequire } from "node:module";
const { _electron } = process.env.PLAYWRIGHT_MODULE
  ? createRequire(import.meta.url)(resolve(process.env.PLAYWRIGHT_MODULE))
  : await import("playwright");
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const reportPath = resolve(process.env.PERF_REPORT ?? "outputs/perf/workbench.json");
const output = resolve(process.env.PERF_OUTPUT ?? "outputs/perf/workbench-production");
const runs = Number(process.env.PERF_RUNS ?? 10);
const renderer = join(root, "apps/renderer");
const identity = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim(),
  mode: "production-file-fixture", node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, runs,
};
const samples = [], errors = [], modules = [];
await mkdir(output, { recursive: true });
if (process.env.PERF_SKIP_BUILD !== "1") {
  await build({ root: renderer, configFile: join(renderer, "vite.config.ts"), logLevel: "warn",
    build: { outDir: output, emptyOutDir: false, target: "esnext", manifest: true, rollupOptions: { input: join(renderer, "workbench-perf.html") } } });
  await writeFile(join(output, "build-identity.json"), JSON.stringify(identity, null, 2));
}
const buildFiles = (await readdir(join(output, "assets"))).filter(name => name.endsWith(".js") || name.endsWith(".css")).sort();
const digest = createHash("sha256");
for (const name of buildFiles) { digest.update(name); digest.update(await readFile(join(output, "assets", name))); }
identity.buildSha256 = digest.digest("hex");
try { identity.build = JSON.parse(await readFile(join(output, "build-identity.json"), "utf8")); } catch { identity.build = "previously captured build; see baseline report"; }
const launcher = join(output, "electron-perf.cjs");
await writeFile(launcher, `const {app,BrowserWindow}=require("electron");
app.setPath("userData",process.env.PERF_PROFILE);
app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(output, "workbench-perf.html"))});});\n`);
for (let run = 0; run < runs; run++) {
  const env = { ...process.env, PERF_PROFILE: join(output, `profile-${run}`) }; delete env.ELECTRON_RUN_AS_NODE;
  const started = performance.now();
  const app = await _electron.launch({ executablePath: createRequire(import.meta.url)("electron"), args: [launcher], env });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.ompWorkbenchPerf), { timeout: 30000 });
    const launchToShellMs = performance.now() - started;
    identity.electron = await app.evaluate(() => process.versions.electron);
    await page.waitForTimeout(500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    const resources = [];
    cdp.on("Network.responseReceived", ({ response }) => { if (response.url.endsWith(".js") || response.url.endsWith(".css")) resources.push(response.url); });
    await page.reload();
    await page.waitForFunction(() => Boolean(window.ompWorkbenchPerf));
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    await page.evaluate(() => window.ompWorkbenchPerf.deltas(15));
    const before = await metrics();
    const stream = await page.evaluate(() => window.ompWorkbenchPerf.deltas(180));
    const after = await metrics();
    const surface = await page.evaluate(() => ({ readyMs: window.ompWorkbenchPerf.readyMs, resources: performance.getEntriesByType("resource").map(entry => entry.name), text: document.querySelector("#appRoot")?.textContent?.length ?? 0 }));
    samples.push({ launchToShellMs, readyMs: surface.readyMs, ...stream,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      heapBytes: after.JSHeapUsedSize, domNodes: after.Nodes });
    if (run === 0) modules.push(...resources);
    console.log(JSON.stringify({ run, launchToShellMs, scriptMs: samples.at(-1).scriptMs, cursor: stream.cursor, resyncRequired: stream.resyncRequired }));
  } finally { await app.close(); }
}
const median = key => { const sorted = samples.map(sample => sample[key]).sort((a,b) => a-b); return (sorted[Math.floor((sorted.length - 1)/2)] + sorted[Math.floor(sorted.length/2)])/2; };
const assetSizes = [];
for (const name of await readdir(join(output, "assets"))) assetSizes.push({ name, bytes: (await stat(join(output, "assets", name))).size });
let manifest;
try { manifest = JSON.parse(await readFile(join(output, ".vite/manifest.json"), "utf8")); } catch {}
const report = { identity, samples, median: Object.fromEntries(["launchToShellMs", "readyMs", "scriptMs", "layoutMs", "heapBytes", "p95Ms"].map(key => [key, median(key)])), modules, assetSizes, manifest, errors,
  limitations: ["Synthetic full-App fixture, not actual Host/Runtime startup", "Cursor-only deltas isolate shell work; use perf:streaming for transcript rendering", "Fresh Electron userData per sample, operating-system file cache is not cleared"],
  passed: errors.length === 0 && samples.every(sample => !sample.resyncRequired && sample.cursor === "780") };
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ reportPath, median: report.median, passed: report.passed }));
if (!report.passed) process.exitCode = 1;
