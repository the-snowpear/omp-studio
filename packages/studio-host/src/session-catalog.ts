import { open, readdir, lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { readGunzipPrefix } from "./gzip-file.js";

const STUDIO_SESSION_ORIGIN = "studio-host";
const DEFAULT_PREFIX_BYTES = 64 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;

export type CatalogSessionOrigin = "studio" | "cli" | "unknown";

export interface SessionCatalogEntry {
  sessionId: string;
  origin: CatalogSessionOrigin;
  /** True when the entry comes from the OMP cold-archive tree (`.jsonl.gz`). */
  archived: boolean;
  title?: string;
  createdAt?: string;
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
  /** Cold-archive root scanned for `.jsonl.gz`; defaults to the omp gc layout. */
  archiveRoot?: string;
  /**
   * When set, only sessions whose header `cwd` resolves to this workspace are
   * returned. The comparison is internal — `cwd` is never copied onto entries.
   */
  allowedCwd?: string;
  /** Includes ordinary/unmarked OMP CLI sessions and unknown future origins. */
  includeCliSessions?: boolean;
  maxSessionBytes?: number;
  prefixBytes?: number;
}

interface ParsedHeader {
  id: string;
  timestamp?: string;
  title?: string;
  studioOrigin?: string;
  cwd?: string;
}

export function defaultOmpSessionsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const agentDirectory = environment.OMP_AGENT_DIR;
  return resolve(agentDirectory === undefined || agentDirectory.length === 0 ? join(homedir(), ".omp", "agent") : agentDirectory, "sessions");
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
  const archiveRoot = resolve(options.archiveRoot ?? defaultOmpArchiveRoot(root));
  const includeCliSessions = options.includeCliSessions ?? false;
  const allowedCwd = options.allowedCwd;
  const maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const prefixBytes = options.prefixBytes ?? DEFAULT_PREFIX_BYTES;
  if (!Number.isSafeInteger(maxSessionBytes) || maxSessionBytes <= 0) throw new TypeError("maxSessionBytes must be positive");
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0) throw new TypeError("prefixBytes must be positive");

  const counts = new Map<SessionCatalogDiagnosticCode, number>();
  const note = (code: SessionCatalogDiagnosticCode): void => {
    counts.set(code, (counts.get(code) ?? 0) + 1);
  };
  const files = await listCandidateFiles(root, note);
  const archivedFiles = await listArchivedCandidateFiles(archiveRoot);
  const byId = new Map<string, SessionCatalogEntry>();

  const consider = async (file: string, archived: boolean): Promise<void> => {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(file);
    } catch {
      note("CORRUPT_SKIPPED");
      return;
    }
    if (metadata.isSymbolicLink()) {
      note("SYMLINK_SKIPPED");
      return;
    }
    if (!metadata.isFile()) return;
    if (metadata.size > maxSessionBytes) {
      note("OVERSIZE_SKIPPED");
      return;
    }
    const header = await readSessionHeader(file, archived ? prefixBytes : Math.min(prefixBytes, metadata.size), maxSessionBytes);
    if (header === undefined) {
      note("CORRUPT_SKIPPED");
      return;
    }
    if (allowedCwd !== undefined && (header.cwd === undefined || !sameWorkspaceCwd(header.cwd, allowedCwd))) {
      return;
    }
    const origin = classifyOrigin(header.studioOrigin);
    if (origin !== "studio" && !includeCliSessions) return;
    const title = sanitizeTitle(header.title);
    const createdAt = normalizeTimestamp(header.timestamp);
    const entry: SessionCatalogEntry = {
      sessionId: header.id,
      origin,
      archived,
      modifiedAt: metadata.mtime.toISOString(),
      sizeBytes: metadata.size,
      ...(title === undefined ? {} : { title }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
    const existing = byId.get(entry.sessionId);
    if (existing !== undefined) {
      note("DUPLICATE_SESSION_ID");
      if (existing.modifiedAt >= entry.modifiedAt) return;
    }
    byId.set(entry.sessionId, entry);
  };

  for (const file of files) {
    await consider(file, false);
  }
  for (const file of archivedFiles) {
    await consider(file, true);
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

function sameWorkspaceCwd(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
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
  for (const rawLine of text.split(/\r?\n/u).slice(0, 8)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value) && value.type === "title" && typeof value.title === "string") {
      titleSlot = value.title;
      continue;
    }
    if (!isRecord(value) || value.type !== "session" || typeof value.id !== "string" || value.id.length === 0) continue;
    return {
      id: value.id,
      ...(typeof value.timestamp === "string" ? { timestamp: value.timestamp } : {}),
      ...(typeof value.title === "string" ? { title: value.title } : titleSlot === undefined ? {} : { title: titleSlot }),
      ...(typeof value.studioOrigin === "string" ? { studioOrigin: value.studioOrigin } : {}),
      ...(typeof value.cwd === "string" && value.cwd.length > 0 ? { cwd: value.cwd } : {}),
    };
  }
  return undefined;
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
