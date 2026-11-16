/** Unprivileged supervisor for a package-manager update. The privileged helper
 * stays alive only until the restarted desktop confirms its startup. */
export interface LinuxDebSwapPlan {
  readonly pid: number;
  readonly target: string;
  readonly launchArguments: readonly string[];
  readonly version: string;
  readonly helper: string;
  readonly packagePath: string;
  readonly catalogPath: string;
  readonly previousPath: string;
  readonly previousCatalogPath: string;
  readonly ready: string;
  readonly outcome: string;
  readonly started: string;
  readonly healthy: string;
  readonly cleanExit: string;
  readonly control: string;
  readonly pollMs: number;
  readonly exitTimeoutMs: number;
  readonly startTimeoutMs: number;
}

export interface LinuxDebSwapDeps {
  authorize(): Promise<void>;
  install(): Promise<void>;
  finish(action: "commit" | "rollback" | "cancel"): Promise<void>;
  signalReady(status: "ready" | "failed", message?: string): void;
  outcome(status: "installed" | "rolled-back" | "failed" | "unconfirmed", message?: string): void;
  exists(path: string): boolean;
  read(path: string): string | undefined;
  alive(pid: number): boolean;
  launch(path: string): number;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Self-contained so it can run in the detached Electron-as-Node supervisor. */
export async function runLinuxDebSwap(plan: LinuxDebSwapPlan, deps: LinuxDebSwapDeps): Promise<void> {
  try { await deps.authorize(); }
  catch (error) { deps.signalReady("failed", String(error)); return; }
  if (!deps.exists(plan.control)) { await deps.finish("cancel"); return; }
  deps.signalReady("ready");
  const exitDeadline = deps.now() + plan.exitTimeoutMs;
  while (deps.alive(plan.pid)) {
    if (deps.now() >= exitDeadline) {
      try { await deps.finish("cancel"); deps.outcome("failed", "The previous application did not exit; the update was cancelled"); }
      catch (error) { deps.outcome("failed", String(error)); }
      return;
    }
    await deps.sleep(plan.pollMs);
  }
  if (!deps.exists(plan.control)) { await deps.finish("cancel"); return; }
  try { await deps.install(); }
  catch (error) { deps.outcome("failed", String(error)); deps.launch(plan.target); return; }
  const child = deps.launch(plan.target);
  const deadline = deps.now() + plan.startTimeoutMs;
  let startedPid = 0;
  while (deps.now() < deadline) {
    if (deps.exists(plan.healthy)) {
      await deps.finish("commit"); deps.outcome("installed"); return;
    }
    const started = Number(deps.read(plan.started));
    if (Number.isSafeInteger(started) && started > 0) startedPid = started;
    if (deps.exists(plan.cleanExit)) {
      await deps.finish("commit"); deps.outcome("unconfirmed"); return;
    }
    if (!deps.alive(startedPid || child)) break;
    await deps.sleep(plan.pollMs);
  }
  if (deps.exists(plan.healthy)) { await deps.finish("commit"); deps.outcome("installed"); return; }
  if (deps.alive(startedPid || child)) { await deps.finish("commit"); deps.outcome("unconfirmed"); return; }
  try {
    await deps.finish("rollback");
    deps.outcome("rolled-back", "The new version failed to start; restored the previous package");
    deps.launch(plan.target);
  } catch (error) { deps.outcome("failed", String(error)); }
}

/** All dependencies used by the serialized supervisor are loaded here. */
export function nodeLinuxDebSwapDeps(require: (id: string) => unknown, plan: LinuxDebSwapPlan): LinuxDebSwapDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const { createInterface } = require("node:readline") as typeof import("node:readline");
  let child: import("node:child_process").ChildProcessWithoutNullStreams;
  let finished: Promise<void>, installed: Promise<void>;
  const write = (path: string, value: unknown) => {
    const temporary = `${path}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, path);
  };
  return {
    authorize: () => new Promise<void>((resolve, reject) => {
      let settled = false, installSettled = false, stderr = "";
      let resolveInstalled!: () => void, rejectInstalled!: (error: Error) => void;
      installed = new Promise<void>((done, fail) => { resolveInstalled = done; rejectInstalled = fail; });
      void installed.catch(() => {});
      const args = [plan.helper, plan.packagePath, plan.catalogPath, plan.previousPath, plan.previousCatalogPath];
      child = spawn("/usr/bin/pkexec", args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.on("error", () => {});
      child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        if (line === "AUTHORIZED" && !settled) { settled = true; resolve(); }
        else if (line === "INSTALLED" && !installSettled) { installSettled = true; resolveInstalled(); }
        else if (line === "ROLLED_BACK" && !installSettled) { installSettled = true; rejectInstalled(new Error("Package installation failed; the previous package was restored")); }
      });
      finished = new Promise<void>((done, fail) => {
        child.once("error", error => { if (!settled) { settled = true; reject(error); } if (!installSettled) { installSettled = true; rejectInstalled(error); } fail(error); });
        child.once("close", code => {
          if (code === 0) {
            const error = new Error("Package helper exited before completing the requested operation");
            if (!settled) { settled = true; reject(error); }
            if (!installSettled) { installSettled = true; rejectInstalled(error); }
            done();
          }
          else {
            const error = new Error(stderr.trim() || `Package authorization or installation failed (${code})`);
            if (!settled) { settled = true; reject(error); }
            if (!installSettled) { installSettled = true; rejectInstalled(error); }
            fail(error);
          }
        });
      });
      void finished.catch(() => {});
    }),
    install: async () => { child.stdin.write("install\n"); await installed; },
    finish: async action => { child.stdin.end(`${action}\n`); await finished; },
    signalReady: (status, message) => write(plan.ready, { status, ...(message ? { message } : {}) }),
    outcome: (status, message) => write(plan.outcome, { status, version: plan.version, ...(message ? { message } : {}) }),
    exists: path => fs.existsSync(path),
    read: path => { try { return fs.readFileSync(path, "utf8"); } catch { return undefined; } },
    alive: pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
    launch: path => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const app = spawn(path, [...plan.launchArguments], { detached: true, stdio: "ignore", env });
      app.on("error", () => {}); app.unref(); return app.pid ?? 0;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export function linuxDebSwapHelperSource(): string {
  return [
    '"use strict";',
    `const runLinuxDebSwap = ${runLinuxDebSwap.toString()};`,
    `const nodeLinuxDebSwapDeps = ${nodeLinuxDebSwapDeps.toString()};`,
    'const fs = require("node:fs");',
    'const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
    'const deps = nodeLinuxDebSwapDeps(require, plan);',
    'runLinuxDebSwap(plan, deps).catch(error => { try { deps.signalReady("failed", String(error)); deps.outcome("failed", String(error)); } catch {} }).finally(() => { for (const path of [plan.control, plan.catalogPath, plan.previousCatalogPath]) { try { fs.rmSync(path, { force: true }); } catch {} } try { if (JSON.parse(fs.readFileSync(process.argv[2], "utf8")).control === plan.control) fs.rmSync(process.argv[2], { force: true }); } catch {} });',
    "",
  ].join("\n");
}
