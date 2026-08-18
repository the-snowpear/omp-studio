import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readdir, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  CONVERSATION_LIMITS,
  CONVERSATION_REDACT_KEY_PATTERN,
  publicConversationToolCallId,
  type ConversationContentBlock,
  type ConversationItem,
  type JsonValue,
  type OpaqueCursor,
  type SessionId,
} from "@omp-studio/studio-protocol";

import { GzipFileError, readGunzipCapped, readGunzipPrefix } from "./gzip-file.js";
import { defaultOmpArchiveRoot } from "./session-catalog.js";

const CURSOR_NAMESPACE = "session.archive.v1";
const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_SCAN_FILES = 20_000;
const DEFAULT_SNAPSHOT_CACHE_SIZE = 8;

export interface SessionArchiveReadInput {
  readonly sessionId: string;
  readonly cursor?: OpaqueCursor;
  readonly limit?: number;
}

/** Runtime-independent persistent transcript page returned by the Host/Broker read plane. */
export interface SessionArchiveTranscriptPage {
  readonly sessionId: SessionId;
  readonly transcriptRevision: string;
  readonly branchLeafId: string | null;
  readonly items: readonly ConversationItem[];
  readonly olderCursor?: OpaqueCursor;
  readonly headCursor: OpaqueCursor;
  readonly hasMoreBefore: boolean;
}

/** Identity + revision of an archived session, without transcript content. */
export interface SessionArchiveRevision {
  readonly sessionId: string;
  readonly transcriptRevision: string;
}

/**
 * A validated, crash-tail-trimmed copy of an archived session transcript.
 * `temporarySessionFile` is Host-internal: it must never reach the Client
 * Contract, events, the Renderer, or logs.
 */
export interface SessionArchiveProbeCopy extends SessionArchiveRevision {
  readonly temporarySessionFile: string;
}

export type SessionArchiveErrorCode =
  | "SESSION_NOT_FOUND"
  | "SESSION_DUPLICATE"
  | "SESSION_CORRUPT"
  | "SESSION_TOO_LARGE"
  | "WORKSPACE_MISMATCH"
  | "CURSOR_INVALID"
  | "CURSOR_STALE";

export class SessionArchiveError extends Error {
  constructor(readonly code: SessionArchiveErrorCode, message: string) {
    super(message);
    this.name = "SessionArchiveError";
  }
}

export interface SessionArchiveReaderOptions {
  readonly sessionsRoot?: string;
  /** Cold-archive root (`<agentDir>/archive/sessions`); `.jsonl.gz` members are readable too. */
  readonly archiveRoot?: string;
  readonly allowedCwd: string;
  readonly maxSessionBytes?: number;
  readonly maxScanFiles?: number;
  readonly cursorSecret?: Buffer;
}

type ArchiveEntry = Record<string, unknown> & {
  id: string;
  parentId: string | null;
  type: string;
};

type ArchiveSnapshot = {
  sessionId: string;
  transcriptRevision: string;
  branchLeafId: string | null;
  entries: ArchiveEntry[];
};

type FileVersion = string;

type IndexedHeader = {
  readonly id: string;
  readonly version: FileVersion;
};

type CachedSnapshot = {
  readonly version: FileVersion;
  readonly snapshot: ArchiveSnapshot;
};

type CursorPayload = {
  namespace: typeof CURSOR_NAMESPACE;
  sessionId: string;
  transcriptRevision: string;
  branchLeafId: string;
  boundary: string;
};

/**
 * Reads an OMP session without starting/resuming a Runtime.
 *
 * The reader snapshots one already-open file handle, ignores only an
 * incomplete append tail, rejects malformed interior records, validates the
 * workspace header, and never exposes the resolved file path.
 */
export class StudioSessionArchiveReader {
  readonly #sessionsRoot: string;
  readonly #archiveRoot: string;
  readonly #allowedCwd: string;
  readonly #maxSessionBytes: number;
  readonly #maxScanFiles: number;
  readonly #cursorSecret: Buffer;
  /** Directory enumeration is cheap; header reads are not. Keep the index while paths are stable. */
  #indexedPaths: readonly string[] | undefined;
  #sessionIndex = new Map<string, string[]>();
  #indexedVersions = new Map<string, FileVersion>();
  #indexBuildInFlight: Promise<void> | undefined;
  /** Parsed snapshots are shared by paging and repeated session switches. */
  #snapshotCache = new Map<string, CachedSnapshot>();
  #snapshotInFlight = new Map<string, { version: FileVersion | undefined; promise: Promise<{ snapshot: ArchiveSnapshot; version: FileVersion }> }>();

  constructor(options: SessionArchiveReaderOptions) {
    if (options.allowedCwd.length === 0) throw new TypeError("allowedCwd is required");
    this.#sessionsRoot = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
    this.#archiveRoot = resolve(options.archiveRoot ?? defaultOmpArchiveRoot(this.#sessionsRoot));
    this.#allowedCwd = resolve(options.allowedCwd);
    this.#maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
    this.#maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.#cursorSecret = options.cursorSecret ?? randomBytes(32);
    if (!Number.isSafeInteger(this.#maxSessionBytes) || this.#maxSessionBytes <= 0) {
      throw new TypeError("maxSessionBytes must be positive");
    }
    if (!Number.isSafeInteger(this.#maxScanFiles) || this.#maxScanFiles <= 0) {
      throw new TypeError("maxScanFiles must be positive");
    }
  }

  async readPage(input: SessionArchiveReadInput): Promise<SessionArchiveTranscriptPage> {
    if (input.sessionId.length === 0) throw new SessionArchiveError("SESSION_NOT_FOUND", "Session id is required");
    const limit = input.limit ?? CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_DEFAULT;
    if (
      !Number.isSafeInteger(limit) ||
      limit < CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MIN ||
      limit > CONVERSATION_LIMITS.TRANSCRIPT_LIMIT_MAX
    ) {
      throw new SessionArchiveError("CURSOR_INVALID", "Transcript limit is invalid");
    }
    const file = await this.#locate(input.sessionId);
    const snapshot = await this.#readSnapshot(file, input.sessionId);
    const branch = activeBranch(snapshot.entries, snapshot.branchLeafId);
    const items = projectBranch(branch);
    let endExclusive = items.length;
    if (input.cursor !== undefined) {
      const cursor = this.#decodeCursor(input.cursor);
      if (
        cursor.sessionId !== snapshot.sessionId ||
        cursor.transcriptRevision !== snapshot.transcriptRevision ||
        cursor.branchLeafId !== (snapshot.branchLeafId ?? "")
      ) {
        throw new SessionArchiveError("CURSOR_STALE", "Transcript cursor belongs to another revision or branch");
      }
      if (cursor.boundary.length === 0) {
        // The head cursor of an empty projection carries an empty boundary;
        // paging before it yields an empty page, matching the online service.
        endExclusive = 0;
      } else {
        const boundaryIndex = items.findIndex((item) => item.itemId === cursor.boundary);
        if (boundaryIndex < 0) throw new SessionArchiveError("CURSOR_STALE", "Transcript cursor boundary is stale");
        endExclusive = boundaryIndex;
      }
    }
    const start = Math.max(0, endExclusive - limit);
    let pageItems = items.slice(start, endExclusive);
    let hasMoreBefore = start > 0;
    const cursorBase = {
      sessionId: snapshot.sessionId,
      transcriptRevision: snapshot.transcriptRevision,
      branchLeafId: snapshot.branchLeafId ?? "",
    };
    const headCursor = this.#encodeCursor({
      ...cursorBase,
      boundary: items.at(-1)?.itemId ?? "",
    });
    const pageOf = (): SessionArchiveTranscriptPage => ({
      sessionId: snapshot.sessionId as SessionId,
      transcriptRevision: snapshot.transcriptRevision,
      branchLeafId: snapshot.branchLeafId,
      items: pageItems,
      ...(hasMoreBefore && pageItems[0] !== undefined
        ? { olderCursor: this.#encodeCursor({ ...cursorBase, boundary: pageItems[0].itemId }) }
        : {}),
      headCursor,
      hasMoreBefore,
    });
    // The transport rejects pages above PAGE_MAX_BYTES, so an over-budget page
    // must be shrunk here or large archived sessions become unreadable. Mirrors
    // the online StudioSessionTranscriptService shrink behaviour.
    let page = pageOf();
    while (Buffer.byteLength(JSON.stringify(page), "utf8") > CONVERSATION_LIMITS.PAGE_MAX_BYTES && pageItems.length > 1) {
      pageItems = pageItems.slice(1);
      hasMoreBefore = true;
      page = pageOf();
    }
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > CONVERSATION_LIMITS.PAGE_MAX_BYTES && pageItems.length === 1) {
      pageItems = [shrinkItem(pageItems[0]!)];
      page = pageOf();
    }
    return page;
  }

  /** Returns the current archive revision of a session without reading its content. */
  async readRevision(sessionId: string): Promise<SessionArchiveRevision> {
    if (sessionId.length === 0) throw new SessionArchiveError("SESSION_NOT_FOUND", "Session id is required");
    const file = await this.#locate(sessionId);
    const snapshot = await this.#readSnapshot(file, sessionId);
    return { sessionId: snapshot.sessionId, transcriptRevision: snapshot.transcriptRevision };
  }

  /**
   * Writes the validated complete JSONL prefix of a session into a
   * Host-controlled directory and returns the copy path. The original file is
   * only ever opened read-only; an incomplete crash tail is dropped, but a
   * malformed interior record still fails closed via the snapshot validation.
   */
  async createProbeCopy(sessionId: string, destinationDirectory: string): Promise<SessionArchiveProbeCopy> {
    if (sessionId.length === 0) throw new SessionArchiveError("SESSION_NOT_FOUND", "Session id is required");
    if (typeof destinationDirectory !== "string" || !isAbsolute(destinationDirectory)) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Probe copy destination must be an absolute directory");
    }
    const destination = await lstat(destinationDirectory).catch(() => undefined);
    if (destination === undefined || !destination.isDirectory() || destination.isSymbolicLink()) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Probe copy destination is not a usable directory");
    }
    const file = await this.#locate(sessionId);
    const { snapshot, version } = await this.#readSnapshotVersioned(file, sessionId);
    const prefix = await this.#readCompletePrefix(file, version);
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64) || "session";
    const temporarySessionFile = join(destinationDirectory, `probe-${randomBytes(8).toString("hex")}-${safeId}.jsonl`);
    await writeFile(temporarySessionFile, prefix, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return {
      sessionId: snapshot.sessionId,
      transcriptRevision: snapshot.transcriptRevision,
      temporarySessionFile,
    };
  }

	async #locate(sessionId: string): Promise<string> {
    const candidates = await listSessionFiles({ sessions: this.#sessionsRoot, archive: this.#archiveRoot }, this.#maxScanFiles);
    await this.#ensureIndex(candidates);
    let matches = this.#sessionIndex.get(sessionId) ?? [];
    if (matches.length === 1) {
      const path = matches[0]!;
      const currentVersion = await readFileVersion(path, this.#maxSessionBytes);
      if (currentVersion === this.#indexedVersions.get(path)) return path;
      const header = await readHeader(path, Math.min(this.#maxSessionBytes, 64 * 1024), this.#maxSessionBytes);
      if (header?.id === sessionId) {
        this.#indexedVersions.set(path, header.version);
        return path;
      }
      // A file was replaced in place. Rebuild once so the new identity is visible.
      await this.#ensureIndex(candidates, true);
      matches = this.#sessionIndex.get(sessionId) ?? [];
    }
    if (matches.length === 0) throw new SessionArchiveError("SESSION_NOT_FOUND", "Session is not available");
    if (matches.length > 1) {
      throw new SessionArchiveError("SESSION_DUPLICATE", "Session identity is duplicated; refusing an ambiguous read");
    }
    return matches[0]!;
  }

  async #readSnapshot(path: string, expectedSessionId: string): Promise<ArchiveSnapshot> {
    const { snapshot } = await this.#readSnapshotVersioned(path, expectedSessionId);
    return snapshot;
  }

  async #readSnapshotVersioned(path: string, expectedSessionId: string): Promise<{ snapshot: ArchiveSnapshot; version: FileVersion }> {
    const cached = this.#snapshotCache.get(path);
    const indexedVersion = this.#indexedVersions.get(path);
    if (cached !== undefined && indexedVersion === cached.version) return { snapshot: cached.snapshot, version: cached.version };
    const pending = this.#snapshotInFlight.get(path);
    if (pending !== undefined && pending.version === indexedVersion) return pending.promise;
    const read = this.#readSnapshotUncached(path, expectedSessionId)
      .then(({ snapshot, version }) => {
        this.#snapshotCache.delete(path);
        this.#snapshotCache.set(path, { snapshot, version });
        while (this.#snapshotCache.size > DEFAULT_SNAPSHOT_CACHE_SIZE) {
          const oldest = this.#snapshotCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.#snapshotCache.delete(oldest);
        }
        this.#indexedVersions.set(path, version);
        return { snapshot, version };
      })
      .finally(() => {
        if (this.#snapshotInFlight.get(path)?.promise === read) this.#snapshotInFlight.delete(path);
      });
    this.#snapshotInFlight.set(path, { version: indexedVersion, promise: read });
    return read;
  }

  /** Second, identity-checked read used only by the probe-copy path. */
  async #readCompletePrefix(path: string, expectedVersion: FileVersion): Promise<Buffer> {
    const { bytes, version } = await this.#readWholeFile(path);
    if (version !== expectedVersion) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session changed identity while it was being read");
    }
    return completeJsonlPrefix(bytes).bytes;
  }

  /**
   * Whole-file read with identity checks. Plain sessions stream through one
   * already-open handle; cold-archive `.jsonl.gz` members are decompressed
   * under the same byte cap and identified by the compressed file's stat.
   */
  async #readWholeFile(path: string): Promise<{
    bytes: Buffer;
    identity: { dev: number | bigint; ino: number | bigint };
    version: FileVersion;
  }> {
    if (isCompressedSessionPath(path)) {
      let before;
      try {
        before = await lstat(path);
      } catch {
        throw new SessionArchiveError("SESSION_NOT_FOUND", "Session is not available");
      }
      if (!before.isFile() || before.isSymbolicLink()) {
        throw new SessionArchiveError("SESSION_CORRUPT", "Session is not a regular file");
      }
      if (before.size > this.#maxSessionBytes) {
        throw new SessionArchiveError("SESSION_TOO_LARGE", "Session exceeds the configured read limit");
      }
      let bytes: Buffer;
      try {
        bytes = await readGunzipCapped(path, this.#maxSessionBytes);
      } catch (error) {
        if (error instanceof GzipFileError) {
          throw new SessionArchiveError(
            error.code === "TOO_LARGE" ? "SESSION_TOO_LARGE" : "SESSION_CORRUPT",
            error.message,
          );
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new SessionArchiveError("SESSION_NOT_FOUND", "Session is not available");
        }
        throw new SessionArchiveError("SESSION_CORRUPT", "Archived session could not be read");
      }
      const after = await lstat(path).catch(() => undefined);
      if (after === undefined || fileVersion(after) !== fileVersion(before)) {
        throw new SessionArchiveError("SESSION_CORRUPT", "Session changed identity while it was being read");
      }
      return { bytes, identity: { dev: before.dev, ino: before.ino }, version: fileVersion(after) };
    }
    const handle = await open(path, "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new SessionArchiveError("SESSION_CORRUPT", "Session is not a regular file");
      if (before.size > BigInt(this.#maxSessionBytes)) {
        throw new SessionArchiveError("SESSION_TOO_LARGE", "Session exceeds the configured read limit");
      }
      const size = Number(before.size);
      const buffer = Buffer.alloc(size);
      let offset = 0;
      while (offset < size) {
        const chunk = await handle.read(buffer, offset, size - offset, offset);
        if (chunk.bytesRead === 0) break;
        offset += chunk.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) {
        throw new SessionArchiveError("SESSION_CORRUPT", "Session changed identity while it was being read");
      }
      return { bytes: buffer.subarray(0, offset), identity: { dev: before.dev, ino: before.ino }, version: fileVersion(after) };
    } finally {
      await handle.close();
    }
  }

  async #readSnapshotUncached(path: string, expectedSessionId: string): Promise<{ snapshot: ArchiveSnapshot; version: FileVersion }> {
    const { bytes, identity, version } = await this.#readWholeFile(path);
    const complete = completeJsonlPrefix(bytes);
    const values = parseCompleteJsonl(complete.text);
    const header = values.find((value) => isRecord(value) && value.type === "session");
    if (!isRecord(header) || typeof header.id !== "string" || typeof header.cwd !== "string") {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session header is missing or invalid");
    }
    if (header.id !== expectedSessionId) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session identity changed while it was being read");
    }
    if (!sameWorkspace(header.cwd, this.#allowedCwd)) {
      throw new SessionArchiveError("WORKSPACE_MISMATCH", "Session does not belong to the selected workspace");
    }
    const entries = values.flatMap((value) => {
      const entry = parseEntry(value);
      return entry === undefined ? [] : [entry];
    });
    const branchLeafId = resolveBranchLeaf(entries);
    const revision = createHash("sha256")
      .update(CURSOR_NAMESPACE)
      .update("\0")
      .update(header.id)
      .update("\0")
      .update(String(identity.dev))
      .update(":")
      .update(String(identity.ino))
      .update(":")
      .update(String(complete.byteLength))
      .update("\0")
      .update(complete.bytes)
      .digest("base64url");
    return {
      snapshot: {
        sessionId: header.id,
        transcriptRevision: `sha256:${revision}`,
        branchLeafId,
        entries,
      },
      version,
    };
  }

  #encodeCursor(payload: Omit<CursorPayload, "namespace">): OpaqueCursor {
    const body = Buffer.from(JSON.stringify({ namespace: CURSOR_NAMESPACE, ...payload }), "utf8").toString("base64url");
    const signature = createHmac("sha256", this.#cursorSecret).update(body).digest("base64url");
    return `${body}.${signature}` as OpaqueCursor;
  }

  #decodeCursor(cursor: OpaqueCursor): CursorPayload {
    const [body, supplied, extra] = String(cursor).split(".");
    if (body === undefined || supplied === undefined || extra !== undefined) {
      throw new SessionArchiveError("CURSOR_INVALID", "Transcript cursor is malformed");
    }
    const expected = createHmac("sha256", this.#cursorSecret).update(body).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(supplied, "base64url");
    } catch {
      throw new SessionArchiveError("CURSOR_INVALID", "Transcript cursor signature is malformed");
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new SessionArchiveError("CURSOR_INVALID", "Transcript cursor signature is invalid");
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new SessionArchiveError("CURSOR_INVALID", "Transcript cursor payload is malformed");
    }
    if (
      !isRecord(value) ||
      value.namespace !== CURSOR_NAMESPACE ||
      typeof value.sessionId !== "string" ||
      typeof value.transcriptRevision !== "string" ||
      typeof value.branchLeafId !== "string" ||
      typeof value.boundary !== "string"
    ) {
      throw new SessionArchiveError("CURSOR_INVALID", "Transcript cursor payload is invalid");
    }
    return value as unknown as CursorPayload;
  }

  async #ensureIndex(paths: readonly string[], force = false): Promise<void> {
    if (!force && this.#indexedPaths !== undefined && samePaths(this.#indexedPaths, paths)) return;
    if (this.#indexBuildInFlight !== undefined) {
      await this.#indexBuildInFlight;
      if (!force && this.#indexedPaths !== undefined && samePaths(this.#indexedPaths, paths)) return;
    }
    const build = (async () => {
      const index = new Map<string, string[]>();
      const versions = new Map<string, FileVersion>();
      for (const candidate of paths) {
        const header = await readHeader(candidate, Math.min(this.#maxSessionBytes, 64 * 1024), this.#maxSessionBytes);
        if (header === undefined) continue;
        const list = index.get(header.id);
        if (list === undefined) index.set(header.id, [candidate]);
        else list.push(candidate);
        versions.set(candidate, header.version);
      }
      this.#sessionIndex = index;
      this.#indexedVersions = versions;
      this.#indexedPaths = paths.slice();
    })().finally(() => {
      this.#indexBuildInFlight = undefined;
    });
    this.#indexBuildInFlight = build;
    await build;
  }
}

function defaultOmpSessionsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const agentDirectory = environment.OMP_AGENT_DIR;
  return resolve(agentDirectory === undefined || agentDirectory.length === 0 ? join(homedir(), ".omp", "agent") : agentDirectory, "sessions");
}

async function listSessionFiles(roots: { sessions: string; archive: string }, limit: number): Promise<string[]> {
  const files: string[] = [];
  const add = (path: string): void => {
    if (files.length >= limit) throw new SessionArchiveError("SESSION_CORRUPT", "Session catalog exceeds the scan limit");
    files.push(path);
  };
  await collectTree(roots.sessions, ".jsonl", add);
  await collectTree(roots.archive, ".jsonl.gz", add);
  return files.sort();
}

async function collectTree(root: string, suffix: string, add: (path: string) => void): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
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
}

function isCompressedSessionPath(path: string): boolean {
  return path.endsWith(".jsonl.gz");
}

async function readHeader(path: string, byteLimit: number, maxSessionBytes: number): Promise<IndexedHeader | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return undefined;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxSessionBytes) return undefined;
  let text: string;
  if (isCompressedSessionPath(path)) {
    try {
      const prefix = await readGunzipPrefix(path, byteLimit, maxSessionBytes);
      text = prefix.toString("utf8");
    } catch {
      return undefined;
    }
  } else {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(byteLimit, metadata.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  for (const line of text.split(/\r?\n/u).slice(0, 8)) {
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value) && value.type === "session" && typeof value.id === "string" && value.id.length > 0) {
        return { id: value.id, version: fileVersion(metadata) };
      }
    } catch {
      // A partial prefix line is not a usable header.
    }
  }
  return undefined;
}

async function readFileVersion(path: string, maxSessionBytes: number): Promise<FileVersion | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxSessionBytes) return undefined;
    return fileVersion(metadata);
  } catch {
    return undefined;
  }
}

function fileVersion(stat: { dev: number | bigint; ino: number | bigint; size: number | bigint; mtimeMs: number | bigint }): FileVersion {
  return `${String(stat.dev)}:${String(stat.ino)}:${String(stat.size)}:${String(stat.mtimeMs)}`;
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index]);
}

function completeJsonlPrefix(bytes: Buffer): { bytes: Buffer; text: string; byteLength: number } {
  if (bytes.length === 0) return { bytes, text: "", byteLength: 0 };
  const newline = bytes.lastIndexOf(0x0a);
  if (newline < 0) return { bytes: Buffer.alloc(0), text: "", byteLength: 0 };
  const complete = bytes.subarray(0, newline + 1);
  return { bytes: complete, text: complete.toString("utf8"), byteLength: complete.length };
}

function parseCompleteJsonl(text: string): unknown[] {
  const values: unknown[] = [];
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    if (raw.trim().length === 0) continue;
    try {
      values.push(JSON.parse(raw));
    } catch (error) {
      throw new SessionArchiveError("SESSION_CORRUPT", `Session contains malformed JSON at complete line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return values;
}

function parseEntry(value: unknown): ArchiveEntry | undefined {
  if (!isRecord(value) || value.type === "session" || typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (value.parentId !== null && typeof value.parentId !== "string") return undefined;
  if (typeof value.type !== "string") return undefined;
  return value as ArchiveEntry;
}

function activeBranch(entries: readonly ArchiveEntry[], leafId: string | null): ArchiveEntry[] {
  if (leafId === null) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: ArchiveEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(leafId);
  while (current !== undefined) {
    if (visited.has(current.id)) throw new SessionArchiveError("SESSION_CORRUPT", "Session branch contains a cycle");
    visited.add(current.id);
    branch.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  branch.reverse();
  return branch;
}

function resolveBranchLeaf(entries: readonly ArchiveEntry[]): string | null {
  // Future/runtime-patched sessions can persist the active pointer explicitly.
  // Older OMP sessions fall back to the same physical-tail rule used by the
  // current SessionEntryIndex. Keeping this compatibility path is deliberate;
  // durable active_leaf entries are required before the Broker claims strict
  // crash-consistent branch selection.
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.type === "active_leaf" && typeof entry.targetId === "string" && entry.targetId.length > 0) {
      return entry.targetId;
    }
  }
  return entries.at(-1)?.id ?? null;
}

function unpairedToolCall(
  item: Extract<ConversationItem, { kind: "message" }>,
): Extract<ConversationContentBlock, { type: "toolCall" }> | undefined {
  for (let index = item.content.length - 1; index >= 0; index -= 1) {
    const block = item.content[index];
    if (block?.type !== "toolCall") continue;
    if (item.content.some((entry) => entry.type === "toolResult" && entry.toolCallId === block.toolCallId)) continue;
    return block;
  }
  return undefined;
}

function attachToolResult(
  items: ConversationItem[],
  toolOwners: Map<string, number>,
  result: Extract<ConversationContentBlock, { type: "toolResult" }>,
  parentId: string | null,
  rawToolCallId: string,
): { index: number; result: Extract<ConversationContentBlock, { type: "toolResult" }> } | undefined {
  const ownerIndex = toolOwners.get(result.toolCallId);
  if (ownerIndex !== undefined) {
    const owner = items[ownerIndex];
    if (owner !== undefined && owner.kind === "message") return { index: ownerIndex, result };
  }
  if (rawToolCallId.length > 0 || parentId === null) return undefined;
  const parentIndex = items.findIndex((item) => item.itemId === parentId);
  const parent = parentIndex < 0 ? undefined : items[parentIndex];
  if (parent === undefined || parent.kind !== "message") return undefined;
  const call = unpairedToolCall(parent);
  if (call === undefined) return undefined;
  return { index: parentIndex, result: { ...result, toolCallId: call.toolCallId } };
}

function projectBranch(entries: readonly ArchiveEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const toolOwners = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = isRecord(entry.message) ? entry.message : {};
      if (message.role === "toolResult") {
        const rawId = typeof message.toolCallId === "string" ? message.toolCallId : "";
        const mapped = projectToolResult(message, `tool:${entry.id}`);
        const attached = attachToolResult(items, toolOwners, mapped, entry.parentId, rawId);
        if (attached !== undefined) {
          const owner = items[attached.index];
          if (owner !== undefined && owner.kind === "message") {
            const content = owner.content.some(
              (block) => block.type === "toolResult" && block.toolCallId === attached.result.toolCallId,
            )
              ? owner.content
              : [...owner.content, attached.result];
            items[attached.index] = { ...owner, content };
          }
          continue;
        }
        const toolCall: Extract<ConversationContentBlock, { type: "toolCall" }> = {
          type: "toolCall",
          toolCallId: mapped.toolCallId,
          toolName: mapped.toolName ?? "tool",
        };
        items.push({
          kind: "message",
          itemId: entry.id,
          parentId: entry.parentId,
          createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString(),
          role: "assistant",
          content: [toolCall, mapped],
        });
        continue;
      }
    }
    const projected = projectEntry(entry);
    if (projected === undefined) continue;
    if (projected.kind === "message" && projected.content.length === 0) continue;
    const index = items.length;
    items.push(projected);
    if (projected.kind !== "message") continue;
    for (const block of projected.content) {
      if (block.type === "toolCall") toolOwners.set(block.toolCallId, index);
    }
  }
  return items;
}

function projectEntry(entry: ArchiveEntry): ConversationItem | undefined {
  const createdAt = typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString();
  if (entry.type === "message") {
    const message = isRecord(entry.message) ? entry.message : {};
    if (message.role === "toolResult") {
      return undefined;
    }
    if (isHarnessInjectedUserMessage(message)) return undefined;
    const role =
      message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : undefined;
    if (role === undefined) return undefined;
    return {
      kind: "message",
      itemId: entry.id,
      parentId: entry.parentId,
      createdAt,
      role,
      content: projectContent(message.content, `tool:${entry.id}`),
    };
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return {
      kind: "compaction",
      itemId: entry.id,
      parentId: entry.parentId,
      createdAt,
      summary: sanitizeText(entry.summary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES).text || " ",
      ...(typeof entry.shortSummary === "string" ? { shortSummary: sanitizeText(entry.shortSummary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES).text } : {}),
      ...(typeof entry.warning === "string" ? { warning: sanitizeText(entry.warning, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES).text } : {}),
    };
  }
  if (entry.type === "reset_boundary") {
    return { kind: "resetBoundary", itemId: entry.id, parentId: entry.parentId, createdAt };
  }
  return undefined;
}

function projectContent(value: unknown, fallbackPrefix: string): ConversationContentBlock[] {
  if (typeof value === "string") {
    const text = sanitizeText(value, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
    return [{ type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) }];
  }
  if (!Array.isArray(value)) return [];
  const blocks: ConversationContentBlock[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      const text = sanitizeText(item.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
      blocks.push({ type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      const text = sanitizeText(item.thinking, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
      blocks.push({ type: "thinking", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
    } else if (item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
      const publicId = publicConversationToolCallId(item.id, `${fallbackPrefix}:${blocks.length}`);
      const toolName = sanitizeText(item.name, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
      const args = projectBoundedJson(item.arguments);
      const truncated = publicId.truncated || toolName.truncated || args.truncated;
      blocks.push({
        type: "toolCall",
        toolCallId: publicId.id.length > 0 ? publicId.id : `${fallbackPrefix}:${blocks.length}`,
        toolName: toolName.text.length > 0 ? toolName.text : "tool",
        ...(args.value === undefined ? {} : { arguments: args.value }),
        ...(truncated ? { truncated: true } : {}),
      });
    } else if (item.type === "image") {
      // Binary content never crosses the read plane; the online transcript
      // service emits the same empty truncated marker for image blocks.
      blocks.push({ type: "text", text: "", truncated: true });
    }
  }
  return blocks;
}

function projectToolResult(
  message: Record<string, unknown>,
  fallbackToolCallId: string,
): Extract<ConversationContentBlock, { type: "toolResult" }> {
  const outputs: string[] = [];
  let omittedBinary = false;
  if (typeof message.content === "string") outputs.push(message.content);
  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") outputs.push(item.text);
      else if (isRecord(item) && item.type === "image") omittedBinary = true;
    }
  }
  const output = sanitizeText(outputs.join("\n"), CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
  const details = projectBoundedJson(message.details);
  const rawId = typeof message.toolCallId === "string" ? message.toolCallId : "";
  const publicId = publicConversationToolCallId(rawId, fallbackToolCallId);
  const nameSource = typeof message.toolName === "string" ? message.toolName : undefined;
  const toolName =
    nameSource === undefined ? undefined : sanitizeText(nameSource, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS);
  let truncated =
    output.truncated ||
    details.truncated ||
    publicId.truncated ||
    toolName?.truncated === true ||
    omittedBinary;
  const mapped: Extract<ConversationContentBlock, { type: "toolResult" }> = {
    type: "toolResult",
    toolCallId: publicId.id.length > 0 ? publicId.id : fallbackToolCallId,
    isError: message.isError === true,
  };
  if (toolName !== undefined && toolName.text.length > 0) mapped.toolName = toolName.text;
  if (output.text.length > 0) mapped.output = output.text;
  if (omittedBinary) {
    mapped.data = { omitted: "image" };
    truncated = true;
  }
  if (details.value !== undefined) {
    if (omittedBinary && details.value !== null && typeof details.value === "object" && !Array.isArray(details.value)) {
      mapped.data = { ...(details.value as { readonly [key: string]: JsonValue }), omitted: "image" };
    } else if (omittedBinary) {
      mapped.data = { omitted: "image", details: details.value };
    } else {
      mapped.data = details.value;
    }
  }
  if (truncated) mapped.truncated = true;
  return mapped;
}

/** Byte-bounded JSON projection shared by toolCall arguments and toolResult details. */
function projectBoundedJson(value: unknown): { readonly value?: JsonValue; readonly truncated: boolean } {
  if (value === undefined) return { truncated: false };
  const sanitized = sanitizeJson(value, 0);
  if (sanitized === undefined) return { truncated: true };
  try {
    if (Buffer.byteLength(JSON.stringify(sanitized), "utf8") > CONVERSATION_LIMITS.JSON_VALUE_MAX_BYTES) {
      return { value: { truncated: true }, truncated: true };
    }
  } catch {
    return { value: { truncated: true }, truncated: true };
  }
  return { value: sanitized, truncated: false };
}

function sanitizeJson(value: unknown, depth: number): JsonValue | undefined {
  if (depth > CONVERSATION_LIMITS.JSON_VALUE_MAX_DEPTH) return { truncated: true };
  if (typeof value === "string") return shortenHomePath(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1) ?? null);
  if (!isRecord(value)) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (CONVERSATION_REDACT_KEY_PATTERN.test(key)) result[key] = "[redacted]";
    else {
      const safe = sanitizeJson(item, depth + 1);
      if (safe !== undefined) result[key] = safe;
    }
  }
  return result;
}

function truncateText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { text: value, truncated: false };
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Mirrors the Runtime conversation-sanitizer `shortenHomePath`: only a leading
 * home prefix is rewritten, keeping archived transcripts free of absolute home
 * paths just like the online read plane.
 */
function shortenHomePath(filePath: string, homeDir = homedir()): string {
  if (!homeDir) return filePath;
  if (!filePath.startsWith(homeDir)) return filePath;
  const suffix = filePath.slice(homeDir.length);
  if (suffix === "" || suffix.startsWith("/") || suffix.startsWith("\\")) {
    return `~${suffix.replaceAll("\\", "/")}`;
  }
  return filePath;
}

function sanitizeText(value: string, maxBytes: number): { text: string; truncated: boolean } {
  return truncateText(shortenHomePath(value), maxBytes);
}

/** Last-resort reduction when a single item alone exceeds the page budget. */
function shrinkItem(item: ConversationItem): ConversationItem {
  if (item.kind === "message") {
    return {
      ...item,
      content: item.content.map((block) => {
        if (block.type === "text" || block.type === "thinking") {
          const text = truncateText(block.text, Math.min(256, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES));
          return { ...block, text: text.text, truncated: true };
        }
        if (block.type === "toolCall") return { ...block, arguments: { truncated: true }, truncated: true };
        const { output: _output, ...rest } = block;
        return { ...rest, data: { truncated: true }, truncated: true };
      }),
    };
  }
  if (item.kind === "compaction") {
    const summary = truncateText(item.summary, 256);
    return {
      kind: "compaction",
      itemId: item.itemId,
      parentId: item.parentId,
      createdAt: item.createdAt,
      summary: summary.text.length > 0 ? summary.text : " ",
    };
  }
  return item;
}

function sameWorkspace(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches overlay `conversation-visibility.ts`: drop developer/custom and synthetic/steering user rows. */
function isHarnessInjectedUserMessage(message: Record<string, unknown>): boolean {
  return message.role === "user" && (message.synthetic === true || message.steering === true);
}
