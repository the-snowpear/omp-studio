/** Real Chromium / production-file Electron highlight and Mermaid verification. */
import { build, createServer } from "vite";
import { chromium, _electron } from "playwright";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("..", import.meta.url));
const renderer = join(root, "apps/renderer");
const mode = process.env.PERF_BUILD_MODE ?? "development";
const runs = Number(process.env.PERF_RUNS ?? 5);
const reportPath = process.env.PERF_REPORT ?? join(root, "outputs/perf/render-work.json");
process.env.VITE_OMP_PRESERVE_PERFORMANCE_TIMELINE = "1";
const fileMode = mode === "file";
const output = join(root, "outputs/perf/render-work-production");
let server, browser, electron, page;
const identity = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version, mode, cpuCount: cpus().length, cpuModel: cpus()[0]?.model, runs };
const errors = [];
const samples = [];
try {
  if (fileMode) {
    await build({ root: renderer, configFile: join(renderer, "vite.config.ts"), logLevel: "warn",
      build: { outDir: output, emptyOutDir: false, rollupOptions: { input: join(renderer, "perf-harness.html") } } });
    const launcher = join(output, "electron-smoke.cjs");
    await writeFile(launcher, `const {app,BrowserWindow}=require("electron");
for (const flag of ['disable-background-timer-throttling','disable-backgrounding-occluded-windows','disable-renderer-backgrounding']) app.commandLine.removeSwitch(flag);
app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:900,show:true,paintWhenInitiallyHidden:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});w.loadFile(${JSON.stringify(join(output, "perf-harness.html"))});});
`, "utf8");
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    electron = await _electron.launch({ args: [launcher], env });
    electron.process().stderr.on("data", (chunk) => process.stderr.write(chunk));
    page = await electron.firstWindow();
    Object.assign(identity, await electron.evaluate(({ app }) => ({ electron: app.getVersion(), versions: process.versions })));
  } else {
    server = await createServer({ root: renderer, configFile: join(renderer, "vite.config.ts"), logLevel: "warn",
      optimizeDeps: { include: ["lowlight", "mermaid"] },
      server: { host: "127.0.0.1", port: 5197, strictPort: false } });
    await server.listen(); browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    identity.chromium = browser.version();
    await page.goto(`${server.resolvedUrls.local[0]}perf-harness.html`);
  }
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.waitForFunction(() => typeof window.ompPerf?.renderWork === "object");
  identity.optimizations = await page.evaluate(() => window.ompPerf.renderWork.options);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.evaluate(() => window.ompPerf.renderWork.highlight(10)); // warm up
  for (let run = 0; run < runs; run++) {
    const before = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    let finished = false;
    const rendering = page.evaluate(() => window.ompPerf.renderWork.highlight()).finally(() => { finished = true; });
    const probe = (async () => {
      while (!finished) { await page.mouse.click(50, 20); await page.waitForTimeout(25); }
    })();
    const result = await rendering; await probe;
    const after = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    samples.push({ ...result, scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
      layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000 });
    console.log(JSON.stringify({ run, scriptMs: samples.at(-1).scriptMs, colored: result.colored, inputSamples: result.inputPaintLatencies.length }));
  }
  const fences = await page.evaluate(() => window.ompPerf.renderWork.fences());
  const mermaid = await page.evaluate(() => window.ompPerf.renderWork.mermaid());
  const mermaidPressure = identity.optimizations.boundedMermaid ? await page.evaluate(() => window.ompPerf.renderWork.mermaidPressure()) : undefined;
  const lifecycles = await page.evaluate(() => window.ompPerf.renderWork.lifecycles());
  await page.evaluate(() => window.ompPerf.renderWork.unmount());
  const beforeIdle = await page.evaluate(() => window.ompPerf.renderWork.counters());
  await page.waitForTimeout(31000);
  const afterIdle = await page.evaluate(() => window.ompPerf.renderWork.counters());
  let background;
  if (electron) {
    await electron.close(); electron = undefined;
    // A fresh native Electron process avoids Playwright's renderer visibility
    // emulation, which persists for the lifetime of its attached page session.
    const nativeReport = join(output, "native-visibility.json");
    const env = { ...process.env, PERF_NATIVE_PAGE: join(output, "perf-harness.html"), PERF_NATIVE_REPORT: nativeReport };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable = createRequire(import.meta.url)("electron");
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [join(root, "scripts/native-visibility-smoke.cjs")], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => process.stdout.write(chunk)); child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`native visibility smoke exited ${code}`)));
    });
    background = JSON.parse(await readFile(nativeReport, "utf8"));
  }
  const scripts = samples.map((sample) => sample.scriptMs).sort((a, b) => a - b);
  const report = { identity, samples, medianScriptMs: scripts[Math.floor(scripts.length / 2)], worstScriptMs: scripts.at(-1),
    fences, mermaid, mermaidPressure, lifecycles, background, beforeIdle, afterIdle, errors,
    passed: errors.length === 0 && fences.framed && mermaid.rendered && afterIdle.highlight.workers === 0
      && JSON.stringify(lifecycles.before) === JSON.stringify(lifecycles.after)
      && (background === undefined || background.passed)
      && (mermaidPressure === undefined || (mermaidPressure.during.queued <= 8 && mermaidPressure.after.queued === 0 && mermaidPressure.after.running === 0
        && mermaidPressure.oversizedSource && mermaidPressure.noOversizedSvg))
      && samples.every((sample) => sample.colored === sample.count && sample.immediatelyFramed === sample.count
        && sample.remounts === 0 && sample.textMismatches === 0 && sample.maxHeightShift <= 1 && sample.inputPaintLatencies.length > 0) };
  await mkdir(dirname(reportPath), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`render-work report: ${reportPath}; passed=${report.passed}`);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify({ identity, samples, errors, passed: false, error: String(error) }, null, 2) + "\n");
  throw error;
} finally { await browser?.close(); await electron?.close(); await server?.close(); }
