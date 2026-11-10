import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPackage } from "@electron/asar";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);

test("Electron can launch the production archive Worker from an asar package", { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), "studio-worker-asar-")), source = join(temporary, "app"), sessionsRoot = join(temporary, "sessions");
  const packages = join(source, "node_modules", "@omp-studio");
  const host = join(packages, "studio-host");
  await mkdir(join(host, "dist", "src"), { recursive: true }); await mkdir(sessionsRoot);
  for (const name of ["session-archive-pool", "session-archive-worker", "session-archive-reader", "session-catalog", "gzip-file", "workspace-path", "shared-read"]) {
    await cp(join(root, "packages/studio-host/dist/src", `${name}.js`), join(host, "dist/src", `${name}.js`));
  }
  await writeFile(join(host, "package.json"), JSON.stringify({ type: "module" }));
  await cp(join(root, "packages/studio-protocol"), join(packages, "studio-protocol"), { recursive: true, filter: path => !/[\\/]node_modules(?:[\\/]|$)/.test(path) && !/[\\/]test(?:[\\/]|$)/.test(path) });
  await writeFile(join(sessionsRoot, "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "asar", cwd: temporary }) + "\n" + JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "Packaged archive" } }) + "\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ name: "studio-worker-asar-test", version: "1.0.0", type: "module", main: "bootstrap.cjs" }));
  await writeFile(join(source, "bootstrap.cjs"), `const {app}=require("electron");app.setPath("userData",${JSON.stringify(join(temporary, "profile"))});app.whenReady().then(()=>import("./main.mjs")).catch(e=>{console.error(e);app.exit(1)});`);
  await writeFile(join(source, "main.mjs"), `
import {app} from "electron";
import {SessionArchiveWorkerPool} from "./node_modules/@omp-studio/studio-host/dist/src/session-archive-pool.js";
app.setPath("userData", ${JSON.stringify(join(temporary, "profile"))});
await app.whenReady();
const pool = new SessionArchiveWorkerPool({sessionsRoot:${JSON.stringify(sessionsRoot)},archiveRoot:${JSON.stringify(join(temporary, "archive"))}});
try { const page = await pool.reader(${JSON.stringify(temporary)}).readPage({sessionId:"asar"}); if(page.items.length!==1)throw Error("Missing packaged transcript"); console.log("ARCHIVE_ASAR_OK"); }
catch(error){console.error(error);process.exitCode=1;}
finally { await pool.dispose(); app.exit(process.exitCode ?? 0); }
`);
  const archive = join(temporary, "app.asar"); await createPackage(source, archive);
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
  const output = await new Promise((resolve, reject) => {
    const child = spawn(require("electron"), [archive], { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`ASAR Worker timed out: ${output}`)); }, 20_000);
    child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(output)); });
  });
  assert.match(output, /ARCHIVE_ASAR_OK/);
});
