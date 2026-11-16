import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { writeJsonAtomic, type ComponentRelease, type SignedUpdateManifest } from "@omp-studio/runtime-installer";
import { desktopText } from "./desktop-language-shared.js";
import { isVerifiedFile } from "./differential-artifact.js";
import { macSwapPaths, type MacSwapOutcome } from "./mac-app-swap.js";
import { linuxDebSwapHelperSource, type LinuxDebSwapPlan } from "./linux-deb-swap.js";

const DEB_EXECUTABLE = "/opt/OMP Studio/omp-studio";

export async function isLinuxDebInstallation(executable: string, version: string): Promise<boolean> {
  if (executable !== DEB_EXECUTABLE) return false;
  return new Promise(resolve => {
    execFile("/usr/bin/dpkg-query", ["-W", "-f=${db:Status-Status} ${Version}", "omp-studio"], (error, stdout) => resolve(!error && stdout.trim() === `installed ${version}`));
  });
}

export interface LinuxDebInstallerOptions {
  readonly target: string;
  readonly swapDirectory: string;
  readonly resourcesPath: string;
  readonly pid: number;
  readonly launchArguments?: readonly string[];
  readonly spawnHelper?: (script: string, plan: string) => Promise<void>;
  readonly waitForReady?: (path: string) => Promise<{ status: string; message?: string }>;
}

export class LinuxDebInstaller {
  constructor(private readonly options: LinuxDebInstallerOptions) {}

  async preflight(): Promise<string | undefined> {
    try {
      for (const file of ["/usr/bin/pkexec", "/usr/bin/python3", "/usr/bin/openssl", "/usr/bin/apt-get", join(this.options.resourcesPath, "omp-deb-update")]) await access(file, constants.X_OK);
    } catch {
      return desktopText("缺少系统更新组件，请安装 pkexec、Python 3、OpenSSL 和 apt 后重试", "System update components are missing; install pkexec, Python 3, OpenSSL and apt, then retry");
    }
    try {
      if (this.options.target !== DEB_EXECUTABLE || this.options.resourcesPath !== join(dirname(DEB_EXECUTABLE), "resources")) throw new Error("Unexpected package location");
      for (const file of ["/opt", dirname(DEB_EXECUTABLE), this.options.resourcesPath, join(this.options.resourcesPath, "omp-deb-update"), join(this.options.resourcesPath, "runtime-keys"), join(this.options.resourcesPath, "runtime-keys", "trusted-keys.json")]) {
        const info = await lstat(file);
        if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("Untrusted system package files");
      }
      return undefined;
    } catch {
      return desktopText("系统安装文件的所有者或权限异常，请通过系统包管理器重新安装", "System installation files have unexpected ownership or permissions; reinstall using the system package manager");
    }
  }

  async install(path: string, release: ComponentRelease, _rollback: boolean, envelope: SignedUpdateManifest, previous?: { path: string; envelope: SignedUpdateManifest }): Promise<void> {
    const reason = await this.preflight();
    if (reason) throw new Error(reason);
    if (!previous?.envelope.manifest.app || !await isVerifiedFile(path, release.file) || !await isVerifiedFile(previous.path, previous.envelope.manifest.app.file)) {
      throw new Error(desktopText("更新包或恢复包校验失败，请重新下载", "The update or recovery package failed verification; download it again"));
    }
    const paths = macSwapPaths(this.options.swapDirectory);
    await mkdir(this.options.swapDirectory, { recursive: true });
    const id = randomUUID();
    const ready = join(this.options.swapDirectory, `ready-${id}.json`);
    const control = join(this.options.swapDirectory, `control-${id}`);
    const catalogPath = join(this.options.swapDirectory, `target-catalog-${id}.json`);
    const previousCatalogPath = join(this.options.swapDirectory, `previous-catalog-${id}.json`);
    for (const stale of [paths.started, paths.healthy, paths.cleanExit, paths.outcome, ready]) await rm(stale, { force: true });
    await writeJsonAtomic(catalogPath, envelope);
    await writeJsonAtomic(previousCatalogPath, previous.envelope);
    await writeFile(control, "");
    await writeFile(paths.helper, linuxDebSwapHelperSource(), "utf8");
    const plan: LinuxDebSwapPlan & { schema: 1; markers: { started: string; healthy: string; cleanExit: string } } = {
      schema: 1, pid: this.options.pid, target: this.options.target, version: release.version,
      launchArguments: this.options.launchArguments ?? ["--omp-restarted"],
      helper: join(this.options.resourcesPath, "omp-deb-update"), packagePath: path, catalogPath,
      previousPath: previous.path, previousCatalogPath, ready, outcome: paths.outcome,
      started: paths.started, healthy: paths.healthy, cleanExit: paths.cleanExit,
      control,
      markers: { started: paths.started, healthy: paths.healthy, cleanExit: paths.cleanExit },
      pollMs: 500, exitTimeoutMs: 60_000, startTimeoutMs: 120_000,
    };
    await writeJsonAtomic(paths.plan, plan);
    let helperExited = false;
    try {
      if (this.options.spawnHelper) await this.options.spawnHelper(paths.helper, paths.plan);
      else await new Promise<void>((resolve, reject) => {
        const child = spawn(this.options.target, [paths.helper, paths.plan], { detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
        child.once("error", reject);
        child.once("exit", () => { helperExited = true; });
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      const waitForReady = this.options.waitForReady ?? (async (file: string) => {
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
          try { return JSON.parse(await readFile(file, "utf8")) as { status: string; message?: string }; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          if (helperExited) throw new Error(desktopText("更新助手意外退出，请重试", "The update helper exited unexpectedly; try again"));
          await sleep(250);
        }
        throw new Error(desktopText("等待系统授权超时，请重试", "System authorization timed out; try again"));
      });
      const result = await waitForReady(ready);
      if (result.status !== "ready") throw new Error(desktopText("系统授权被取消或更新包校验失败", "System authorization was cancelled or the update package could not be verified") + (result.message ? `: ${result.message}` : ""));
    } catch (error) {
      await rm(control, { force: true });
      await rm(paths.plan, { force: true });
      throw error;
    }
  }

  async consumeOutcome(): Promise<MacSwapOutcome | undefined> {
    const path = macSwapPaths(this.options.swapDirectory).outcome;
    try {
      const outcome = JSON.parse(await readFile(path, "utf8")) as MacSwapOutcome;
      await rm(path, { force: true });
      if (outcome.status === "rolled-back") return { ...outcome, message: desktopText("新版本启动失败，已恢复上一版本", "The new version failed to start; restored the previous version") };
      if (outcome.status === "failed") return { ...outcome, message: desktopText("deb 更新未完成，请重试或通过系统包管理器恢复", "The deb update did not complete; retry or recover through the system package manager") + (outcome.message ? `: ${outcome.message}` : "") };
      return outcome;
    } catch { return undefined; }
  }
}
