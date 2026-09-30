/**
 * macOS desktop update install: stage and verify the new bundle next to the
 * installed one, then hand the swap to a detached helper (`mac-app-swap.ts`)
 * that runs after this process quits.
 *
 * The update zip is unpacked with `ditto --noqtn` rather than a Node zip
 * library: those break the symlinks inside Electron's frameworks, and the
 * bundle then shows as "damaged". Staging lives in a hidden folder beside the
 * target so both renames stay on one volume and are atomic.
 *
 * No Electron imports: every process, file and clock dependency is injectable.
 */
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, open, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeJsonAtomic, type ComponentRelease } from "@omp-studio/runtime-installer";

import { macSwapHelperSource, macSwapPaths, type MacSwapOutcome, type MacSwapPlan, type MacSwapStatus } from "./mac-app-swap.js";

export type RunFile = (file: string, args: readonly string[]) => Promise<string>;
export type SpawnHelper = (execPath: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

export interface MacAppInstallerOptions {
  /** The running bundle, e.g. /Applications/OMP Studio.app. */
  readonly bundlePath: string;
  /** Private folder for the swap plan, markers, outcome and helper log. */
  readonly swapDirectory: string;
  readonly appId: string;
  /** The Electron binary; the helper runs it as Node. */
  readonly execPath: string;
  readonly pid: number;
  readonly run?: RunFile;
  readonly spawnHelper?: SpawnHelper;
  readonly freeBytes?: (path: string) => Promise<number>;
  readonly timing?: Partial<Pick<MacSwapPlan, "waitForExitMs" | "startTimeoutMs" | "monitorMs" | "pollMs">>;
}

/** CFBundleIdentifier; packaging/electron-builder.yml `appId` (pinned by a test). */
export const MAC_APP_ID = "com.ompstudio.desktop";

const STAGING_PREFIX = ".OMP Studio.update-";
const BACKUP_PREFIX = ".OMP Studio.previous-";
const MANUAL_INSTALL = "请从发布页下载 dmg 手动安装。";

/** `.../OMP Studio.app/Contents/MacOS/OMP Studio` → `.../OMP Studio.app`. */
export function macBundlePath(execPath: string): string | undefined {
  const macos = dirname(execPath);
  const contents = dirname(macos);
  const bundle = dirname(contents);
  return basename(macos) === "MacOS" && basename(contents) === "Contents" && bundle.endsWith(".app") ? bundle : undefined;
}

const execFileRun: RunFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${basename(file)} failed: ${(stderr || error.message).trim().slice(0, 500)}`));
      else resolve(stdout);
    });
  });

const spawnDetachedHelper: SpawnHelper = (execPath, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(execPath, [...args], { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

async function availableBytes(path: string): Promise<number> {
  const info = await statfs(path);
  return Number(info.bavail) * Number(info.bsize);
}

async function isArm64MachO(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const header = Buffer.alloc(8);
    const { bytesRead } = await handle.read(header, 0, 8, 0);
    return bytesRead === 8 && header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c;
  } finally {
    await handle.close();
  }
}

const OUTCOME_STATUSES: readonly MacSwapStatus[] = ["installed", "rolled-back", "failed", "unconfirmed"];

export class MacAppInstaller {
  readonly #options: MacAppInstallerOptions;
  readonly #run: RunFile;

  constructor(options: MacAppInstallerOptions) {
    this.#options = options;
    this.#run = options.run ?? execFileRun;
  }

  /** Why this copy cannot replace itself, or undefined when it can. */
  async preflight(requiredBytes?: number): Promise<string | undefined> {
    const bundle = this.#options.bundlePath;
    if (bundle.includes("/AppTranslocation/")) {
      return "OMP Studio 正从 macOS 的隔离位置运行（App Translocation），无法自行更新。请把它移到“应用程序”文件夹后重新打开。";
    }
    const parent = dirname(bundle);
    try {
      await access(parent, constants.W_OK);
      await rm(await mkdtemp(join(parent, ".OMP Studio.write-")), { recursive: true, force: true });
    } catch {
      return `没有写入“${parent}”的权限，无法自动更新。${MANUAL_INSTALL}`;
    }
    if (requiredBytes !== undefined) {
      const free = await (this.#options.freeBytes ?? availableBytes)(parent).catch(() => Number.POSITIVE_INFINITY);
      if (free < requiredBytes) return `“${parent}”所在磁盘空间不足，无法自动更新。`;
    }
    return undefined;
  }

  /** Verify the new bundle and start the swap helper; the caller quits right after. */
  async install(zipPath: string, release: ComponentRelease): Promise<void> {
    const reason = await this.preflight((await stat(zipPath)).size * 3);
    if (reason !== undefined) throw new Error(reason);
    const target = this.#options.bundlePath;
    const parent = dirname(target);
    const stagingRoot = await mkdtemp(join(parent, STAGING_PREFIX));
    try {
      await this.#run("/usr/bin/ditto", ["-x", "-k", "--noqtn", zipPath, stagingRoot]);
      const staged = join(stagingRoot, basename(target));
      if (!(await stat(staged).then((entry) => entry.isDirectory(), () => false))) throw new Error(`更新包里没有 ${basename(target)}`);
      await this.#run("/usr/bin/codesign", ["--verify", "--deep", "--strict", staged]);
      const info = JSON.parse(await this.#run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(staged, "Contents", "Info.plist")])) as Record<string, unknown>;
      if (info.CFBundleIdentifier !== this.#options.appId) throw new Error(`更新包的应用标识是 ${String(info.CFBundleIdentifier)}，不是 ${this.#options.appId}`);
      // Equality, not "newer": restoring the previous version installs an older one.
      if (info.CFBundleShortVersionString !== release.version) throw new Error(`更新包版本是 ${String(info.CFBundleShortVersionString)}，清单要求 ${release.version}`);
      if (typeof info.CFBundleExecutable !== "string" || !(await isArm64MachO(join(staged, "Contents", "MacOS", info.CFBundleExecutable)))) {
        throw new Error("更新包的主程序不是 Apple Silicon (arm64) 可执行文件");
      }

      const paths = macSwapPaths(this.#options.swapDirectory);
      await mkdir(this.#options.swapDirectory, { recursive: true });
      for (const stale of [paths.started, paths.healthy, paths.cleanExit, paths.outcome]) await rm(stale, { force: true });
      const plan: MacSwapPlan = {
        schema: 1,
        pid: this.#options.pid,
        target,
        staged,
        stagingRoot,
        backup: join(parent, `${BACKUP_PREFIX}${basename(stagingRoot).slice(STAGING_PREFIX.length)}`),
        version: release.version,
        markers: { started: paths.started, healthy: paths.healthy, cleanExit: paths.cleanExit },
        outcome: paths.outcome,
        waitForExitMs: this.#options.timing?.waitForExitMs ?? 60_000,
        startTimeoutMs: this.#options.timing?.startTimeoutMs ?? 120_000,
        monitorMs: this.#options.timing?.monitorMs ?? 30 * 60_000,
        pollMs: this.#options.timing?.pollMs ?? 500,
      };
      await writeFile(paths.helper, macSwapHelperSource(), "utf8");
      await writeJsonAtomic(paths.plan, plan);
      await (this.#options.spawnHelper ?? spawnDetachedHelper)(this.#options.execPath, [paths.helper, paths.plan], {
        ELECTRON_RUN_AS_NODE: "1",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
      });
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      await rm(macSwapPaths(this.#options.swapDirectory).plan, { force: true });
      throw error;
    }
  }

  /** The helper's verdict on the last swap, read once. */
  async consumeOutcome(): Promise<MacSwapOutcome | undefined> {
    const paths = macSwapPaths(this.#options.swapDirectory);
    let outcome: MacSwapOutcome | undefined;
    try {
      const raw = JSON.parse(await readFile(paths.outcome, "utf8")) as Partial<MacSwapOutcome>;
      if (typeof raw.version === "string" && OUTCOME_STATUSES.includes(raw.status as MacSwapStatus)) {
        outcome = { status: raw.status as MacSwapStatus, version: raw.version, ...(typeof raw.message === "string" ? { message: raw.message } : {}) };
      }
    } catch {
      return undefined;
    }
    await rm(paths.outcome, { force: true });
    return outcome;
  }

  /** Remove staging and backup folders a finished or interrupted swap left next to the bundle. */
  async cleanup(): Promise<void> {
    if (await access(macSwapPaths(this.#options.swapDirectory).plan).then(() => true, () => false)) return;
    const parent = dirname(this.#options.bundlePath);
    const entries = await readdir(parent).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry.startsWith(STAGING_PREFIX) || entry.startsWith(BACKUP_PREFIX)) await rm(join(parent, entry), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
