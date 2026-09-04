import { createReadStream, createWriteStream } from "node:fs";
import { cp, lstat, mkdir, open, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { GzipFileError, readGunzipCapped, readGunzipPrefix } from "./gzip-file.js";
import { defaultOmpArchiveRoot, defaultOmpSessionsRoot } from "./session-catalog.js";

const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;
const DEFAULT_SCAN_FILES = 20_000;
const DEFAULT_WRITE_GRACE_MS = 60_000;
const DEFAULT_GC_LOCK_STALE_MS = 60 * 60 * 1000;
const SESSION_SUFFIX = ".jsonl";
const COMPRESSED_SESSION_SUFFIX = ".jsonl.gz";
const GC_LOCK_NAME = "gc.lock";
const HEADER_PREFIX_BYTES = 64 * 1024;
/** Tail bytes read to recover the transcript's last-active timestamp. */
const TAIL_SCAN_BYTES = 1024 * 1024;
/** Suffix for a source renamed out of discovery while its destination lands. */
const STAGING_SUFFIX = ".staging";

export type SessionArchiveServiceErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_DUPLICATE"
  | "SESSION_ALREADY_ARCHIVED"
  | "SESSION_TOO_LARGE"
  | "SESSION_RESIDENT"
  | "SESSION_RECENTLY_WRITTEN"
  | "WORKSPACE_MISMATCH"
  | "GC_LOCK_HELD"
  | "DESTINATION_EXISTS"
  | "IO_ERROR";

export class SessionArchiveServiceError extends Error {
  constructor(readonly code: SessionArchiveServiceErrorCode, message: string) {
    super(message);
    this.name = "SessionArchiveServiceError";
  }
}

export interface SessionArchiveServiceOptions {
  /** OMP's sessions root. Defaults to `<agentDir>/sessions` (`OMP_AGENT_DIR` honored). */
  readonly sessionsRoot?: string;
  /** OMP's cold-archive root. Defaults to `<agentDir>/archive/sessions`, mirroring `omp gc`. */
  readonly archiveRoot?: string;
  readonly allowedCwd: string;
  readonly maxSessionBytes?: number;
  readonly maxScanFiles?: number;
  /** Rejects archive/unarchive while the session is resident in a Runtime. */
  readonly isResident?: (sessionId: string) => boolean | Promise<boolean>;
  /** Post-write grace window; a session touched within it is refused. */
  readonly writeGraceMs?: number;
  /** A gc.lock younger than this refuses the move; older locks are stale. */
  readonly gcLockStaleMs?: number;
  readonly now?: () => Date;
  /** Injectable filesystem rename used by the Windows contention regression tests. */
  readonly renameFile?: typeof rename;
  /** Injectable filesystem removal used by the Windows contention regression tests. */
  readonly removeFile?: typeof rm;
}

export interface SessionArchiveMoveResult {
  readonly sessionId: string;
  readonly archived: boolean;
}

interface LocatedSession {
  readonly path: string;
  readonly cwd?: string;
}

/**
 * Host-owned single-session archive aligned with `omp gc`'s cold archive:
 * `.jsonl` becomes `.jsonl.gz` (level 9) under `<agentDir>/archive/sessions`
 * with the sessions-relative layout and the artifacts directory preserved.
 * Moves stage the source under an undiscoverable name before the destination
 * lands, so no failure leaves one session visible in both trees; every move
 * is otherwise rolled back on failure. The OMP Runtime is never involved.
 */
export class StudioSessionArchiveService {
  readonly #sessionsRoot: string;
  readonly #archiveRoot: string;
  readonly #allowedCwd: string;
  readonly #maxSessionBytes: number;
  readonly #maxScanFiles: number;
  readonly #isResident: ((sessionId: string) => boolean | Promise<boolean>) | undefined;
  readonly #writeGraceMs: number;
  readonly #gcLockStaleMs: number;
  readonly #now: () => Date;
  readonly #renameFile: typeof rename;
  readonly #removeFile: typeof rm;

  constructor(options: SessionArchiveServiceOptions) {
    if (options.allowedCwd.length === 0) throw new TypeError("allowedCwd is required");
    this.#sessionsRoot = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
    this.#archiveRoot = resolve(options.archiveRoot ?? defaultOmpArchiveRoot(this.#sessionsRoot));
    this.#allowedCwd = resolve(options.allowedCwd);
    this.#maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
    this.#maxScanFiles = options.maxScanFiles ?? DEFAULT_SCAN_FILES;
    this.#isResident = options.isResident;
    this.#writeGraceMs = options.writeGraceMs ?? DEFAULT_WRITE_GRACE_MS;
    this.#gcLockStaleMs = options.gcLockStaleMs ?? DEFAULT_GC_LOCK_STALE_MS;
    this.#now = options.now ?? (() => new Date());
    this.#renameFile = options.renameFile ?? rename;
    this.#removeFile = options.removeFile ?? rm;
    if (!Number.isSafeInteger(this.#maxSessionBytes) || this.#maxSessionBytes <= 0) {
      throw new TypeError("maxSessionBytes must be positive");
    }
    if (!Number.isSafeInteger(this.#maxScanFiles) || this.#maxScanFiles <= 0) {
      throw new TypeError("maxScanFiles must be positive");
    }
  }

  async archive(sessionId: string, options?: { readonly skipWriteGrace?: boolean }): Promise<SessionArchiveMoveResult> {
    if (sessionId.length === 0) throw new SessionArchiveServiceError("SESSION_NOT_FOUND", "Session id is required");
    await this.#assertGcLockIdle();
    await this.#assertNotResident(sessionId);
    if ((await this.#findInArchive(sessionId)) !== undefined) {
      throw new SessionArchiveServiceError("SESSION_ALREADY_ARCHIVED", "Session is already archived");
    }
    const source = await this.#locateUnique(
      await this.#listSessionsTree(),
      (file) => readPlainSessionHeader(file),
      sessionId,
      "Session is not available in the sessions tree",
    );
    this.#assertWorkspace(source);

    const metadata = await lstat(source.path).catch(() => undefined);
    if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) {
      throw new SessionArchiveServiceError("SESSION_NOT_FOUND", "Session file is not readable");
    }
    if (metadata.size > this.#maxSessionBytes) {
      throw new SessionArchiveServiceError("SESSION_TOO_LARGE", "Session exceeds the configured archive limit");
    }
    if (options?.skipWriteGrace !== true && this.#now().getTime() - metadata.mtimeMs < this.#writeGraceMs) {
      throw new SessionArchiveServiceError(
        "SESSION_RECENTLY_WRITTEN",
        "Session was written recently; retry shortly so a crash tail cannot be archived",
      );
    }

    const relativePath = relative(this.#sessionsRoot, source.path);
    const destSession = join(this.#archiveRoot, `${relativePath}.gz`);
    const legacyDestSession = join(this.#archiveRoot, relativePath);
    const sourceArtifacts = artifactsPathFor(source.path);
    const destArtifacts = artifactsPathFor(destSession);
    if ((await pathExists(destSession)) || (await pathExists(legacyDestSession))) {
      throw new SessionArchiveServiceError("DESTINATION_EXISTS", "Archive destination already exists");
    }
    if ((await pathExists(sourceArtifacts)) && (await pathExists(destArtifacts))) {
      throw new SessionArchiveServiceError("DESTINATION_EXISTS", "Archive artifacts destination already exists");
    }

    const undo: Array<() => Promise<void>> = [];
    try {
      await this.#gzipMove(source.path, destSession);
      undo.push(async () => {
        await this.#gunzipMove(destSession, source.path);
      });
      if (await pathExists(sourceArtifacts)) {
        await movePath(sourceArtifacts, destArtifacts);
        undo.push(async () => {
          await movePath(destArtifacts, sourceArtifacts);
        });
      }
    } catch (error) {
      await rollback(undo, error);
      throw error;
    }
    return { sessionId, archived: true };
  }

  async unarchive(sessionId: string): Promise<SessionArchiveMoveResult> {
    if (sessionId.length === 0) throw new SessionArchiveServiceError("SESSION_NOT_FOUND", "Session id is required");
    await this.#assertGcLockIdle();
    await this.#assertNotResident(sessionId);
    const source = await this.#locateUnique(
      await this.#listArchiveTree(),
      (file) => readGzSessionHeader(file, this.#maxSessionBytes),
      sessionId,
      "Session is not available in the archive tree",
    );
    if ((await this.#findInSessions(sessionId)) !== undefined) {
      throw new SessionArchiveServiceError("DESTINATION_EXISTS", "Session already exists in the sessions tree");
    }
    this.#assertWorkspace(source);

    const relativePath = relative(this.#archiveRoot, source.path);
    if (!relativePath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
      throw new SessionArchiveServiceError("IO_ERROR", "Archived session has an unexpected layout");
    }
    const destSession = join(this.#sessionsRoot, relativePath.slice(0, -".gz".length));
    const sourceArtifacts = artifactsPathFor(source.path);
    const destArtifacts = artifactsPathFor(destSession);
    if (await pathExists(destSession)) {
      throw new SessionArchiveServiceError("DESTINATION_EXISTS", "Sessions destination already exists");
    }
    if ((await pathExists(sourceArtifacts)) && (await pathExists(destArtifacts))) {
      throw new SessionArchiveServiceError("DESTINATION_EXISTS", "Sessions artifacts destination already exists");
    }

    const undo: Array<() => Promise<void>> = [];
    try {
      await this.#gunzipMove(source.path, destSession);
      undo.push(async () => {
        await rm(destSession, { force: true });
      });
      if (await pathExists(sourceArtifacts)) {
        await movePath(sourceArtifacts, destArtifacts);
        undo.push(async () => {
          await movePath(destArtifacts, sourceArtifacts);
        });
      }
    } catch (error) {
      await rollback(undo, error);
      throw error;
    }
    return { sessionId, archived: false };
  }

  #assertWorkspace(source: LocatedSession): void {
    if (source.cwd === undefined || !sameWorkspace(source.cwd, this.#allowedCwd)) {
      throw new SessionArchiveServiceError("WORKSPACE_MISMATCH", "Session does not belong to the selected workspace");
    }
  }

  async #assertGcLockIdle(): Promise<void> {
    const lockPath = join(dirname(this.#sessionsRoot), GC_LOCK_NAME);
    const metadata = await lstat(lockPath).catch(() => undefined);
    if (metadata === undefined) return;
    if (this.#now().getTime() - metadata.mtimeMs < this.#gcLockStaleMs) {
      throw new SessionArchiveServiceError("GC_LOCK_HELD", "omp gc appears to be running; retry after it finishes");
    }
  }

  async #assertNotResident(sessionId: string): Promise<void> {
    if (this.#isResident === undefined) return;
    if (await this.#isResident(sessionId)) {
      throw new SessionArchiveServiceError("SESSION_RESIDENT", "Session is resident in a Runtime and cannot be moved");
    }
  }

  async #listSessionsTree(): Promise<string[]> {
    return await listFilesWithSuffix(this.#sessionsRoot, SESSION_SUFFIX, this.#maxScanFiles);
  }

  async #listArchiveTree(): Promise<string[]> {
    return await listFilesWithSuffix(this.#archiveRoot, COMPRESSED_SESSION_SUFFIX, this.#maxScanFiles);
  }

  async #findInSessions(sessionId: string): Promise<LocatedSession | undefined> {
    const files = await this.#listSessionsTree();
    return await findOne(files, (file) => readPlainSessionHeader(file), sessionId);
  }

  async #findInArchive(sessionId: string): Promise<LocatedSession | undefined> {
    const files = await this.#listArchiveTree();
    return await findOne(files, (file) => readGzSessionHeader(file, this.#maxSessionBytes), sessionId);
  }

  async #locateUnique(
    files: string[],
    readHeader: (file: string) => Promise<{ id: string; cwd?: string } | undefined>,
    sessionId: string,
    notFoundMessage: string,
  ): Promise<LocatedSession> {
    const located = await findOne(files, readHeader, sessionId);
    if (located === undefined) {
      throw new SessionArchiveServiceError("SESSION_NOT_FOUND", notFoundMessage);
    }
    return located;
  }

  async #gzipMove(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    // Snapshot the source tail before the move so the fresh gz can carry
    // the transcript's last-active mtime (see #restoreSessionMtime).
    const tail = await readPlainSessionTail(from, TAIL_SCAN_BYTES);
    const temp = `${to}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(createReadStream(from), createGzip({ level: 9 }), createWriteStream(temp, { mode: 0o600 }));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await this.#commitStagedMove(from, to, temp);
    if (tail !== undefined) await this.#restoreSessionMtime(to, tail);
  }

  async #gunzipMove(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    let decompressed: Buffer;
    try {
      decompressed = await readGunzipCapped(from, this.#maxSessionBytes);
    } catch (error) {
      if (error instanceof GzipFileError) {
        const code = error.code === "TOO_LARGE" ? "SESSION_TOO_LARGE" : "IO_ERROR";
        throw new SessionArchiveServiceError(code, error.message);
      }
      throw error;
    }
    const temp = `${to}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, decompressed, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    await this.#commitStagedMove(from, to, temp);
    await this.#restoreSessionMtime(to, decompressed);
  }

  /**
   * Commit a prepared move: rename the source to an undiscoverable staging
   * name, land the prepared destination, then discard the staging copy. A
   * locked source fails before anything is written; a staging copy that
   * cannot be deleted is inert (no scan suffix match) and never leaves the
   * session visible in both trees at once.
   */
  async #commitStagedMove(from: string, to: string, temp: string): Promise<void> {
    const staged = `${from}.${process.pid}.${Date.now()}${STAGING_SUFFIX}`;
    try {
      await this.#renameWithRetry(from, staged);
      await this.#renameFile(temp, to);
    } catch (error) {
      await rm(temp, { force: true });
      await this.#renameFile(staged, from).catch(() => undefined);
      throw error;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.#removeFile(staged, { force: true });
        return;
      } catch {
        if (attempt === 4) return;
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }

  /** rename() can hit transient EPERM/EACCES on Windows while scanners hold files. */
  async #renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await this.#renameFile(from, to);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
          if (attempt < 4) {
            await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
            continue;
          }
        }
        throw error;
      }
    }
  }

  /**
   * A session restored by unarchive was written just now, so its mtime would
   * trip the crash-writer grace window on an immediate re-archive. Restore
   * the mtime from the transcript's last entry timestamp (clamped below the
   * grace window) so the file reflects its real last-active time and
   * re-archiving is not misrejected. Sessions whose content cannot be parsed
   * keep their write time, where the grace check remains the honest guard.
   */
  async #restoreSessionMtime(file: string, bytes: Buffer): Promise<void> {
    const contentTime = lastEntryTimestampMs(bytes);
    if (contentTime === undefined) return;
    const upper = this.#now().getTime() - this.#writeGraceMs - 1_000;
    const mtime = new Date(Math.min(contentTime, upper));
    try {
      await utimes(file, mtime, mtime);
    } catch {
      // Best-effort only; the grace check still guards unknown writers.
    }
  }
}

function artifactsPathFor(sessionPath: string): string {
  if (sessionPath.endsWith(COMPRESSED_SESSION_SUFFIX)) {
    return sessionPath.slice(0, -COMPRESSED_SESSION_SUFFIX.length);
  }
  return sessionPath.slice(0, -SESSION_SUFFIX.length);
}

async function findOne(
  files: string[],
  readHeader: (file: string) => Promise<{ id: string; cwd?: string } | undefined>,
  sessionId: string,
): Promise<LocatedSession | undefined> {
  const matches: LocatedSession[] = [];
  for (const file of files) {
    const header = await readHeader(file);
    if (header?.id === sessionId) matches.push({ path: file, ...(header.cwd === undefined ? {} : { cwd: header.cwd }) });
  }
  if (matches.length > 1) {
    throw new SessionArchiveServiceError("SESSION_DUPLICATE", "Session identity is duplicated; refusing an ambiguous move");
  }
  return matches[0];
}

async function listFilesWithSuffix(root: string, suffix: string, limit: number): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  const add = (path: string): void => {
    if (files.length >= limit) {
      throw new SessionArchiveServiceError("IO_ERROR", "Session scan exceeds the configured file limit");
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
    let children;
    try {
      children = await readdir(candidate, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.isFile() && !child.isSymbolicLink() && child.name.endsWith(suffix)) add(join(candidate, child.name));
    }
  }
  return files.sort();
}

/** Read the tail of a plain session file, bounded, for mtime restoration. */
async function readPlainSessionTail(file: string, tailBytes: number): Promise<Buffer | undefined> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const length = Math.min(tailBytes, metadata.size);
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, metadata.size - length);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function readPlainSessionHeader(file: string): Promise<{ id: string; cwd?: string } | undefined> {
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(HEADER_PREFIX_BYTES, metadata.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return parseSessionHeaderFromText(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function readGzSessionHeader(file: string, maxSessionBytes: number): Promise<{ id: string; cwd?: string } | undefined> {
  try {
    const prefix = await readGunzipPrefix(file, HEADER_PREFIX_BYTES, maxSessionBytes);
    return parseSessionHeaderFromText(prefix.toString("utf8"));
  } catch {
    return undefined;
  }
}

function parseSessionHeaderFromText(text: string): { id: string; cwd?: string } | undefined {
  for (const line of text.split(/\r?\n/u).slice(0, 8)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === "session" &&
      typeof (value as Record<string, unknown>).id === "string" &&
      ((value as Record<string, unknown>).id as string).length > 0
    ) {
      const record = value as Record<string, unknown>;
      const cwd = typeof record.cwd === "string" && record.cwd.length > 0 ? record.cwd : undefined;
      return { id: record.id as string, ...(cwd === undefined ? {} : { cwd }) };
    }
  }
  return undefined;
}

/** Last entry timestamp in a complete JSONL transcript, if any. */
function lastEntryTimestampMs(bytes: Buffer): number | undefined {
  if (bytes.length === 0) return undefined;
  const newline = bytes.lastIndexOf(0x0a);
  const text = newline >= 0 ? bytes.subarray(0, newline + 1).toString("utf8") : "";
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim();
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).timestamp === "string"
      ) {
        const time = Date.parse((value as Record<string, unknown>).timestamp as string);
        if (Number.isFinite(time)) return time;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function movePath(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  await cp(source, destination, { recursive: true });
  await rm(source, { recursive: true, force: true });
}

/**
 * Best-effort reverse execution; rollback failures are swallowed so the
 * original error survives (same policy as `omp gc`).
 */
async function rollback(undo: Array<() => Promise<void>>, original: unknown): Promise<void> {
  for (const step of undo.reverse()) {
    try {
      await step();
    } catch {
      void original;
    }
  }
}

function sameWorkspace(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
