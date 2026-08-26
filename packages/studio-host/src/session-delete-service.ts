import { lstat, open, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Dirent } from "node:fs";

import { readGunzipPrefix } from "./gzip-file.js";
import {
  SESSION_PINS_MAX_BYTES,
  SESSION_PINS_MAX_ENTRIES,
  SESSION_PIN_ID_MAX_CHARS,
  defaultOmpArchiveRoot,
  defaultOmpSessionsRoot,
} from "./session-catalog.js";

const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";
const SESSION_PINS_FILENAME = "session-pins.json";
const HEADER_PREFIX_BYTES = 64 * 1024;
const DEFAULT_MAX_SCAN_FILES = 20_000;

export type SessionDeleteServiceErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_DUPLICATE"
  | "SESSION_RESIDENT"
  | "WORKSPACE_MISMATCH"
  | "IO_ERROR";

export class SessionDeleteServiceError extends Error {
  constructor(readonly code: SessionDeleteServiceErrorCode, message: string) {
    super(message);
    this.name = "SessionDeleteServiceError";
  }
}

export interface SessionDeleteServiceOptions {
  /** OMP's sessions root. Defaults to `<agentDir>/sessions` (`OMP_AGENT_DIR` honored). */
  readonly sessionsRoot?: string;
  /** OMP's cold-archive root. Defaults to `<agentDir>/archive/sessions`, mirroring `omp gc`. */
  readonly archiveRoot?: string;
  readonly allowedCwd: string;
  readonly maxScanFiles?: number;
  /** Rejects deletion while the session is resident in a Runtime. */
  readonly isResident?: (sessionId: string) => boolean | Promise<boolean>;
}

export interface SessionDeleteResult {
  readonly sessionId: string;
  readonly deleted: true;
}

interface LocatedSession {
  readonly path: string;
  readonly cwd?: string;
}

/**
 * Host-owned destructive session removal aligned with OMP's own
 * `deleteSessionWithArtifacts`: deletes the transcript (plain or archived
 * `.jsonl.gz`) and its sibling artifacts directory — which also carries nested
 * subagent transcripts and their artifacts. Unlike archive there is no
 * crash-writer grace window: the operator explicitly asked for this session to
 * be gone, so a recently-written tail must not block deletion. Residency and
 * workspace checks are shared with the archive service so an in-use or
 * cross-workspace session is never destroyed.
 */
export class StudioSessionDeleteService {
  readonly #sessionsRoot: string;
  readonly #archiveRoot: string;
  readonly #allowedCwd: string;
  readonly #maxScanFiles: number;
  readonly #isResident: ((sessionId: string) => boolean | Promise<boolean>) | undefined;

  constructor(options: SessionDeleteServiceOptions) {
    if (options.allowedCwd.length === 0) throw new TypeError("allowedCwd is required");
    this.#sessionsRoot = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
    this.#archiveRoot = resolve(options.archiveRoot ?? defaultOmpArchiveRoot(this.#sessionsRoot));
    this.#allowedCwd = resolve(options.allowedCwd);
    this.#maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.#isResident = options.isResident;
    if (!Number.isSafeInteger(this.#maxScanFiles) || this.#maxScanFiles <= 0) {
      throw new TypeError("maxScanFiles must be positive");
    }
  }

  async delete(sessionId: string): Promise<SessionDeleteResult> {
    if (sessionId.length === 0) {
      throw new SessionDeleteServiceError("SESSION_NOT_FOUND", "Session id is required");
    }
    await this.#assertNotResident(sessionId);
    const active = await this.#findInTree(this.#sessionsRoot, SESSION_SUFFIX, sessionId);
    const archived = await this.#findInTree(this.#archiveRoot, COMPRESSED_SESSION_SUFFIX, sessionId);
    if (active !== undefined && archived !== undefined) {
      throw new SessionDeleteServiceError(
        "SESSION_DUPLICATE",
        "Session identity is duplicated between active and archive trees; refusing an ambiguous delete",
      );
    }
    const located = active ?? archived;
    if (located === undefined) {
      throw new SessionDeleteServiceError(
        "SESSION_NOT_FOUND",
        "Session is not available in the sessions or archive trees",
      );
    }
    this.#assertWorkspace(located);

    await this.#removeSessionWithArtifacts(located.path);
    return { sessionId, deleted: true };
  }

  #assertWorkspace(source: LocatedSession): void {
    if (source.cwd === undefined || !sameWorkspace(source.cwd, this.#allowedCwd)) {
      throw new SessionDeleteServiceError("WORKSPACE_MISMATCH", "Session does not belong to the selected workspace");
    }
  }

  async #assertNotResident(sessionId: string): Promise<void> {
    if (this.#isResident === undefined) return;
    if (await this.#isResident(sessionId)) {
      throw new SessionDeleteServiceError("SESSION_RESIDENT", "Session is resident in a Runtime and cannot be deleted");
    }
  }

  async #findInTree(
    root: string,
    suffix: string,
    sessionId: string,
  ): Promise<LocatedSession | undefined> {
    const files = await listFilesWithSuffix(root, suffix, this.#maxScanFiles);
    let match: LocatedSession | undefined;
    for (const file of files) {
      const header = await readSessionHeaderForDelete(file, suffix === COMPRESSED_SESSION_SUFFIX);
      if (header?.id !== sessionId) continue;
      if (match !== undefined) {
        throw new SessionDeleteServiceError(
          "SESSION_DUPLICATE",
          "Session identity is duplicated; refusing an ambiguous delete",
        );
      }
      match = { path: file, ...(header.cwd === undefined ? {} : { cwd: header.cwd }) };
    }
    return match;
  }

  /**
   * Delete the transcript then its artifacts directory. The session file is
   * the primary object; a failing artifacts cleanup is surfaced so the
   * operator knows residue remains (same policy as OMP's own delete).
   */
  async #removeSessionWithArtifacts(sessionPath: string): Promise<void> {
    let metadata;
    try {
      metadata = await lstat(sessionPath);
    } catch {
      throw new SessionDeleteServiceError("SESSION_NOT_FOUND", "Session file is not readable");
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SessionDeleteServiceError("SESSION_NOT_FOUND", "Session file is not a regular file");
    }
    try {
      await unlink(sessionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SessionDeleteServiceError("IO_ERROR", `Failed to delete session file: ${errorMessage(error)}`);
      }
    }
    const artifactsDir = artifactsPathFor(sessionPath);
    try {
      await rm(artifactsDir, { recursive: true, force: true });
    } catch (error) {
      throw new SessionDeleteServiceError(
        "IO_ERROR",
        `Session file deleted but failed to remove artifacts directory ${artifactsDir}: ${errorMessage(error)}`,
      );
    }
  }
}

function artifactsPathFor(sessionPath: string): string {
  if (sessionPath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
    return sessionPath.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
  }
  return sessionPath.slice(0, -SESSION_SUFFIX.length);
}

/**
 * Remove one session id from OMP's global pin set. Only rewrites the file
 * when it parses as a bounded array of ids; a missing, corrupt, or oversized
 * pin file is left untouched so optional metadata can never block deletion.
 */
export async function removeSessionPin(sessionId: string, agentDir: string): Promise<void> {
  if (sessionId.length === 0) return;
  const pinPath = join(agentDir, SESSION_PINS_FILENAME);
  let metadata;
  try {
    metadata = await lstat(pinPath);
  } catch {
    return;
  }
  if (!metadata.isFile() || metadata.size > SESSION_PINS_MAX_BYTES) return;
  let parsed: unknown;
  try {
    const handle = await open(pinPath, "r");
    try {
      const buffer = Buffer.alloc(metadata.size);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return;
  }
  if (!Array.isArray(parsed) || parsed.length > SESSION_PINS_MAX_ENTRIES) return;
  if (parsed.some((value) => typeof value !== "string" || value.length === 0 || value.length > SESSION_PIN_ID_MAX_CHARS)) return;
  const next = parsed.filter((value) => value !== sessionId);
  if (next.length === parsed.length) return;
  await writeFile(pinPath, `${JSON.stringify(next, null, "\t")}`, { encoding: "utf8" });
}

async function listFilesWithSuffix(root: string, suffix: string, limit: number): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  const add = (path: string): void => {
    if (files.length >= limit) {
      throw new SessionDeleteServiceError("IO_ERROR", "Session scan exceeds the configured file limit");
    }
    files.push(path);
  };
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(suffix)) {
      add(candidate);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let children: Dirent<string>[];
    try {
      children = await readdir(candidate, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (!child.isSymbolicLink() && child.isFile() && child.name.endsWith(suffix)) {
        add(join(candidate, child.name));
      }
    }
  }
  return files.sort();
}

async function readSessionHeaderForDelete(
  file: string,
  compressed: boolean,
): Promise<{ id: string; cwd?: string } | undefined> {
  let text: string;
  try {
    if (compressed) {
      const prefix = await readGunzipPrefix(file, HEADER_PREFIX_BYTES, Number.MAX_SAFE_INTEGER);
      text = prefix.toString("utf8");
    } else {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
      const handle = await open(file, "r");
      try {
        const buffer = Buffer.alloc(Math.min(HEADER_PREFIX_BYTES, metadata.size));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return undefined;
  }
  for (const line of text.split(/\r?\n/u).slice(0, 8)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" || value.id.length === 0) {
      continue;
    }
    const cwd = typeof value.cwd === "string" && value.cwd.length > 0 ? value.cwd : undefined;
    return { id: value.id, ...(cwd === undefined ? {} : { cwd }) };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameWorkspace(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}
