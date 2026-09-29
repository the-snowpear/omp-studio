/**
 * macOS desktop update: the swap a detached helper performs after the app
 * quits.
 *
 * A signed bundle is never modified in place: Apple Silicon kills a signed
 * binary that is overwritten. The update is instead two renames in the
 * bundle's own folder (current → backup, staged → current), and the new
 * version then has to prove itself:
 *
 * - it writes `started` as soon as its main process runs;
 * - `healthy` once its renderer has booted;
 * - `clean-exit` when it quits normally.
 *
 * The helper puts the backup back when `started` never appears, or when the
 * new process ends with neither `healthy` nor `clean-exit`. Quitting a
 * started version before it turns healthy is the user's choice, not a
 * failure: the next launch confirms it.
 *
 * `runMacAppSwap` executes inside the helper from its own source text
 * (`macSwapHelperSource`), so it must stay self-contained: no imports and no
 * module-level references; everything arrives through `plan` and `deps`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface MacSwapPlan {
  readonly schema: 1;
  /** The quitting app. */
  readonly pid: number;
  /** The installed bundle, e.g. /Applications/OMP Studio.app. */
  readonly target: string;
  /** The verified new bundle, inside `stagingRoot`. */
  readonly staged: string;
  /** Hidden folder next to `target` that holds `staged`. */
  readonly stagingRoot: string;
  /** Hidden name next to `target` for the old bundle while the new one proves itself. */
  readonly backup: string;
  readonly version: string;
  readonly markers: { readonly started: string; readonly healthy: string; readonly cleanExit: string };
  readonly outcome: string;
  readonly waitForExitMs: number;
  readonly startTimeoutMs: number;
  readonly monitorMs: number;
  readonly pollMs: number;
}

export type MacSwapStatus = "installed" | "rolled-back" | "failed" | "unconfirmed";

export interface MacSwapOutcome {
  readonly status: MacSwapStatus;
  readonly version: string;
  readonly message?: string;
}

export interface MacSwapDeps {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
  /** Recursive and forced. */
  remove(path: string): void;
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Launches the bundle through LaunchServices. */
  open(app: string): void;
  log(line: string): void;
}

export async function runMacAppSwap(plan: MacSwapPlan, deps: MacSwapDeps): Promise<MacSwapOutcome> {
  const describe = (error: unknown): string =>
    error !== null && typeof error === "object" && "message" in error ? String((error as { message: unknown }).message) : String(error);
  const denied = (error: unknown): boolean => {
    const code = error !== null && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
    return code === "EPERM" || code === "EACCES";
  };
  const finish = (outcome: MacSwapOutcome): MacSwapOutcome => {
    deps.writeText(plan.outcome, JSON.stringify(outcome));
    deps.log(`${outcome.status} ${outcome.version}${outcome.message ? `: ${outcome.message}` : ""}`);
    return outcome;
  };
  const discardStaging = (): void => {
    try { deps.remove(plan.stagingRoot); } catch { /* A leftover folder is cleaned up at the next confirmed start. */ }
  };
  const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/"));
  const manualInstall = "请从发布页下载 dmg 手动安装。";

  const parent = parentOf(plan.target);
  if (!plan.target.endsWith(".app") || parentOf(plan.backup) !== parent || parentOf(plan.stagingRoot) !== parent || parentOf(plan.staged) !== plan.stagingRoot) {
    return finish({ status: "failed", version: plan.version, message: "更新计划无效，已取消" });
  }

  // The bundle may only move once the app that runs from it is gone.
  const exitDeadline = deps.now() + plan.waitForExitMs;
  while (deps.isAlive(plan.pid)) {
    if (deps.now() >= exitDeadline) {
      discardStaging();
      return finish({ status: "failed", version: plan.version, message: "OMP Studio 没有退出，更新已取消" });
    }
    await deps.sleep(plan.pollMs);
  }
  for (const marker of [plan.markers.started, plan.markers.healthy, plan.markers.cleanExit]) {
    try { deps.remove(marker); } catch { /* Absent. */ }
  }

  try {
    deps.rename(plan.target, plan.backup);
  } catch (error) {
    discardStaging();
    const outcome = finish({
      status: "failed",
      version: plan.version,
      message: denied(error)
        ? `macOS 不允许替换应用（系统设置 › 隐私与安全性 › App 管理）。${manualInstall}`
        : `无法替换应用：${describe(error)}。${manualInstall}`,
    });
    deps.open(plan.target);
    return outcome;
  }
  try {
    deps.rename(plan.staged, plan.target);
  } catch (error) {
    try {
      deps.rename(plan.backup, plan.target);
    } catch (restoreError) {
      return finish({ status: "failed", version: plan.version, message: `更新失败，且无法恢复原应用：${describe(restoreError)}。原应用保留在 ${plan.backup}` });
    }
    discardStaging();
    const outcome = finish({ status: "failed", version: plan.version, message: `无法安装新版本：${describe(error)}。${manualInstall}` });
    deps.open(plan.target);
    return outcome;
  }
  discardStaging();

  const rollBack = (reason: string): MacSwapOutcome => {
    const failed = `${plan.backup}.failed`;
    try {
      deps.rename(plan.target, failed);
    } catch (error) {
      return finish({ status: "failed", version: plan.version, message: `${reason}，但无法恢复上一版本：${describe(error)}` });
    }
    try {
      deps.rename(plan.backup, plan.target);
    } catch (error) {
      try { deps.rename(failed, plan.target); } catch { /* Both copies stay next to the target for manual recovery. */ }
      return finish({ status: "failed", version: plan.version, message: `${reason}，但无法恢复上一版本：${describe(error)}` });
    }
    try { deps.remove(failed); } catch { /* Cleaned up at the next confirmed start. */ }
    const outcome = finish({ status: "rolled-back", version: plan.version, message: `${reason}，已恢复上一版本` });
    deps.open(plan.target);
    return outcome;
  };

  deps.open(plan.target);
  const startDeadline = deps.now() + plan.startTimeoutMs;
  const watchDeadline = deps.now() + plan.monitorMs;
  // undefined: not started yet; 0: started, but its pid is unreadable, so only `healthy` can end the watch.
  let startedPid: number | undefined;
  for (;;) {
    if (deps.exists(plan.markers.healthy)) {
      try { deps.remove(plan.backup); } catch { /* Cleaned up at the next confirmed start. */ }
      return finish({ status: "installed", version: plan.version });
    }
    if (startedPid === undefined) {
      const started = deps.readText(plan.markers.started);
      if (started !== undefined) {
        const pid = Number.parseInt(started.trim(), 10);
        startedPid = Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
      } else if (deps.now() >= startDeadline) {
        return rollBack("新版本没有启动");
      }
    } else if (startedPid > 0 && !deps.isAlive(startedPid)) {
      if (deps.exists(plan.markers.healthy)) continue;
      if (deps.exists(plan.markers.cleanExit)) {
        return finish({ status: "unconfirmed", version: plan.version, message: "新版本在确认前退出，下次启动时完成确认" });
      }
      return rollBack("新版本启动后异常退出");
    }
    if (deps.now() >= watchDeadline) {
      return finish({ status: "unconfirmed", version: plan.version, message: "新版本长时间未完成启动确认" });
    }
    await deps.sleep(plan.pollMs);
  }
}

/**
 * Real dependencies inside the helper process. Serialized with the helper,
 * so it too may only use what it `require`s.
 */
export function nodeMacSwapDeps(require: (id: string) => unknown, logPath: string): MacSwapDeps {
  const fs = require("node:fs") as typeof import("node:fs");
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  return {
    exists: (path) => fs.existsSync(path),
    rename: (from, to) => fs.renameSync(from, to),
    remove: (path) => fs.rmSync(path, { recursive: true, force: true }),
    readText: (path) => {
      try { return fs.readFileSync(path, "utf8"); } catch { return undefined; }
    },
    writeText: (path, text) => {
      const temporary = `${path}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, text, "utf8");
      fs.renameSync(temporary, path);
    },
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    open: (app) => {
      const child = childProcess.spawn("/usr/bin/open", [app, "--args", "--omp-restarted"], { detached: true, stdio: "ignore" });
      child.on("error", () => undefined);
      child.unref();
    },
    log: (line) => {
      try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, "utf8"); } catch { /* Logging never blocks the swap. */ }
    },
  };
}

/** The helper script: run as `ELECTRON_RUN_AS_NODE=1 <execPath> helper.cjs plan.json`. */
export function macSwapHelperSource(): string {
  return [
    "\"use strict\";",
    `const runMacAppSwap = ${runMacAppSwap.toString()};`,
    `const nodeMacSwapDeps = ${nodeMacSwapDeps.toString()};`,
    "const fs = require(\"node:fs\");",
    "const path = require(\"node:path\");",
    "const planPath = process.argv[2];",
    "const deps = nodeMacSwapDeps(require, path.join(path.dirname(planPath), \"helper.log\"));",
    "let plan;",
    "try { plan = JSON.parse(fs.readFileSync(planPath, \"utf8\")); } catch (error) { deps.log(`invalid plan: ${error}`); process.exit(1); }",
    "runMacAppSwap(plan, deps)",
    "  .catch((error) => deps.log(`helper failed: ${error && error.stack ? error.stack : error}`))",
    "  .finally(() => { try { fs.rmSync(planPath, { force: true }); } catch {} });",
    "",
  ].join("\n");
}

export interface MacSwapPaths {
  readonly plan: string;
  readonly helper: string;
  readonly log: string;
  readonly outcome: string;
  readonly started: string;
  readonly healthy: string;
  readonly cleanExit: string;
}

export function macSwapPaths(directory: string): MacSwapPaths {
  return {
    plan: join(directory, "plan.json"),
    helper: join(directory, "helper.cjs"),
    log: join(directory, "helper.log"),
    outcome: join(directory, "outcome.json"),
    started: join(directory, "started"),
    healthy: join(directory, "healthy"),
    cleanExit: join(directory, "clean-exit"),
  };
}

/**
 * Markers the running app writes for a pending swap of exactly this version
 * and this bundle. Synchronous on purpose: `cleanExit` runs while quitting.
 */
export function macSwapMarkers(directory: string, identity: { readonly version: string; readonly bundlePath: string }) {
  const paths = macSwapPaths(directory);
  const active = (): MacSwapPlan | undefined => {
    try {
      const plan = JSON.parse(readFileSync(paths.plan, "utf8")) as MacSwapPlan;
      return plan.schema === 1 && plan.version === identity.version && plan.target === identity.bundlePath ? plan : undefined;
    } catch {
      return undefined;
    }
  };
  const mark = (pick: (plan: MacSwapPlan) => string, text: string): boolean => {
    const plan = active();
    if (plan === undefined) return false;
    try {
      writeFileSync(pick(plan), text, "utf8");
      return true;
    } catch {
      return false;
    }
  };
  return {
    started: (pid: number) => mark((plan) => plan.markers.started, String(pid)),
    healthy: () => mark((plan) => plan.markers.healthy, new Date().toISOString()),
    cleanExit: () => mark((plan) => plan.markers.cleanExit, new Date().toISOString()),
  };
}
