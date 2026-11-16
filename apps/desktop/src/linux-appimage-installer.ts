import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeVersion, writeJsonAtomic, type ComponentRelease } from "@omp-studio/runtime-installer";
import { isVerifiedFile } from "./differential-artifact.js";
import { desktopText } from "./desktop-language-shared.js";
import { macSwapPaths, type MacSwapOutcome } from "./mac-app-swap.js";

const helperSource = `#!/bin/sh
pid="$1"; target="$2"; staged="$3"; backup="$4"; plan="$5"; outcome="$6"; started="$7"; healthy="$8"; clean="$9"
shift 9
version="$1"
rollback="$2"
shift 2
finish() { printf '{"status":"%s","version":"%s"}\\n' "$1" "$version" > "$outcome.tmp" && mv -f "$outcome.tmp" "$outcome"; if [ "$1" != unconfirmed ]; then rm -f "$plan"; fi; }
launch() { "$target" "$@" >/dev/null 2>&1 & }
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); if [ "$i" -ge 120 ]; then rm -f "$staged"; finish failed; exit 1; fi
  sleep 0.5
done
rm -f "$started" "$healthy" "$clean"
if ! mv "$target" "$backup"; then rm -f "$staged"; finish failed; launch "$@"; exit 1; fi
if ! mv "$staged" "$target"; then mv "$backup" "$target"; rm -f "$staged"; finish failed; launch "$@"; exit 1; fi
launch "$@"
child=$!
i=0
while [ "$i" -lt 3600 ]; do
  if [ -f "$healthy" ]; then rm -f "$backup"; finish installed; exit 0; fi
  # Older AppImages do not write startup markers. When explicitly restoring
  # one, keep the swap if its process has remained alive for ten seconds.
  if [ "$rollback" = 1 ] && [ "$i" -ge 20 ] && kill -0 "$child" 2>/dev/null; then rm -f "$backup"; finish installed; exit 0; fi
  if ! kill -0 "$child" 2>/dev/null; then
    if [ -f "$healthy" ]; then continue; fi
    if [ -f "$clean" ]; then finish unconfirmed; exit 0; fi
    if mv "$backup" "$target"; then finish rolled-back; launch "$@"; exit 1; fi
    finish failed; exit 1
  fi
  i=$((i+1)); sleep 0.5
done
finish unconfirmed
`;

export interface LinuxAppImageInstallerOptions {
  readonly target: string;
  readonly swapDirectory: string;
  readonly pid: number;
  readonly launchArguments?: readonly string[];
  readonly spawnHelper?: (helper: string, args: readonly string[]) => Promise<void>;
}

export class LinuxAppImageInstaller {
  constructor(private readonly options: LinuxAppImageInstallerOptions) {}

  async preflight(requiredBytes = 0): Promise<string | undefined> {
    const parent = dirname(this.options.target);
    try {
      await access(parent, constants.W_OK);
      await access(this.options.target, constants.R_OK | constants.X_OK);
      const space = await statfs(parent);
      if (Number(space.bavail) * Number(space.bsize) < requiredBytes) {
        return desktopText("AppImage 所在磁盘空间不足，无法自动更新", "Insufficient disk space to update the AppImage");
      }
      return undefined;
    } catch {
      return desktopText("无法替换当前 AppImage，请将它移到可写目录后重试", "Cannot replace the current AppImage; move it to a writable directory and try again");
    }
  }

  async install(path: string, release: ComponentRelease, rollback = false): Promise<void> {
    assertSafeVersion(release.version);
    const reason = await this.preflight(release.file.size);
    if (reason) throw new Error(reason);
    const { target, swapDirectory } = this.options;
    const id = randomUUID();
    const staged = join(dirname(target), `.omp-studio-update-${id}`);
    const backup = join(dirname(target), `.omp-studio-previous-${id}`);
    const paths = macSwapPaths(swapDirectory);
    await mkdir(swapDirectory, { recursive: true });
    try {
      await copyFile(path, staged);
      if (!await isVerifiedFile(staged, release.file)) throw new Error("Staged AppImage checksum mismatch");
      await chmod(staged, (await stat(target)).mode & 0o777);
      for (const stale of [paths.started, paths.healthy, paths.cleanExit, paths.outcome]) await rm(stale, { force: true });
      await writeFile(paths.helper, helperSource, { mode: 0o700 });
      await writeJsonAtomic(paths.plan, { schema: 1, version: release.version, target, backup, markers: { started: paths.started, healthy: paths.healthy, cleanExit: paths.cleanExit } });
      const args = [String(this.options.pid), target, staged, backup, paths.plan, paths.outcome, paths.started, paths.healthy, paths.cleanExit, release.version, rollback ? "1" : "0", ...(this.options.launchArguments ?? ["--omp-restarted"])];
      if (this.options.spawnHelper) await this.options.spawnHelper(paths.helper, args);
      else await new Promise<void>((resolve, reject) => {
        const env = { ...process.env };
        const mountedDirectory = env.APPDIR;
        if (mountedDirectory) for (const name of ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"]) {
          if (env[name]) env[name] = env[name]!.split(":").filter(part => part !== mountedDirectory && !part.startsWith(`${mountedDirectory}/`)).join(":");
        }
        for (const name of ["APPIMAGE", "APPDIR", "ARGV0", "OWD", "ELECTRON_RUN_AS_NODE"]) delete env[name];
        const child = spawn("/bin/sh", [paths.helper, ...args], { detached: true, stdio: "ignore", env });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
    } catch (error) {
      await rm(staged, { force: true });
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
      if (outcome.status === "failed") return { ...outcome, message: desktopText("AppImage 更新失败，请重试或手动安装", "AppImage update failed; retry or install it manually") };
      return outcome;
    } catch { return undefined; }
  }

  /** A clean exit before confirmation leaves the old image until a healthy start. */
  async cleanup(version: string): Promise<void> {
    const path = macSwapPaths(this.options.swapDirectory).plan;
    try {
      const plan = JSON.parse(await readFile(path, "utf8")) as { target?: string; backup?: string; version?: string };
      if (plan.version !== version || plan.target !== this.options.target || !plan.backup || dirname(plan.backup) !== dirname(this.options.target) || !basename(plan.backup).startsWith(".omp-studio-previous-")) return;
      await rm(plan.backup, { force: true });
      await rm(path, { force: true });
    } catch { /* The helper may have completed cleanup already. */ }
  }
}
