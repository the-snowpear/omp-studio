/**
 * Desktop managed Runtime install seam.
 *
 * `runtime.install` copies a locally signed artifact into the Host-owned
 * `%APPDATA%\omp-studio\runtimes` tree and activates it. There is no
 * downloader and no PATH / system-omp fallback. Artifact lookup is Host-only;
 * paths never enter ClientBootstrap.
 */

import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { HostRuntimeInstallService } from "@omp-studio/host-client-api";
import type { RuntimeChannel, RuntimeInstallState } from "@omp-studio/client-contract";
import {
  parseRuntimeInstallationManifest,
  type ActivateOptions,
} from "@omp-studio/runtime-installer";
import type { HostBackend } from "@omp-studio/studio-host";
import type { RuntimeInstallationManifest } from "@omp-studio/studio-protocol";

export interface LocateManagedRuntimeArtifactOptions {
  readonly channel?: RuntimeChannel;
  readonly platform: string;
  readonly roots?: readonly string[];
}

export interface DesktopManagedInstallOptions {
  readonly locateArtifact?: (input: LocateManagedRuntimeArtifactOptions) => Promise<string | undefined>;
  readonly activateOptions?: ActivateOptions;
  /** Tests replace the post-activate Runtime start; production leaves this unset. */
  readonly afterActivate?: () => Promise<void>;
}

const KEY_ID_FILE = "key-id.txt";
const PUBLIC_KEY_FILE = "trusted-public.pem";

/** Host-profile key directory. Never a repository path. */
export function defaultRuntimeKeysDirectory(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "omp-studio", "keys");
  }
  return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "omp-studio", "keys");
}

export async function loadInstallerTrustedKeys(
  keysDirectory = defaultRuntimeKeysDirectory(),
): Promise<{ trustedKeys: Record<string, Buffer> } | undefined> {
  const envPath = process.env.OMP_RUNTIME_TRUSTED_PUBLIC_KEY?.trim();
  const envId = process.env.OMP_RUNTIME_SIGNING_KEY_ID?.trim();
  if (envPath !== undefined && envPath.length > 0 && envId !== undefined && envId.length > 0) {
    return { trustedKeys: { [envId]: await readFile(envPath) } };
  }
  try {
    const keyId = (await readFile(join(keysDirectory, KEY_ID_FILE), "utf8")).trim();
    const publicKey = await readFile(join(keysDirectory, PUBLIC_KEY_FILE));
    if (keyId.length === 0 || publicKey.length === 0) {
      return undefined;
    }
    return { trustedKeys: { [keyId]: publicKey } };
  } catch {
    return undefined;
  }
}

const ARTIFACT_WALK_DEPTH = 8;

function artifactRootFor(base: string, platform: string): string {
  return join(base, "packages", "runtime-installer", "dist", "artifacts", platform);
}

/**
 * Electron `npm run dev -w @omp-studio/desktop` sets cwd to `apps/desktop`,
 * not the repo root. Walk ancestors of each seed so a locally built
 * `packages/runtime-installer/dist/artifacts/<platform>` tree is found.
 */
export function collectManagedRuntimeArtifactRoots(options: {
  readonly platform: string;
  readonly seeds: readonly string[];
  readonly extra?: string;
}): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  const add = (directory: string): void => {
    const resolved = resolve(directory);
    if (seen.has(resolved)) {
      return;
    }
    seen.add(resolved);
    roots.push(resolved);
  };
  const extra = options.extra?.trim();
  if (extra !== undefined && extra.length > 0) {
    add(extra);
  }
  for (const seed of options.seeds) {
    let directory = resolve(seed);
    for (let depth = 0; depth < ARTIFACT_WALK_DEPTH; depth += 1) {
      add(artifactRootFor(directory, options.platform));
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  return roots;
}

function defaultArtifactRoots(platform: string): string[] {
  const extra = process.env.OMP_ARTIFACT_DIR;
  return collectManagedRuntimeArtifactRoots({
    platform,
    seeds: [process.cwd(), fileURLToPath(new URL(".", import.meta.url))],
    ...(extra === undefined ? {} : { extra }),
  });
}

async function readArtifactManifest(directory: string): Promise<RuntimeInstallationManifest | undefined> {
  try {
    return parseRuntimeInstallationManifest(JSON.parse(await readFile(join(directory, "runtime-manifest.json"), "utf8")));
  } catch {
    return undefined;
  }
}

function matchesArtifact(
  manifest: RuntimeInstallationManifest,
  options: LocateManagedRuntimeArtifactOptions,
): boolean {
  if (manifest.platform !== options.platform) {
    return false;
  }
  if (options.channel !== undefined && manifest.channel !== options.channel) {
    return false;
  }
  return true;
}

/** Newest matching signed artifact directory, or `undefined` when none exist. */
export async function locateManagedRuntimeArtifact(
  options: LocateManagedRuntimeArtifactOptions,
): Promise<string | undefined> {
  const roots = options.roots ?? defaultArtifactRoots(options.platform);
  const matches: Array<{ directory: string; version: string }> = [];
  for (const root of roots) {
    const direct = await readArtifactManifest(root);
    if (direct !== undefined) {
      if (matchesArtifact(direct, options)) {
        matches.push({ directory: root, version: direct.runtimeVersion });
      }
      continue;
    }
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      const directory = join(root, entry.name);
      const manifest = await readArtifactManifest(directory);
      if (manifest === undefined || !matchesArtifact(manifest, options)) {
        continue;
      }
      matches.push({ directory, version: manifest.runtimeVersion });
    }
  }
  if (matches.length === 0) {
    return undefined;
  }
  matches.sort((left, right) => left.version.localeCompare(right.version));
  return matches[matches.length - 1]?.directory;
}

export function createDesktopRuntimeInstallService(options: {
  readonly backend: Pick<HostBackend, "install" | "activate">;
  readonly platform: string;
  readonly hasTrustedKey: boolean;
  readonly locateArtifact?: (input: LocateManagedRuntimeArtifactOptions) => Promise<string | undefined>;
  readonly activateOptions?: ActivateOptions;
  readonly afterActivate?: (manifest: RuntimeInstallationManifest) => Promise<void>;
}): HostRuntimeInstallService {
  return async (channel?: RuntimeChannel): Promise<RuntimeInstallState> => {
    if (!options.hasTrustedKey) {
      throw new Error(
        "Managed Runtime install requires OMP_RUNTIME_TRUSTED_PUBLIC_KEY and OMP_RUNTIME_SIGNING_KEY_ID. Run npm run omp:keys to create a local signing key.",
      );
    }
    const locate = options.locateArtifact ?? locateManagedRuntimeArtifact;
    const artifactDirectory = await locate({
      platform: options.platform,
      ...(channel === undefined ? {} : { channel }),
    });
    if (artifactDirectory === undefined) {
      throw new Error(
        channel === undefined
          ? "No managed Runtime artifact was found. Run npm run omp:build:host or set OMP_ARTIFACT_DIR."
          : `No managed Runtime artifact was found for the ${channel} channel.`,
      );
    }
    let manifest: RuntimeInstallationManifest;
    try {
      manifest = await options.backend.install(artifactDirectory);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already installed/u.test(message)) {
        throw error;
      }
      const parsed = await readArtifactManifest(artifactDirectory);
      if (parsed === undefined) {
        throw error;
      }
      manifest = parsed;
    }
    await options.backend.activate(manifest.runtimeVersion, options.activateOptions);
    try {
      await options.afterActivate?.(manifest);
    } catch (error) {
      return {
        status: "installed",
        version: manifest.runtimeVersion,
        signature: "verified",
        message: error instanceof Error ? error.message : "Runtime did not start",
      };
    }
    return {
      status: "installed",
      version: manifest.runtimeVersion,
      signature: "verified",
    };
  };
}
