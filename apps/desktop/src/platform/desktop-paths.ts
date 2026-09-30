/**
 * Single source for the per-user and per-install locations Desktop uses.
 *
 * Windows reproduces the historic layout exactly: state under
 * `%APPDATA%\omp-studio`, the managed Runtime and update caches under
 * `%LOCALAPPDATA%\omp-studio`, bundled seeds next to `OMP Studio.exe`.
 * macOS keeps everything writable under `~/Library/Application Support`
 * (never inside the signed `.app`) and reads bundled seeds from the bundle's
 * `Contents/Resources` (`process.resourcesPath`), because `dirname(execPath)`
 * there is `Contents/MacOS`.
 */
import { execFileSync } from "node:child_process";
import { homedir as osHomedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

export const STATE_DIRECTORY_NAME = "omp-studio";
export const ENDPOINT_REGISTRY_DIRECTORY_NAME = "omp-studio-endpoints";

export interface DesktopPaths {
  /** `%APPDATA%` / `~/Library/Application Support`. */
  readonly appDataRoot: string;
  /** Profile state: workspace registry, keys, logs, git preferences. */
  readonly stateRoot: string;
  readonly logsRoot: string;
  readonly keysRoot: string;
  /** Writable managed Runtime store (packaged builds). */
  readonly runtimesRoot: string;
  /** v2 update journal and artifact cache. */
  readonly updatesV2Root: string;
  /** Legacy v1 update staging. */
  readonly legacyStagingRoot: string;
  readonly endpointRegistryRoot: string;
}

export interface DesktopPathInputs {
  readonly platform: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homedir?: string;
}

export function resolveDesktopPaths(input: DesktopPathInputs): DesktopPaths {
  const env = input.env ?? process.env;
  const home = input.homedir ?? osHomedir();
  if (input.platform === "win32") {
    const appDataRoot = env.APPDATA ?? win32.join(home, "AppData", "Roaming");
    const localRoot = win32.join(env.LOCALAPPDATA ?? win32.join(home, "AppData", "Local"), STATE_DIRECTORY_NAME);
    const stateRoot = win32.join(appDataRoot, STATE_DIRECTORY_NAME);
    return {
      appDataRoot,
      stateRoot,
      logsRoot: win32.join(stateRoot, "logs"),
      keysRoot: win32.join(stateRoot, "keys"),
      runtimesRoot: win32.join(localRoot, "runtimes"),
      updatesV2Root: win32.join(localRoot, "updates-v2"),
      legacyStagingRoot: win32.join(localRoot, "updates"),
      endpointRegistryRoot: win32.join(appDataRoot, ENDPOINT_REGISTRY_DIRECTORY_NAME),
    };
  }
  if (input.platform === "darwin") {
    const appDataRoot = posix.join(home, "Library", "Application Support");
    const stateRoot = posix.join(appDataRoot, STATE_DIRECTORY_NAME);
    return {
      appDataRoot,
      stateRoot,
      logsRoot: posix.join(stateRoot, "logs"),
      keysRoot: posix.join(stateRoot, "keys"),
      runtimesRoot: posix.join(stateRoot, "runtimes"),
      updatesV2Root: posix.join(stateRoot, "updates-v2"),
      legacyStagingRoot: posix.join(stateRoot, "updates"),
      endpointRegistryRoot: posix.join(appDataRoot, ENDPOINT_REGISTRY_DIRECTORY_NAME),
    };
  }
  throw new Error(`Unsupported desktop platform: ${input.platform}`);
}

export interface PackagedResourcePaths {
  /** Signed Runtime seed shipped with the app (`runtime/versions`). */
  readonly bundledRuntimeRoot: string;
  /** Public Runtime verification keys shipped with the app. */
  readonly bundledKeysRoot: string;
}

export function packagedResourcePaths(input: {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  /** `process.resourcesPath`; required on macOS. */
  readonly resourcesPath?: string;
}): PackagedResourcePaths {
  if (input.platform === "win32") {
    // electron-builder `extraFiles` land next to OMP Studio.exe.
    const installDirectory = win32.dirname(input.execPath);
    return {
      bundledRuntimeRoot: win32.join(installDirectory, "runtime", "versions"),
      bundledKeysRoot: win32.join(installDirectory, "runtime-keys"),
    };
  }
  if (input.platform === "darwin") {
    if (input.resourcesPath === undefined) throw new Error("macOS bundle resources path is required");
    return {
      bundledRuntimeRoot: posix.join(input.resourcesPath, "runtime", "versions"),
      bundledKeysRoot: posix.join(input.resourcesPath, "runtime-keys"),
    };
  }
  throw new Error(`Unsupported desktop platform: ${input.platform}`);
}

/**
 * Per-user temp directory from `confstr(_CS_DARWIN_USER_TEMP_DIR)`. Unlike
 * `$TMPDIR` it does not change between Finder, Terminal and launchd, so every
 * instance agrees on where the private sockets (and the authority proof) live.
 */
export function darwinUserTempDir(
  run: () => string = () => execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }),
): string {
  try {
    const value = run().trim();
    if (value.startsWith("/")) return value;
  } catch {
    // Fall back to $TMPDIR below.
  }
  return tmpdir();
}

let socketTmpRoot: string | undefined;

/** Temp root for Desktop's private unix-socket directories. */
export function desktopSocketTmpRoot(): string {
  socketTmpRoot ??= process.platform === "darwin" ? darwinUserTempDir() : tmpdir();
  return socketTmpRoot;
}

let productionPaths: DesktopPaths | undefined;

/** Paths for the running process; computed once. */
export function desktopPaths(): DesktopPaths {
  productionPaths ??= resolveDesktopPaths({ platform: process.platform });
  return productionPaths;
}
