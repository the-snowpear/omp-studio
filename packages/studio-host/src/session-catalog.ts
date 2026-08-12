import { open, readdir, lstat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const STUDIO_SESSION_ORIGIN = "studio-host";
const DEFAULT_PREFIX_BYTES = 64 * 1024;
const DEFAULT_MAX_SESSION_BYTES = 512 * 1024 * 1024;

export type CatalogSessionOrigin = "studio" | "cli" | "unknown";

export interface SessionCatalogEntry {
  sessionId: string;
  origin: CatalogSessionOrigin;
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
}

export function defaultOmpSessionsRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const agentDirectory = environment.OMP_AGENT_DIR;
  return resolve(agentDirectory === undefined || agentDirectory.length === 0 ? join(homedir(), ".omp", "agent") : agentDirectory, "sessions");
}

/**
 * Read-only OMP conversation discovery. It reads only a bounded prefix, never
 * returns filesystem paths, and does not modify/migrate OMP's session tree.
 */
export async function scanSessionCatalog(options: SessionCatalogOptions = {}): Promise<SessionCatalogResult> {
  const root = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
  const includeCliSessions = options.includeCliSessions ?? false;
  const maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  const prefixBytes = options.prefixBytes ?? DEFAULT_PREFIX_BYTES;
  if (!Number.isSafeInteger(maxSessionBytes) || maxSessionBytes <= 0) throw new TypeError("maxSessionBytes must be positive");
  if (!Number.isSafeInteger(prefixBytes) || prefixBytes <= 0) throw new TypeError("prefixBytes must be positive");

  const counts = new Map<SessionCatalogDiagnosticCode, number>();
  const note = (code: SessionCatalogDiagnosticCode): void => {
    counts.set(code, (counts.get(code) ?? 0) + 1);
  };
  const files = await listCandidateFiles(root, note);
  const byId = new Map<string, SessionCatalogEntry>();

  for (const file of files) {
    let metadata: Awaited<ReturnType<typeof lstat>>;
    try {
      metadata = await lstat(file);
    } catch {
      note("CORRUPT_SKIPPED");
      continue;
    }
    if (metadata.isSymbolicLink()) {
      note("SYMLINK_SKIPPED");
      continue;
    }
    if (!metadata.isFile()) continue;
    if (metadata.size > maxSessionBytes) {
      note("OVERSIZE_SKIPPED");
      continue;
    }
    const header = await readSessionHeader(file, Math.min(prefixBytes, metadata.size));
    if (header === undefined) {
      note("CORRUPT_SKIPPED");
      continue;
    }
    const origin = classifyOrigin(header.studioOrigin);
    if (origin !== "studio" && !includeCliSessions) continue;
    const title = sanitizeTitle(header.title);
    const createdAt = normalizeTimestamp(header.timestamp);
    const entry: SessionCatalogEntry = {
      sessionId: header.id,
      origin,
      modifiedAt: metadata.mtime.toISOString(),
      sizeBytes: metadata.size,
      ...(title === undefined ? {} : { title }),
      ...(createdAt === undefined ? {} : { createdAt }),
    };
    const existing = byId.get(entry.sessionId);
    if (existing !== undefined) {
      note("DUPLICATE_SESSION_ID");
      if (existing.modifiedAt >= entry.modifiedAt) continue;
    }
    byId.set(entry.sessionId, entry);
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

async function readSessionHeader(file: string, byteLimit: number): Promise<ParsedHeader | undefined> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
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
      };
    }
    return undefined;
  } finally {
    await handle.close();
  }
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
