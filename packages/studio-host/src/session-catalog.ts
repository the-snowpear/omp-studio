import { open, readdir, lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { readGunzipPrefix } from "./gzip-file.js";
import { sameWorkspacePath, workspacePathKey } from "./workspace-path.js";

const STUDIO_SESSION_ORIGIN = "studio-host";
const SESSION_PINS_FILENAME = "session-pins.json";
const DEFAULT_PREFIX_BYTES = 64 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;

/** Optional pin metadata must never be able to make history discovery unbounded. */
export const SESSION_PINS_MAX_BYTES = 64 * 1024;
export const SESSION_PINS_MAX_ENTRIES = 1_024;
export const SESSION_PIN_ID_MAX_CHARS = 256;

export type CatalogSessionOrigin = "studio" | "cli" | "unknown";

export interface SessionCatalogEntry {
  sessionId: string;
  /** Present for a lookup across registered workspaces. */
  workspaceId?: string;
  origin: CatalogSessionOrigin;
  /** True when the entry comes from the OMP cold-archive tree (`.jsonl.gz`). */
  archived: boolean;
  /** True when OMP's global session pin set contains this session id. */
  pinned: boolean;
  title?: string;
  createdAt?: string;
  /**
   * Last conversation activity (timestamp of the newest recorded
   * message/displayed-custom-message entry), falling back to the file mtime
   * when the tail carries no readable conversation entry. Opening or
   * disposing a session appends Runtime markers (`session_exit`, …) that bump
   * the mtime but must not reorder the list or reset its displayed time.
   */
  modifiedAt: string;
  sizeBytes: number;
}

export type SessionCatalogDiagnosticCode =
  | "ROOT_UNAVAILABLE"
  | "SYMLINK_SKIPPED"
  | "OVERSIZE_SKIPPED"
  | "CORRUPT_SKIPPED"
  | "DUPLICATE_SESSION_ID";

export interface SessionCatalogDiagnostic {
  code: SessionCatalogDiagnosticCode;
  count: number;
}

export interface SessionCatalogResult {
  sessions: SessionCatalogEntry[];
  diagnostics: SessionCatalogDiagnostic[];
}

export interface SessionCatalogOptions {
  /** OMP's sessions root or one project-specific session directory. */
  sessionsRoot?: string;
  /** Agent root containing `session-pins.json`; defaults beside `sessionsRoot`. */
  agentDir?: string;
  /** Cold-archive root scanned for `.jsonl.gz`; defaults to the omp gc layout. */
  archiveRoot?: string;
  /**
   * When set, only sessions whose header `cwd` resolves to this workspace are
   * returned. The comparison is internal — `cwd` is never copied onto entries.
   */
  allowedCwd?: string;
  /** Include sessions with no conversation messages when sweeping a workspace. */
  includeEmptySessions?: boolean;
  /** Find this exact id across registered workspaces in one catalog scan. */
  locate?: { readonly sessionId: string; readonly workspaces: readonly { workspaceId: string; canonicalPath: string }[] };
  /** Includes ordinary/unmarked OMP CLI sessions and unknown future origins. */
  includeCliSessions?: boolean;
  maxSessionBytes?: number;
  prefixBytes?: number;
}

interface ParsedHeader {
  id: string;
  /** Runtime metadata alone is not a conversation; at least one message must exist. */
  hasConversationMessage: boolean;
  timestamp?: string;
  title?: string;
  studioOrigin?: string;
  cwd?: string;
}

export function defaultOmpSessionsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(defaultOmpAgentDir(environment), "sessions");
}

/** OMP's agent root, shared by sessions and the global session pin file. */
export function defaultOmpAgentDir(environment: NodeJS.ProcessEnv = process.env): string {
  const agentDirectory = environment.OMP_AGENT_DIR;
  return resolve(agentDirectory === undefined || agentDirectory.length === 0 ? join(homedir(), ".omp", "agent") : agentDirectory);
}

/** Mirrors `omp gc`: the cold archive is a sibling of the sessions root. */
export function defaultOmpArchiveRoot(sessionsRoot: string): string {
  return join(dirname(sessionsRoot), "archive", "sessions");
}

/**
 * Read-only OMP conversation discovery. It reads only a bounded prefix, never
 * returns filesystem paths, and does not modify/migrate OMP's session tree.
 */
export async function scanSessionCatalog(options: SessionCatalogOptions = {}): Promise<SessionCatalogResult> {
  const root = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
  const agentDir = resolve(options.agentDir ?? (options.sessionsRoot === undefined ? defaultOmpAgentDir() : dirname(root)));
  const archiveRoot = resolve(options.archiveRoot ?? defaultOmpArchiveRoot(root));
  const includeCliSessions = options.includeCliSessions ?? false;
  const allowedCwd = options.allowedCwd;
  const lookup = options.locate;
  const workspaceIds = lookup && new Map(lookup.workspaces.map(workspace =>
    [workspacePathKey(workspace.canonicalPath), workspace.workspaceId],
  ));
  if (workspaceIds?.size === 0) return { sessions: [], diagnostics: [] };
  const maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const prefixBytes = options.prefixBytes ?? DEFAULT_PREFIX_BYTES;
  if (!Number.isSafeInteger(maxSessionBytes) || maxSessionBytes <= 0) throw new TypeError("maxSessionBytes must be positive");
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0) throw new TypeError("prefixBytes must be positive");
  const pinnedSessionIds = await loadPinnedSessionIds(agentDir);

  const counts = new Map<SessionCatalogDiagnosticCode, number>();
  const note = (code: SessionCatalogDiagnosticCode): void => {
    counts.set(code, (counts.get(code) ?? 0) + 1);
  };
  const files = await listCandidateFiles(root, note);
  const archivedFiles = await listArchivedCandidateFiles(archiveRoot);
  const byId = new Map<string, SessionCatalogEntry>();

  // Headers are read concurrently and merged in file order afterwards, so the
  // duplicate-id winner stays the same as a sequential scan.
  const consider = async (file: string, archived: boolean): Promise<ConsideredFile> => {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(file);
    } catch {
      return { note: "CORRUPT_SKIPPED" };
    }
    if (metadata.isSymbolicLink()) return { note: "SYMLINK_SKIPPED" };
    if (!metadata.isFile()) return {};
    if (metadata.size > maxSessionBytes) return { note: "OVERSIZE_SKIPPED" };
    const header = await cachedSessionHeader(file, metadata, archived ? prefixBytes : Math.min(prefixBytes, metadata.size), maxSessionBytes);
    if (header === undefined) return { note: "CORRUPT_SKIPPED" };
    // List views hide sessions without a conversation message yet (freshly
    // created, never sent). An explicit single-session lookup may legitimately
    // target exactly such a session — the renderer resolves provisional
    // (unsent) rows through it for resume, archive and delete.
    if (!header.hasConversationMessage && options.includeEmptySessions !== true && !(lookup && header.id === lookup.sessionId)) return {};
    if (lookup && header.id !== lookup.sessionId) return {};
    const workspaceId = header.cwd === undefined ? undefined : workspaceIds?.get(workspacePathKey(header.cwd));
    if (lookup && workspaceId === undefined) return {};
    if (allowedCwd !== undefined && (header.cwd === undefined || !sameWorkspaceCwd(header.cwd, allowedCwd))) {
      return {};
    }
    const origin = classifyOrigin(header.studioOrigin);
    if (origin !== "studio" && !includeCliSessions) return {};
    const title = sanitizeTitle(header.title);
    const createdAt = normalizeTimestamp(header.timestamp);
    // Archived members are cold; their tail is only reachable through a full
    // gzip pass, so they keep the mtime. Live files fall back to it as well
    // when the tail window holds no readable conversation entry.
    const lastActivityAt = archived ? undefined : await cachedTailActivity(file, metadata);
    return {
      entry: {
        sessionId: header.id,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        origin,
        archived,
        pinned: pinnedSessionIds.has(header.id),
        modifiedAt: lastActivityAt ?? metadata.mtime.toISOString(),
        sizeBytes: metadata.size,
        ...(title === undefined ? {} : { title }),
        ...(createdAt === undefined ? {} : { createdAt }),
      },
    };
  };

  const considered = await mapConcurrent(
    [...files.map((file) => ({ file, archived: false })), ...archivedFiles.map((file) => ({ file, archived: true }))],
    SCAN_CONCURRENCY,
    ({ file, archived }) => consider(file, archived),
  );
  for (const result of considered) {
    if (result.note !== undefined) note(result.note);
    const entry = result.entry;
    if (entry === undefined) continue;
    const key = entry.workspaceId ?? entry.sessionId;
    const existing = byId.get(key);
    if (existing !== undefined) {
      note("DUPLICATE_SESSION_ID");
      if (existing.modifiedAt >= entry.modifiedAt) continue;
    }
    byId.set(key, entry);
  }

  return {
    sessions: [...byId.values()].sort((left, right) =>
      right.modifiedAt.localeCompare(left.modifiedAt) || left.sessionId.localeCompare(right.sessionId),
    ),
    diagnostics: [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => ({ code, count })),
  };
}

interface ConsideredFile {
  entry?: SessionCatalogEntry;
  note?: SessionCatalogDiagnosticCode;
}

/** Sidebar projects each scan the same global tree; a bounded pool keeps one scan fast without flooding the FS. */
const SCAN_CONCURRENCY = 24;
const HEADER_CACHE_MAX = 8_192;
/** Trailing window scanned for the newest conversation-entry timestamp. */
const TAIL_SCAN_BYTES = 256 * 1024;
const TAIL_CACHE_MAX = HEADER_CACHE_MAX;

interface CachedHeader {
  readonly mtimeMs: number;
  readonly size: number;
  readonly header: ParsedHeader | undefined;
}

/**
 * Parsed headers survive across scans (one per sidebar project, plus refreshes)
 * and are reused while the file's mtime and size are unchanged. Workspace
 * filtering happens after this, so the cache is workspace-independent.
 */
const headerCache = new Map<string, CachedHeader>();

async function cachedSessionHeader(
  file: string,
  metadata: { readonly mtimeMs: number; readonly size: number },
  byteLimit: number,
  maxSessionBytes: number,
): Promise<ParsedHeader | undefined> {
  const key = `${byteLimit}:${maxSessionBytes}:${file}`;
  const hit = headerCache.get(key);
  // `SessionManager.updateSessionTitle` rewrites the fixed 256-byte title slot
  // in place without changing file size, and sub-millisecond writes on NTFS can
  // share `mtimeMs` with the preceding append. Re-read live untitled headers so
  // an in-place title write is never hidden behind a same-tick cache hit.
  const hitHasTitle = sanitizeTitle(hit?.header?.title) !== undefined;
  if (
    hit !== undefined &&
    hit.mtimeMs === metadata.mtimeMs &&
    hit.size === metadata.size &&
    (file.endsWith(".jsonl.gz") || hit.header === undefined || hitHasTitle)
  ) {
    return hit.header;
  }
  let header: ParsedHeader | undefined;
  try {
    header = await readSessionHeader(file, byteLimit, maxSessionBytes);
  } catch {
    // The file vanished or became unreadable between lstat and open.
    return undefined;
  }
  if (headerCache.size >= HEADER_CACHE_MAX) headerCache.clear();
  headerCache.set(key, { mtimeMs: metadata.mtimeMs, size: metadata.size, header });
  return header;
}

interface CachedTailActivity {
  readonly mtimeMs: number;
  readonly size: number;
  readonly lastActivityMs: number | undefined;
}

/**
 * Tail activity survives across scans with the same mtime/size invalidation as
 * the header cache, so the extra trailing read happens only for files that
 * changed since the previous scan.
 */
const tailActivityCache = new Map<string, CachedTailActivity>();

async function cachedTailActivity(
  file: string,
  metadata: { readonly mtimeMs: number; readonly size: number },
): Promise<string | undefined> {
  const hit = tailActivityCache.get(file);
  if (hit !== undefined && hit.mtimeMs === metadata.mtimeMs && hit.size === metadata.size) {
    return hit.lastActivityMs === undefined ? undefined : new Date(hit.lastActivityMs).toISOString();
  }
  let lastActivityMs: number | undefined;
  try {
    lastActivityMs = await readTailActivityTime(file, metadata.size);
  } catch {
    // The file vanished or became unreadable between lstat and open.
  }
  if (tailActivityCache.size >= TAIL_CACHE_MAX) tailActivityCache.clear();
  tailActivityCache.set(file, { mtimeMs: metadata.mtimeMs, size: metadata.size, lastActivityMs });
  return lastActivityMs === undefined ? undefined : new Date(lastActivityMs).toISOString();
}

/**
 * Newest timestamp among conversation entries (`message` and displayed
 * `custom_message`) in the file's trailing window. Runtime markers appended
 * when a session is opened or disposed (`session_exit`, …) never count, so
 * opening a session cannot move it to the top of the history list or reset
 * its displayed time. Unparseable lines (a line truncated by the window
 * start, a partially appended entry) are skipped.
 */
async function readTailActivityTime(file: string, size: number): Promise<number | undefined> {
  const handle = await open(file, "r");
  try {
    const length = Math.min(TAIL_SCAN_BYTES, size);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    if (bytesRead <= 0) return undefined;
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    let best: number | undefined;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]?.trim();
      if (line === undefined || line.length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(value)) continue;
      const conversation = value.type === "message" || (value.type === "custom_message" && value.display === true);
      if (!conversation) continue;
      const parsed = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      if (!Number.isFinite(parsed)) continue;
      if (best === undefined || parsed > best) best = parsed;
    }
    return best;
  } finally {
    await handle.close();
  }
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Read OMP's global session pin set. Missing, malformed, or unreadable pin
 * files are intentionally treated as an empty set so history discovery never
 * becomes unavailable because of optional metadata.
 */
async function loadPinnedSessionIds(agentDir: string): Promise<ReadonlySet<string>> {
  const pinPath = join(agentDir, SESSION_PINS_FILENAME);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const link = await lstat(pinPath);
    if (!link.isFile() || link.size > SESSION_PINS_MAX_BYTES) return new Set();

    // Read through one handle after checking its size, and reject growth while
    // reading. This keeps a racing/oversized file from reintroducing an
    // unbounded read through readFile().
    handle = await open(pinPath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > SESSION_PINS_MAX_BYTES) return new Set();
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) return new Set();
      offset += bytesRead;
    }
    const { bytesRead: extraBytes } = await handle.read(Buffer.alloc(1), 0, 1, metadata.size);
    if (extraBytes !== 0) return new Set();

    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length > SESSION_PINS_MAX_ENTRIES) return new Set();
    if (
      parsed.some(
        (value) =>
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > SESSION_PIN_ID_MAX_CHARS,
      )
    ) {
      return new Set();
    }
    return new Set(parsed);
  } catch {
    return new Set();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameWorkspaceCwd(left: string, right: string): boolean {
  return sameWorkspacePath(left, right);
}

function classifyOrigin(value: string | undefined): CatalogSessionOrigin {
  if (value === STUDIO_SESSION_ORIGIN) return "studio";
  if (value === undefined) return "cli";
  return "unknown";
}

async function listCandidateFiles(
  root: string,
  note: (code: SessionCatalogDiagnosticCode) => void,
): Promise<string[]> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    note("ROOT_UNAVAILABLE");
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      note("SYMLINK_SKIPPED");
      continue;
    }
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(candidate);
      continue;
    }
    if (!entry.isDirectory()) continue;
    let children: Dirent<string>[];
    try {
      children = await readdir(candidate, { withFileTypes: true });
    } catch {
      note("CORRUPT_SKIPPED");
      continue;
    }
    for (const child of children) {
      if (child.isSymbolicLink()) {
        note("SYMLINK_SKIPPED");
      } else if (child.isFile() && child.name.endsWith(".jsonl")) {
        files.push(join(candidate, child.name));
      }
    }
  }
  return files.sort();
}

async function listArchivedCandidateFiles(root: string): Promise<string[]> {
  // The cold-archive tree may simply not exist yet; that is not a diagnostic.
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl.gz")) {
      files.push(candidate);
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
      if (!child.isSymbolicLink() && child.isFile() && child.name.endsWith(".jsonl.gz")) {
        files.push(join(candidate, child.name));
      }
    }
  }
  return files.sort();
}

async function readSessionHeader(
  file: string,
  byteLimit: number,
  maxSessionBytes: number,
): Promise<ParsedHeader | undefined> {
  let text: string;
  if (file.endsWith(".jsonl.gz")) {
    try {
      const prefix = await readGunzipPrefix(file, byteLimit, maxSessionBytes);
      text = prefix.toString("utf8");
    } catch {
      return undefined;
    }
  } else {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(byteLimit);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }
  let titleSlot: string | undefined;
  let headerTitle: string | undefined;
  let latestTitleChange: string | undefined;
  let header: Omit<ParsedHeader, "hasConversationMessage" | "title"> | undefined;
  let hasConversationMessage = false;
  const buildParsedHeader = (): ParsedHeader | undefined => {
    if (header === undefined) return undefined;
    const resolvedTitle =
      sanitizeTitle(titleSlot) ??
      sanitizeTitle(latestTitleChange) ??
      sanitizeTitle(headerTitle);
    return {
      ...header,
      hasConversationMessage,
      ...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
    };
  };
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A large first message may extend beyond the bounded prefix. Its
      // discriminator is still complete at the start of OMP's JSONL record.
      if (
        /^\{\s*"type"\s*:\s*"message"\s*[,}]/u.test(line) ||
        (/^\{\s*"type"\s*:\s*"custom_message"\s*[,}]/u.test(line) && /"display"\s*:\s*true\b/u.test(line))
      ) {
        hasConversationMessage = true;
        if (header !== undefined && sanitizeTitle(titleSlot) !== undefined) return buildParsedHeader();
      }
      continue;
    }
    if (
      isRecord(value) &&
      (value.type === "message" || (value.type === "custom_message" && value.display === true))
    ) {
      hasConversationMessage = true;
      // Only short-circuit when the fixed-width title slot already carries the
      // current title; otherwise finish scanning the in-memory prefix for a
      // trailing `title` slot or `title_change` record.
      if (header !== undefined && sanitizeTitle(titleSlot) !== undefined) return buildParsedHeader();
      continue;
    }
    if (isRecord(value) && value.type === "title" && typeof value.title === "string") {
      titleSlot = value.title;
      if (header !== undefined && hasConversationMessage && sanitizeTitle(titleSlot) !== undefined) {
        return buildParsedHeader();
      }
      continue;
    }
    if (isRecord(value) && value.type === "title_change" && typeof value.title === "string") {
      latestTitleChange = value.title;
      continue;
    }
    if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" || value.id.length === 0) continue;
    headerTitle = typeof value.title === "string" ? value.title : undefined;
    header = {
      id: value.id,
      ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
      ...(typeof value.studioOrigin === "string" ? { studioOrigin: value.studioOrigin } : {}),
      ...(typeof value.cwd === "string" && value.cwd.length > 0 ? { cwd: value.cwd } : {}),
    };
    if (hasConversationMessage && sanitizeTitle(titleSlot) !== undefined) return buildParsedHeader();
  }
  return buildParsedHeader();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeTitle(value: string | undefined): string | undefined {
  const title = value?.split(/\r?\n/u)[0]?.replace(/[\x00-\x1f\x7f]/gu, "").trim();
  return title === undefined || title.length === 0 ? undefined : title.slice(0, 240);
}

function normalizeTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
