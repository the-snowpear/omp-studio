/** Opt-in real Electron performance run. New isolated profile; no user sessions or model requests.
 * Build first with scripts/check.mjs. Requires playwright-core via PLAYWRIGHT_MODULE.
 * The Windows process sampler is deliberately outside the Electron process tree.
 */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, appendFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cpus, totalmem, release } from "node:os";
import { findBun } from "./omp-tooling.mjs";
import { bundlePreload } from "./preload-bundle.mjs";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const { _electron } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const smoke = process.argv.includes("--smoke");
const outputRoot = resolve(process.env.OMP_NATIVE_PERF_OUTPUT ?? join(root, "outputs/perf/native-session-switch"));
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, smoke ? "smoke-" : "run-"));
const profile = join(output, "profile"), home = join(profile, "home"), agent = join(profile, "agent");
const roaming = join(home, "AppData/Roaming"), local = join(home, "AppData/Local");
await Promise.all([home, roaming, local, ...["Downloads", "Documents", "Desktop"].map(name => join(home, name)), join(agent, "sessions"), join(profile, "workspace"), join(profile, "user-data")].map(path => mkdir(path, { recursive: true })));
const workspace = await realpath(join(profile, "workspace"));
await writeFile(join(workspace, "fixture.txt"), "Synthetic offline performance workspace. No user files.\n", { flag: "wx" });
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
  OMP_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "", PI_PROFILE: "",
  PI_CONFIG_DIR: ".omp", OMP_WORKTREE_DIR: join(profile, "worktrees"),
  XDG_CONFIG_HOME: join(profile, "xdg-config"), XDG_DATA_HOME: join(profile, "xdg-data"), XDG_CACHE_HOME: join(profile, "xdg-cache"), XDG_STATE_HOME: join(profile, "xdg-state"), DO_NOT_TRACK: "1" };
for (const key of Object.keys(env)) {
  if (/(?:API_KEY|TOKEN|SIGNING_SECRET|SIGNING_PRIVATE_KEY)$/.test(key) || ["ELECTRON_RUN_AS_NODE", "OMP_RENDERER_DEV_URL", "OMP_ARTIFACT_DIR", "OMP_RUNTIME_TRUSTED_PUBLIC_KEY", "OMP_RUNTIME_SIGNING_KEY_ID", "OMP_RUNTIME_SIGNING_KEY", "OMP_PREVIEW_DATA"].includes(key)) delete env[key];
}
// A dev-server comparison is explicit; never inherit an unrelated renderer URL.
if (process.env.OMP_NATIVE_PERF_DEV_URL) env.OMP_RENDERER_DEV_URL = process.env.OMP_NATIVE_PERF_DEV_URL;
const seedManifest = join(output, "fixtures.json");
const count = smoke ? 16 : Number(process.env.OMP_NATIVE_PERF_SESSIONS ?? 24);
const turns = smoke ? 8 : Number(process.env.OMP_NATIVE_PERF_TURNS ?? 80);
console.log("Seeding isolated native archives");
execFileSync(findBun(), [join(root, "scripts/native-session-perf-seed.mjs"), workspace, join(agent, "sessions/synthetic"), seedManifest, String(count), String(turns)], { cwd: root, env, windowsHide: true, stdio: "inherit", timeout: 180_000 });
const fixture = JSON.parse(await readFile(seedManifest, "utf8"));
const desktop = join(root, "apps/desktop");
await writeFile(join(profile, "bootstrap.cjs"), [
  "const { app, dialog } = require('electron');",
  `app.getAppPath = () => ${JSON.stringify(desktop)};`,
  `app.setPath('appData', ${JSON.stringify(roaming)});`,
  `app.setPath('userData', ${JSON.stringify(join(profile, "user-data"))});`,
  `app.setPath('downloads', ${JSON.stringify(join(home, "Downloads"))});`,
  `dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(workspace)}] });`,
  `import(${JSON.stringify(pathToFileURL(join(desktop, "dist/src/main.js")).href)});`,
].join("\n"), { flag: "wx" });
await writeFile(join(profile, "package.json"), JSON.stringify({ name: "omp-native-perf", version: "0.1.0", main: "bootstrap.cjs" }), { flag: "wx" });
bundlePreload();
const report = { version: 1, status: "running", smoke, startedAtUnixMs: Date.now(),
  build: `${env.OMP_RENDERER_DEV_URL ? "development" : "production"}-renderer/development-electron-shell`, modelCalls: 0,
  machine: { platform: process.platform, release: release(), logicalCores: cpus().length, cpu: cpus()[0]?.model, physicalMemoryBytes: totalmem() },
  fixture: { sessions: fixture.count, messagesPerSession: fixture.turns * 2, bytes: fixture.bytes },
  notes: ["Synthetic native JSONL archives; real Desktop IPC and Host, no fixture transport", "Fresh isolated profile, no Runtime intentionally installed and no model request", "nextTaskMs is event-loop responsiveness, not paint; readyMs includes loading and the UI transition", "No forced garbage collection; JS heap estimates differ from working set and private commit", "Playwright driver, PowerShell sampler and any separate Vite server are not included in the Electron process tree"],
  phases: [], samples: [], errors: [], warnings: [] };
let app, page, sampler, samplerDone, interval;
let sampling = false, phase = "startup", logBytes = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
async function query(name, input = {}) {
  const response = await page.evaluate(({ name, input }) => window.ompStudio.query({ queryName: name, input }), { name, input });
  if (!response.ok) throw new Error(`Native query failed: ${name} ${response.error?.code ?? "unknown"}`);
  return response.result;
}
async function sample() {
  if (sampling || !page || page.isClosed()) return;
  sampling = true;
  const phaseAtRequest = phase;
  try {
    const value = await page.evaluate(() => ({ atUnixMs: Date.now(), counters: window.ompSessionPerf.snapshot().counters, visibility: document.visibilityState, focused: document.hasFocus() }));
    report.samples.push({ phase: phaseAtRequest, ...value });
  } catch (error) { if (app) report.warnings.push(String(error).slice(0, 240)); }
  finally { sampling = false; }
}
async function select(index, { wait = true, tail = true } = {}) {
  const title = fixture.sessions[index].title;
  await page.evaluate(() => { window.ompSessionPerf.stop(); window.ompSessionPerf.start(); });
  const timing = await page.evaluate(async title => {
    const button = [...document.querySelectorAll("#projectList .thread")].find(element => element.textContent?.includes(title));
    if (!button || !button.checkVisibility() || button.closest("[inert]")) throw new Error(`Fixture row is not visible and interactive: ${title}`);
    const start = performance.now();
    window.__nativeSwitchStart = start;
    button.click();
    const dispatchMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 0));
    return { dispatchMs, nextTaskMs: performance.now() - start };
  }, title);
  if (wait) {
    await page.waitForFunction(({ title, tail }) => {
      const row = [...document.querySelectorAll("#projectList .thread.active")].find(element => element.textContent?.includes(title));
      const body = document.querySelector(".cw-main-conversation .convo-body");
      return !!row && !document.querySelector(".cw-main-conversation #appRoot[aria-busy=true]") && body?.getAttribute("data-phase") === "idle" && !!body.querySelector("[data-item-id]") && (!tail || body.textContent.includes(`Fixture complete: ${title}`));
    }, { title, tail }, { timeout: 30_000, polling: 30 });
  }
  const result = await page.evaluate(() => ({ atUnixMs: Date.now(), readyMs: performance.now() - window.__nativeSwitchStart,
    counters: window.ompSessionPerf.snapshot(true).counters, recording: window.ompSessionPerf.snapshot() }));
  return { index, waitedForReady: wait, ...timing, ...result };
}
async function runPhase(name, operation) {
  phase = name;
  const entry = { name, startUnixMs: Date.now(), steps: [] };
  report.phases.push(entry);
  console.log(`Phase: ${name}`);
  await page.evaluate(() => { window.ompSessionPerf.stop(); window.ompSessionPerf.start(); });
  await sample();
  await operation(entry);
  entry.endUnixMs = Date.now();
  entry.recording = await page.evaluate(() => window.ompSessionPerf.snapshot(true));
  await sample();
  await save();
}
try {
  console.log("Launching the isolated Electron window");
  app = await _electron.launch({ executablePath: require("electron"), args: [profile], cwd: workspace, env, timeout: 60_000 });
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on("data", chunk => {
    logBytes += chunk.length;
    if (logBytes < 2 * 1024 * 1024) void appendFile(join(output, "electron.log"), chunk).catch(() => {});
  });
  if (process.platform === "win32") {
    // Playwright can expose a Windows launcher process; sample Electron's actual main PID.
    const rootPid = await app.evaluate(() => process.pid);
    sampler = spawn("powershell.exe", ["-NoProfile", "-File", join(root, "scripts/sample-session-processes.ps1"), "-RootProcessId", String(rootPid), "-DurationSeconds", "900", "-OutputPath", join(output, "processes.jsonl")], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    samplerDone = new Promise(resolve => { sampler.once("error", error => resolve({ error: String(error) })); sampler.once("exit", code => resolve({ code })); });
    for (const stream of [sampler.stdout, sampler.stderr]) stream.on("data", chunk => { void appendFile(join(output, "sampler.log"), chunk).catch(() => {}); });
  }
  page = await app.firstWindow({ timeout: 30_000 });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", error => report.errors.push({ kind: "pageerror", message: error.message.slice(0, 1000) }));
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) report[message.type() === "error" ? "errors" : "warnings"].push({ kind: "console", message: message.text().slice(0, 1000) });
  });
  await page.waitForFunction(() => !!window.ompStudio && !!window.ompSessionPerf);
  await page.evaluate(() => {
    localStorage.setItem("omp.appSettings", JSON.stringify({ language: "en", theme: "light", startupPage: "home", restoreLastSession: false, rememberLayout: false }));
    localStorage.setItem("omp.previewMode", "0"); localStorage.setItem("omp.lastRoute", "home");
    localStorage.setItem("omp.startupNotice.dismissed", "incomplete-v1"); localStorage.setItem("omp.onboarding.completed", "workbench-0.2.0");
    localStorage.setItem("omp.sessionSwitchPerformance", "1");
  });
  await page.reload();
  await page.getByRole("button", { name: /Open local folder|打开本地文件夹/i }).first().click();
  await page.getByRole("button", { name: "Workbench", exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector("#projectList .thread")?.checkVisibility() === true && !document.querySelector("#projectList")?.closest("[inert]"), undefined, { timeout: 30_000 });
  await page.evaluate(() => {
    for (const button of document.querySelectorAll("#projectList button")) if (/Expand|展开/.test(button.textContent ?? "")) button.click();
  });
  await page.waitForFunction(title => [...document.querySelectorAll("#projectList .thread")].some(row => row.textContent?.includes(title)), fixture.sessions[smoke ? 3 : 13].title);
  report.runtime = (await query("environment.get")).runtime;
  if (report.runtime.status === "connected") throw new Error("Offline test unexpectedly connected a Runtime; no switching measurements were taken");
  report.catalogTotal = (await query("history.list", { limit: 1 })).total;
  report.viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio }));
  report.gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus());
  report.gpuInfo = await app.evaluate(async ({ app }) => {
    const info = await app.getGPUInfo("complete");
    return { devices: (info.gpuDevice ?? []).map(device => ({ active: device.active, vendorId: device.vendorId, deviceId: device.deviceId, driverVendor: device.driverVendor, driverVersion: device.driverVersion })),
      renderer: info.auxAttributes?.glRenderer, vendor: info.auxAttributes?.glVendor, softwareRendering: info.auxAttributes?.softwareRendering };
  });
  await page.bringToFront();
  await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) { window.show(); window.focus(); } });
  interval = setInterval(() => { void sample(); }, 1000);
  await select(0);
  await page.screenshot({ path: join(output, "native-initial.png") });
  await runPhase("idle-before", async () => { await pause(smoke ? 2000 : 20_000); });
  await runPhase("cold-sequential", async entry => {
    for (let index = 1; index <= (smoke ? 3 : 12); index++) { entry.steps.push(await select(index)); await pause(smoke ? 100 : 600); }
  });
  await runPhase("warm-alternating", async entry => {
    for (let index = 0; index < (smoke ? 4 : 24); index++) { entry.steps.push(await select(index % 2)); await pause(smoke ? 100 : 400); }
  });
  if (!smoke) {
    await runPhase("rapid-switching", async entry => {
      for (let index = 0; index < 36; index++) { entry.steps.push(await select(index % 12, { wait: false })); await pause(70); }
      entry.steps.push(await select(13));
      await pause(2000);
    });
    await runPhase("idle-after", async () => { await pause(45_000); });
  }
  report.finalCounters = await page.evaluate(() => window.ompSessionPerf.snapshot(true).counters);
  if (report.finalCounters["engines.active"] !== 1 || report.finalCounters["real.mountedDocuments"] !== 1 || report.finalCounters["real.detachedNodes"] !== 0) throw new Error("Native residency regression: expected one mounted engine and no detached conversation nodes");
  await page.screenshot({ path: join(output, "native-final.png") });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: join(output, "native-failure.png") }).catch(() => {});
    report.failureUi = (await page.locator("body").innerText().catch(() => "")).slice(0, 7000);
    report.failureState = await page.evaluate(() => ({ recording: window.ompSessionPerf?.snapshot(true),
      bodies: [...document.querySelectorAll(".convo-body")].map(body => ({ phase: body.getAttribute("data-phase"), connected: body.isConnected, rect: { width: body.getBoundingClientRect().width, height: body.getBoundingClientRect().height }, items: body.querySelectorAll("[data-item-id]").length, tailText: body.textContent.slice(-500) })),
      activeRows: [...document.querySelectorAll("#projectList .thread.active")].map(row => row.textContent) })).catch(() => null);
  }
  process.exitCode = 1;
} finally {
  clearInterval(interval);
  if (page && !page.isClosed()) await sample();
  const closing = app; app = undefined;
  if (closing) await closing.close().catch(error => { report.warnings.push(`Close: ${String(error).slice(0, 200)}`); });
  if (samplerDone) {
    report.processSampler = await samplerDone;
    if (report.processSampler.code !== 0) { report.status = "failed"; report.failure ??= "Windows process recording failed"; process.exitCode = 1; }
  }
  report.finishedAtUnixMs = Date.now();
  await save();
  console.log(JSON.stringify({ status: report.status, output, failure: report.failure, samples: report.samples.length, errors: report.errors.length }));
}
