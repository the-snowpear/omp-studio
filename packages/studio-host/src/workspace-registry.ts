/**
 * Durable Host-owned workspace registry.
 *
 * The registry is the ONLY place workspace paths live. It maps an opaque
 * random `workspaceId` to a canonical absolute directory path, a user-facing
 * display name and the last-opened timestamp, persisted under the profile
 * directory (`workspaces.json`) with the same atomic tmp+rename flush as
 * {@link ThreadBindingStore}. Nothing in the client contract, transport or
 * Renderer ever sees `canonicalPath`: adapters map stored records to
 * path-free read models at this module's boundary.
 */

import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/** Host-internal stored workspace record. Never crosses into a contract shape. */
export interface StoredWorkspace {
  /** Random opaque identity, e.g. randomBytes(16).toString("base64url"). */
  workspaceId: string;
  /** Canonical absolute directory path. Host-only. */
  canonicalPath: string;
  /** User-facing display name; defaults to the basename of {@link canonicalPath}. */
  name: string;
  /** ISO last-opened timestamp. */
  lastOpenedAt: string;
}

/** Persisted file shape: the active id plus the workspace list. */
interface StoredRegistryFile {
  activeWorkspaceId?: string;
  workspaces: StoredWorkspace[];
}

function assertStoredWorkspace(value: unknown): asserts value is StoredWorkspace {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace registry entry must be an object");
  }
  const entry = value as Record<string, unknown>;
  for (const key of ["workspaceId", "canonicalPath", "name", "lastOpenedAt"]) {
    if (typeof entry[key] !== "string" || (entry[key] as string).length === 0) {
      throw new TypeError(`Workspace registry ${key} is invalid`);
    }
  }
}

export class WorkspaceRegistry {
  readonly #workspaces = new Map<string, StoredWorkspace>();
  #activeWorkspaceId: string | undefined;

  constructor(readonly path: string) {}

  async load(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Workspace registry file must be an object");
    }
    const file = value as Record<string, unknown>;
    if (!Array.isArray(file.workspaces)) {
      throw new TypeError("Workspace registry file must contain a workspaces array");
    }
    this.#workspaces.clear();
    this.#activeWorkspaceId = undefined;
    for (const entry of file.workspaces) {
      assertStoredWorkspace(entry);
      this.#workspaces.set(entry.workspaceId, structuredClone(entry));
    }
    if (file.activeWorkspaceId !== undefined) {
      if (typeof file.activeWorkspaceId !== "string" || !this.#workspaces.has(file.activeWorkspaceId)) {
        throw new TypeError("Workspace registry activeWorkspaceId is invalid");
      }
      this.#activeWorkspaceId = file.activeWorkspaceId;
    }
  }

  /** Workspaces sorted by `lastOpenedAt` descending. */
  list(): StoredWorkspace[] {
    return [...this.#workspaces.values()]
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
      .map((entry) => structuredClone(entry));
  }

  get(workspaceId: string): StoredWorkspace | undefined {
    const entry = this.#workspaces.get(workspaceId);
    return entry === undefined ? undefined : structuredClone(entry);
  }

  get activeWorkspaceId(): string | undefined {
    return this.#activeWorkspaceId;
  }

  /**
   * Register (or refresh) a workspace from a real directory. The directory
   * must exist and be a real directory (symlinks rejected). Re-adding the
   * same canonical path (case-insensitive on win32) reuses its id, updates
   * `lastOpenedAt` and makes it active; a new path gets a fresh opaque id.
   */
  async upsertByPath(dir: string, nowIso: string = new Date().toISOString(), displayName?: string): Promise<StoredWorkspace> {
    let metadata;
    try {
      metadata = await lstat(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`workspace directory does not exist: ${dir}`);
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new Error(`workspace directory must not be a symbolic link: ${dir}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`workspace path is not a directory: ${dir}`);
    }
    const canonicalPath = await canonicalizeDirectory(dir);
    const existing = this.#findByPath(canonicalPath);
    if (existing !== undefined) {
      const refreshed: StoredWorkspace = {
        ...existing,
        canonicalPath,
        ...(displayName === undefined ? {} : { name: displayName }),
        lastOpenedAt: nowIso,
      };
      this.#workspaces.set(refreshed.workspaceId, refreshed);
      this.#activeWorkspaceId = refreshed.workspaceId;
      await this.#flush();
      return structuredClone(refreshed);
    }
    const created: StoredWorkspace = {
      workspaceId: randomBytes(16).toString("base64url"),
      canonicalPath,
      name: displayName ?? basename(canonicalPath),
      lastOpenedAt: nowIso,
    };
    this.#workspaces.set(created.workspaceId, created);
    this.#activeWorkspaceId = created.workspaceId;
    await this.#flush();
    return structuredClone(created);
  }

  /**
   * Mark an existing workspace as just-opened (and active). Throws when the
   * id is unknown or the directory no longer exists.
   */
  async touch(workspaceId: string, nowIso: string = new Date().toISOString()): Promise<StoredWorkspace> {
    const existing = this.#workspaces.get(workspaceId);
    if (existing === undefined) {
      throw new Error(`unknown workspace id: ${workspaceId}`);
    }
    try {
      const metadata = await lstat(existing.canonicalPath);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new Error(`workspace directory is no longer a real directory: ${existing.canonicalPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`workspace directory no longer exists: ${existing.canonicalPath}`);
      }
      throw error;
    }
    const refreshed: StoredWorkspace = { ...existing, lastOpenedAt: nowIso };
    this.#workspaces.set(refreshed.workspaceId, refreshed);
    this.#activeWorkspaceId = refreshed.workspaceId;
    await this.#flush();
    return structuredClone(refreshed);
  }

  /** Path-insensitive lookup: win32 compares case-insensitively. */
  #findByPath(canonicalPath: string): StoredWorkspace | undefined {
    for (const entry of this.#workspaces.values()) {
      if (samePath(entry.canonicalPath, canonicalPath)) return entry;
    }
    return undefined;
  }

  async #flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const file: StoredRegistryFile = {
      ...(this.#activeWorkspaceId === undefined ? {} : { activeWorkspaceId: this.#activeWorkspaceId }),
      workspaces: this.list(),
    };
    const temporary = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporary, this.path);
  }
}

/** Canonical directory path: `resolve`, then `realpath` on win32 (best-effort). */
async function canonicalizeDirectory(dir: string): Promise<string> {
  const resolved = resolve(dir);
  if (process.platform !== "win32") return resolved;
  try {
    return await realpath(resolved);
  } catch {
    return resolved;
  }
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}
