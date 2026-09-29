/**
 * Short, private unix-socket locations.
 *
 * macOS limits `sun_path` to 104 bytes including the NUL and Node rejects a
 * longer path with EINVAL, so a socket under `~/Library/Application Support/…`
 * breaks for ordinary usernames. Sockets therefore live in a short per-scope
 * directory under a caller-chosen temp root (Desktop passes the fixed
 * `DARWIN_USER_TEMP_DIR`, not `$TMPDIR`, which differs between launch
 * contexts). Tokens and other regular files stay in the profile directory.
 * Windows uses named pipes and never calls into this module.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_UNIX_SOCKET_PATH_BYTES = 103;
/** Longest name this module generates (`b-<16 hex>.sock`), with headroom. */
const SOCKET_NAME_BUDGET = 32;

function scopeHash(scopeKey: string): string {
  return createHash("sha256").update(scopeKey).digest("hex").slice(0, 10);
}

export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES;
}

export function privateSocketDirectoryPath(scopeKey: string, tmpRoot: string = tmpdir()): string {
  return join(tmpRoot, `omp-${scopeHash(scopeKey)}`);
}

export function privateSocketPath(directory: string, name: string): string {
  const path = join(directory, name);
  if (!socketPathFits(path)) {
    throw new Error(`Unix socket path is ${Buffer.byteLength(path, "utf8")} bytes; the limit is ${MAX_UNIX_SOCKET_PATH_BYTES}`);
  }
  return path;
}

export function randomSocketName(prefix: "b" | "p"): string {
  return `${prefix}-${randomBytes(8).toString("hex")}.sock`;
}

/**
 * Live-audio socket for one audio id. The Runtime overlay derives the same name
 * (`live-audio-service.ts`) and Desktop only connects to the endpoint it
 * computes itself, so both copies share the test vector in `socket-paths.test.ts`.
 */
export function liveAudioSocketName(audioId: string): string {
  return `a-${createHash("sha256").update(audioId).digest("hex").slice(0, 16)}.sock`;
}

export interface PrivateSocketDirectoryOptions {
  readonly tmpRoot?: string;
  /** Test seam; defaults to the current uid. */
  readonly uid?: number;
}

/**
 * Creates or re-validates a directory only this user can enter. A symlink, a
 * foreign owner or any group/other permission bit fails closed: nothing that
 * another account could have prepared is trusted to hold a socket.
 */
export async function ensurePrivateSocketDirectory(
  scopeKey: string,
  options: PrivateSocketDirectoryOptions = {},
): Promise<string> {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Private socket directories are POSIX-only");
  let directory = privateSocketDirectoryPath(scopeKey, options.tmpRoot);
  if (!socketPathFits(join(directory, "x".repeat(SOCKET_NAME_BUDGET)))) {
    directory = join("/tmp", `omp-${uid}-${scopeHash(scopeKey)}`);
  }
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`Socket directory ${directory} is not a real directory`);
  if (metadata.uid !== uid) throw new Error(`Socket directory ${directory} is owned by another user`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`Socket directory ${directory} is accessible to other users; remove it`);
  return directory;
}

function probeListener(path: string, timeoutMs: number): Promise<"live" | "stale"> {
  return new Promise((resolve) => {
    const socket = connect(path);
    const settle = (state: "live" | "stale") => {
      clearTimeout(timer);
      socket.destroy();
      resolve(state);
    };
    // A listener that neither accepts nor refuses in time is treated as live.
    const timer = setTimeout(() => settle("live"), timeoutMs);
    socket.once("connect", () => settle("live"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      settle(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "stale" : "live");
    });
  });
}

/**
 * Removes sockets nobody listens on any more (left behind by a crash; a clean
 * close already unlinks them). Returns how many were removed.
 */
export async function sweepStaleSockets(
  directory: string,
  options: { readonly minAgeMs?: number; readonly now?: number; readonly probeTimeoutMs?: number } = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const minAgeMs = options.minAgeMs ?? 0;
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".sock")) continue;
    const path = join(directory, name);
    try {
      const metadata = await lstat(path);
      if (!metadata.isSocket() || (minAgeMs > 0 && now - metadata.mtimeMs < minAgeMs)) continue;
      if ((await probeListener(path, options.probeTimeoutMs ?? 250)) === "stale") {
        await unlink(path);
        removed += 1;
      }
    } catch {
      // Raced with its owner or already gone; leave it.
    }
  }
  return removed;
}
