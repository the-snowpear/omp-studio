/**
 * Workspace path identity.
 *
 * The registry stores one spelling per workspace, and the session services
 * compare the `cwd` a Runtime recorded against it. Windows compares
 * case-insensitively. macOS stores the real path, as the Runtime's
 * `process.cwd()` reports it, and compares with `/private/var`,
 * `/private/tmp` and `/private/etc` spelled the short way (upstream
 * `standardizeMacOSPath`) and names in NFC, because APFS treats the NFC and
 * NFD spellings of a name as the same file.
 */
import { realpath as fsRealpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

/** `/var`, `/tmp` and `/etc` are fixed symlinks into `/private` on every Mac. */
const MAC_PRIVATE_ALIAS = /^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/u;

function resolveFor(platform: NodeJS.Platform, path: string): string {
  return platform === "win32" ? win32.resolve(path) : posix.resolve(path);
}

/** The string two spellings of one workspace have in common. */
export function workspacePathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = resolveFor(platform, path);
  if (platform === "win32") return resolved.toLowerCase();
  if (platform === "darwin") return resolved.replace(MAC_PRIVATE_ALIAS, "").normalize("NFC");
  return resolved;
}

export function sameWorkspacePath(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
  return workspacePathKey(left, platform) === workspacePathKey(right, platform);
}

export interface CanonicalWorkspacePathOptions {
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (path: string) => Promise<string>;
}

/**
 * The spelling the registry stores: the real path on Windows and macOS, or the
 * resolved path when it cannot be read (missing, or withheld by TCC).
 */
export async function canonicalWorkspacePath(dir: string, options: CanonicalWorkspacePathOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const resolved = resolveFor(platform, dir);
  if (platform !== "win32" && platform !== "darwin") return resolved;
  let real: string;
  try {
    real = await (options.realpath ?? fsRealpath)(resolved);
  } catch {
    real = resolved;
  }
  return platform === "darwin" ? real.replace(MAC_PRIVATE_ALIAS, "") : real;
}
