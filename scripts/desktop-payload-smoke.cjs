/** Run the real packaged PTY and archive Worker under the matching Electron runtime. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, ...process.argv.slice(2)], { env, stdio: "inherit", windowsHide: true, timeout: 60_000 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app } = require("electron");
const directory = path.resolve(process.argv[2]);
const archive = path.join(directory, "resources", "app.asar");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "omp-packaged-smoke-"));
app.setPath("userData", path.join(temporary, "profile"));
app.on("window-all-closed", () => {});
async function run() {
  await app.whenReady();
  assert.ok(fs.readFileSync(path.join(archive, "dist", "preload.cjs")).length > 0);
  const pty = require(path.join(archive, "node_modules", "node-pty"));
  await new Promise((resolve, reject) => {
    const terminal = pty.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'OMP_PACKAGED_PTY_OK'"], { cwd: temporary, cols: 80, rows: 24 });
    let text = "";
    const timer = setTimeout(() => { terminal.kill(); reject(new Error("Packaged PTY timed out")); }, 20_000);
    terminal.onData(chunk => { text += chunk; });
    terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 && text.includes("OMP_PACKAGED_PTY_OK") ? resolve() : reject(new Error(`Packaged PTY exited ${exitCode}: ${text}`)); });
  });
  console.log("PACKAGED_PTY_OK");
  const sessionsRoot = path.join(temporary, "sessions"); fs.mkdirSync(sessionsRoot);
  fs.writeFileSync(path.join(sessionsRoot, "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "packaged", cwd: temporary }) + "\n" + JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "Packaged archive fixture" } }) + "\n");
  const workerEntry = path.join(archive, "node_modules", "@omp-studio", "studio-host", "dist", "src", "session-archive-pool.js");
  const { SessionArchiveWorkerPool } = await import(pathToFileURL(workerEntry).href);
  const pool = new SessionArchiveWorkerPool({ sessionsRoot, archiveRoot: path.join(temporary, "archive") });
  try { assert.equal((await pool.reader(temporary).readPage({ sessionId: "packaged" })).items.length, 1); }
  finally { await pool.dispose(); }
  console.log("PACKAGED_ARCHIVE_WORKER_OK");
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
