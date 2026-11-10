/** Opt-in Electron activity checks; local pages, isolated profile, no model or user sessions. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const soak = process.argv.includes("--soak");
if (!process.versions.electron) {
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, ...process.argv.slice(2)], {
    env: environment, stdio: "inherit", windowsHide: true, timeout: soak ? 7_600_000 : 240_000,
  });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = require("electron");
const { createServer } = require("node:http");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omp-page-activity-"));
const outputRoot = path.resolve(__dirname, "../outputs/streamline/browser");
fs.mkdirSync(outputRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(outputRoot, soak ? "soak-" : "native-"));
console.log(JSON.stringify({ output }));
app.setPath("userData", temporary);
app.on("window-all-closed", () => {});
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const report = { status: "running", electron: process.versions.electron, started: Date.now(), profile: temporary,
  identity: {
    revision: require("node:child_process").execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(__dirname, ".."), encoding: "utf8", windowsHide: true }).trim(),
    script: digest(__filename),
    manager: digest(path.join(__dirname, "../apps/desktop/dist/src/managed-browser.js")),
    activity: digest(path.join(__dirname, "../apps/desktop/dist/src/managed-browser-activity.js")),
  }, checks: [] };
const save = () => fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
const record = (name, values = {}) => { report.checks.push({ name, ...values }); console.log(name, JSON.stringify(values)); save(); };
async function until(condition, description) {
  for (let attempt = 0; attempt < 160; attempt++) { if (await condition()) return; await delay(50); }
  assert.fail(description);
}
let manager, main, server;
async function run() {
  await app.whenReady();
  server = createServer((request, response) => {
    if (request.url === "/download") {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment; filename=activity.txt" });
      response.write("download started\n");
      const timer = setTimeout(() => response.end("download complete\n"), 35_000);
      response.once("close", () => clearTimeout(timer)); return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><input id="draft"><canvas id="canvas" width="120" height="80"></canvas><video id="video" muted></video><script>window.frameCount=0;window.ticks=0;function draw(){frameCount++;canvas.getContext("2d").fillRect(frameCount%120,0,2,80);requestAnimationFrame(draw)}draw();setInterval(()=>ticks++,10);</script>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  main = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true } });
  await main.loadURL("about:blank"); main.showInactive();
  const { DesktopManagedBrowser } = await import("../apps/desktop/dist/src/managed-browser.js");
  manager = new DesktopManagedBrowser({ directory: path.join(temporary, "browser"), downloadsDirectory: path.join(temporary, "downloads"), windowFor: () => main });
  const page = await manager.create("activity", url, "human");
  const contents = manager.contents(page.id), identity = contents.id;
  await until(() => manager.store.page(page.id).status === "ready", "Fixture did not load");
  const presentation = { sessionId: "activity", surfaceId: "native-activity", pageId: page.id, visible: true, bounds: { x: 0, y: 0, width: 700, height: 500 }, clip: { x: 0, y: 0, width: 700, height: 500 } };
  await manager.present(presentation);
  await contents.executeJavaScript("draft.value='retained';window.retained={value:42}");
  const sample = () => contents.executeJavaScript("({frames:window.frameCount,ticks:window.ticks})");
  const before = await sample(); await delay(1200); const active = await sample();
  assert.ok(active.frames > before.frames);
  await manager.present({ ...presentation, visible: false });
  await delay(31_000);
  assert.equal(contents.getBackgroundThrottling(), true);
  const hidden = await sample(); await delay(1200); const after = await sample();
  record("idle activity sample", { activeFrames: active.frames - before.frames, hiddenFrames: after.frames - hidden.frames, activeTicks: active.ticks - before.ticks, hiddenTicks: after.ticks - hidden.ticks, visibility: await contents.executeJavaScript("document.visibilityState") });
  assert.ok(after.frames - hidden.frames < (active.frames - before.frames) / 2, "Hidden animation did not slow down");
  assert.ok(after.ticks - hidden.ticks < (active.ticks - before.ticks) / 2, "Hidden timers did not slow down");
  assert.equal(await contents.executeJavaScript("draft.value + ':' + retained.value"), "retained:42");
  record("idle throttling retains page state", { activeFrames: active.frames - before.frames, hiddenFrames: after.frames - hidden.frames, activeTicks: active.ticks - before.ticks, hiddenTicks: after.ticks - hidden.ticks });
  const image = await manager.capture(page.id);
  assert.equal(image.isEmpty(), false);
  fs.writeFileSync(path.join(output, "woken-page.png"), image.toPNG());
  assert.equal(contents.getBackgroundThrottling(), false);
  assert.equal(contents.id, identity);
  record("capture wakes the same hidden page");
  contents.debugger.attach("1.3");
  await manager.agentCommand(page.id, "Emulation.setFocusEmulationEnabled", { enabled: true });
  const pending = manager.agentCommand(page.id, "Runtime.evaluate", { expression: "new Promise(resolve=>setTimeout(()=>resolve(retained.value),35000))", awaitPromise: true, returnByValue: true });
  await delay(31_000);
  assert.equal(contents.getBackgroundThrottling(), false);
  assert.equal((await pending).result.value, 42);
  await assert.rejects(manager.agentCommand(page.id, "OMP.invalidCommand"));
  record("long Agent requests remain awake, including failure cleanup");
  await contents.executeJavaScript("video.srcObject=canvas.captureStream(5);video.play()", true);
  await delay(31_000);
  assert.equal(contents.getBackgroundThrottling(), false);
  await contents.executeJavaScript("video.pause();video.srcObject.getTracks().forEach(track=>track.stop())");
  record("hidden media remains active");
  await manager.execute({ sessionId: "activity", action: "settings", settings: { askDownloadLocation: false } });
  contents.downloadURL(url + "/download");
  await until(() => manager.store.state("activity").downloads.length === 1, "Download did not start");
  await delay(31_000);
  assert.equal(contents.getBackgroundThrottling(), false);
  await until(() => manager.store.state("activity").downloads[0].state === "completed", "Download did not finish");
  record("hidden downloads remain active");
  await manager.present(presentation);
  main.minimize();
  await delay(31_000);
  assert.equal(contents.getBackgroundThrottling(), true);
  assert.equal(await contents.executeJavaScript("document.visibilityState"), "hidden", "Agent focus emulation must not keep an idle minimized page visible");
  assert.equal((await manager.capture(page.id)).isEmpty(), false);
  main.restore();
  contents.debugger.detach();
  assert.equal(contents.getBackgroundThrottling(), false);
  record("minimized capture and restore retain the live instance");
  if (soak) {
    const start = Date.now(); let cycle = 0;
    while (Date.now() - start < 7_200_000) {
      await manager.present({ ...presentation, visible: cycle % 4 === 0 });
      if (cycle % 4 === 1) assert.equal((await manager.capture(page.id)).isEmpty(), false);
      if (cycle % 4 === 2) {
        const extra = await manager.create("activity", url, "human");
        await until(() => manager.store.page(extra.id).status === "ready", "Soak page did not load");
        await manager.close("activity", extra.id);
      }
      await delay(35_000);
      assert.equal(contents.id, identity);
      assert.equal(await contents.executeJavaScript("draft.value"), "retained");
      assert.equal(manager.pages("activity").length, 1);
      fs.appendFileSync(path.join(output, "samples.jsonl"), JSON.stringify({ cycle: cycle++, elapsedMs: Date.now() - start, throttled: contents.getBackgroundThrottling(), pages: manager.pages("activity").length, metrics: app.getAppMetrics() }) + "\n");
    }
    record("two-hour browser lifecycle soak", { cycles: cycle, elapsedMs: Date.now() - start });
  }
  await manager.close("activity", page.id);
  assert.equal(manager.contents(page.id), undefined);
  report.status = "passed";
}
run().catch(error => { report.status = "failed"; report.failure = error.stack; console.error(error); }).finally(async () => {
  try { await manager?.dispose(); } finally {
    if (main && !main.isDestroyed()) main.destroy();
    server?.closeAllConnections(); server?.close();
    report.finished = Date.now(); save(); app.exit(report.status === "passed" ? 0 : 1);
  }
});
