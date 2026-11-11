// Exercise the installed PTY binary under the actual Electron ABI in an isolated profile.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const output = path.resolve(__dirname, "../output/playwright/review-data");
if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit", windowsHide: true, timeout: 60000 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app } = require("electron");
fs.mkdirSync(path.join(output, "native-terminal-profile"), { recursive: true });
app.setPath("userData", path.join(output, "native-terminal-profile"));
app.on("window-all-closed", () => {});
async function run() {
  await app.whenReady();
  const started = Date.now();
  const pty = require("node-pty");
  const result = await new Promise((resolve, reject) => {
    const terminal = pty.spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::WriteLine('OMP_STUDIO_PTY_OK')"],
      { cwd: output, cols: 80, rows: 24, useConpty: true });
    let data = "";
    const timer = setTimeout(() => { terminal.kill(); reject(new Error("Native PTY timed out")); }, 20000);
    terminal.onData(chunk => { data += chunk; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !data.includes("OMP_STUDIO_PTY_OK")) reject(new Error(`Native PTY failed: ${exitCode}`));
      else resolve({ exitCode, markerReceived: true, outputBytes: Buffer.byteLength(data), elapsedMs: Date.now() - started });
    });
  });
  const report = { electron: process.versions.electron, node: process.versions.node, backend: "ConPTY", ...result };
  const file = path.join(output, "terminal-native.json");
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ file, ...report }, null, 2));
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
