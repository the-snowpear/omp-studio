import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const root = process.cwd();
const previewHost = "127.0.0.1";
const previewPort = process.env.OMP_PREVIEW_PORT ?? "5173";
const previewUrl = `http://${previewHost}:${previewPort}`;
const npmCli = process.env.OMP_NPM_CLI ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const esbuildCli = join(
  root,
  "node_modules",
  "esbuild",
  "bin",
  "esbuild",
);

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let stopping = false;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  children.push(child);
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  if (process.platform === "darwin" && child.pid !== undefined) {
    child.kill("SIGTERM");
    return;
  }
  child.kill("SIGTERM");
}

async function cleanup() {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map((child) => stopChild(child)));
}

async function waitForRenderer(child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Renderer dev server exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(previewUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Renderer did not become ready at ${previewUrl}`);
}

async function main() {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    throw new Error("The current preview launcher supports Windows and macOS Electron builds.");
  }
  if (!existsSync(esbuildCli) || !existsSync(join(root, "node_modules", "electron", "package.json"))) {
    throw new Error("Dependencies are missing. Run `npm install` once, then retry.");
  }

  console.log("[preview] Building workspace...");
  await run(process.execPath, [npmCli, "run", "build"]);

  console.log("[preview] Bundling sandboxed preload...");
  await run(process.execPath, [esbuildCli, 
    "apps/desktop/src/preload.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--external:electron",
    "--outfile=apps/desktop/dist/preload.cjs",
  ]);

  console.log(`[preview] Starting Renderer at ${previewUrl}...`);
  const renderer = start(process.execPath, [npmCli,
    "run",
    "dev",
    "-w",
    "@omp-studio/renderer",
    "--",
    "--host",
    previewHost,
    "--port",
    previewPort,
    "--strictPort",
  ]);
  await waitForRenderer(renderer);

  console.log("[preview] Opening OMP Studio Desktop...");
  const desktop = start(process.execPath, [npmCli, "run", "dev", "-w", "@omp-studio/desktop"], {
    env: { ...process.env, OMP_RENDERER_DEV_URL: previewUrl },
  });

  const exitCode = await new Promise((resolve, reject) => {
    desktop.once("error", reject);
    desktop.once("exit", (code) => resolve(code ?? 1));
  });
  await cleanup();
  process.exitCode = exitCode;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanup().finally(() => {
      process.exitCode = 130;
    });
  });
}

main().catch(async (error) => {
  console.error(`[preview] ${error instanceof Error ? error.message : String(error)}`);
  await cleanup();
  process.exitCode = 1;
});
