import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { open, readdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  CONVERSATION_LIMITS,
  CONVERSATION_REDACT_KEY_PATTERN,
  type ConversationContentBlock,
  type ConversationItem,
  type JsonValue,
  type OpaqueCursor,
  type SessionId,
} from "@omp-studio/studio-protocol";

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
  #snapshotInFlight = new Map<string, { version: FileVersion; promise: Promise<ArchiveSnapshot> }>();

  constructor(options: SessionArchiveReaderOptions) {
    if (options.allowedCwd.length === 0) throw new TypeError("allowedCwd is required");
    this.#sessionsRoot = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
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
      const boundaryIndex = items.findIndex((item) => item.itemId === cursor.boundary);
      if (boundaryIndex < 0) throw new SessionArchiveError("CURSOR_STALE", "Transcript cursor boundary is stale");
      endExclusive = boundaryIndex;
    }
    const start = Math.max(0, endExclusive - limit);
    const pageItems = items.slice(start, endExclusive);
    const cursorBase = {
      sessionId: snapshot.sessionId,
      transcriptRevision: snapshot.transcriptRevision,
      branchLeafId: snapshot.branchLeafId ?? "",
    };
    const headCursor = this.#encodeCursor({
      ...cursorBase,
      boundary: items.at(-1)?.itemId ?? "",
    });
    return {
      sessionId: snapshot.sessionId as SessionId,
      transcriptRevision: snapshot.transcriptRevision,
      branchLeafId: snapshot.branchLeafId,
      items: pageItems,
      ...(start > 0 && pageItems[0] !== undefined
        ? { olderCursor: this.#encodeCursor({ ...cursorBase, boundary: pageItems[0].itemId }) }
        : {}),
      headCursor,
      hasMoreBefore: start > 0,
    };
  }

  async #locate(sessionId: string): Promise<string> {
    const candidates = await listSessionFiles(this.#sessionsRoot, this.#maxScanFiles);
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
    const cached = this.#snapshotCache.get(path);
    const indexedVersion = this.#indexedVersions.get(path);
    if (cached !== undefined && indexedVersion === cached.version) return cached.snapshot;
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
        return snapshot;
      })
      .finally(() => {
        if (this.#snapshotInFlight.get(path)?.promise === read) this.#snapshotInFlight.delete(path);
      });
    this.#snapshotInFlight.set(path, { version: indexedVersion ?? "", promise: read });
    return read;
  }

  async #readSnapshotUncached(path: string, expectedSessionId: string): Promise<{ snapshot: ArchiveSnapshot; version: FileVersion }> {
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
      const complete = completeJsonlPrefix(buffer.subarray(0, offset));
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
        .update(String(before.dev))
        .update(":")
        .update(String(before.ino))
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
        version: fileVersion(after),
      };
    } finally {
      await handle.close();
    }
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

async function listSessionFiles(root: string, limit: number): Promise<string[]> {
  let roots;
  try {
    roots = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  const add = (path: string): void => {
    if (files.length >= limit) throw new SessionArchiveError("SESSION_CORRUPT", "Session catalog exceeds the scan limit");
    files.push(path);
  };
  for (const entry of roots) {
    if (entry.isSymbolicLink()) continue;
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
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
      if (child.isFile() && !child.isSymbolicLink() && child.name.endsWith(".jsonl")) add(join(candidate, child.name));
    }
  }
  return files.sort();
}

async function readHeader(path: string, byteLimit: number, maxSessionBytes: number): Promise<IndexedHeader | undefined> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    return undefined;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxSessionBytes) return undefined;
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(Math.min(byteLimit, metadata.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u).slice(0, 8)) {
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
  } finally {
    await handle.close();
  }
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

function projectBranch(entries: readonly ArchiveEntry[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  const toolOwners = new Map<string, number>();
  const toolResults: Array<{ readonly entry: ArchiveEntry; readonly result: Extract<ConversationContentBlock, { type: "toolResult" }> }> = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = isRecord(entry.message) ? entry.message : {};
      if (message.role === "toolResult") {
        toolResults.push({ entry, result: projectToolResult(message) });
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

  const orphanResults: Array<{ readonly entry: ArchiveEntry; readonly result: Extract<ConversationContentBlock, { type: "toolResult" }> }> = [];
  for (const { entry, result } of toolResults) {
    const ownerIndex = toolOwners.get(result.toolCallId);
    if (ownerIndex === undefined) {
      orphanResults.push({ entry, result });
      continue;
    }
    const owner = items[ownerIndex];
    if (owner === undefined || owner.kind !== "message") {
      orphanResults.push({ entry, result });
      continue;
    }
    const content = owner.content.some((block) => block.type === "toolResult" && block.toolCallId === result.toolCallId)
      ? owner.content
      : [...owner.content, result];
    items[ownerIndex] = { ...owner, content };
  }

  // A corrupt/truncated archive may contain a result without its call. Keep it
  // visible as a completed tool instead of producing an empty OMP row.
  for (const { entry, result } of orphanResults) {
    const toolCall: Extract<ConversationContentBlock, { type: "toolCall" }> = {
      type: "toolCall",
      toolCallId: result.toolCallId,
      toolName: result.toolName ?? "tool",
    };
    items.push({
      kind: "message",
      itemId: entry.id,
      parentId: entry.parentId,
      createdAt: typeof entry.timestamp === "string" ? entry.timestamp : new Date(0).toISOString(),
      role: "assistant",
      content: [toolCall, result],
    });
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
    const role = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system";
    return {
      kind: "message",
      itemId: entry.id,
      parentId: entry.parentId,
      createdAt,
      role,
      content: projectContent(message.content),
    };
  }
  if (entry.type === "compaction" && typeof entry.summary === "string") {
    return {
      kind: "compaction",
      itemId: entry.id,
      parentId: entry.parentId,
      createdAt,
      summary: truncateText(entry.summary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES).text || " ",
      ...(typeof entry.shortSummary === "string" ? { shortSummary: truncateText(entry.shortSummary, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES).text } : {}),
      ...(typeof entry.warning === "string" ? { warning: truncateText(entry.warning, CONVERSATION_LIMITS.COMPACTION_SUMMARY_MAX_BYTES).text } : {}),
    };
  }
  if (entry.type === "reset_boundary") {
    return { kind: "resetBoundary", itemId: entry.id, parentId: entry.parentId, createdAt };
  }
  return undefined;
}

function projectContent(value: unknown): ConversationContentBlock[] {
  if (typeof value === "string") {
    const text = truncateText(value, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
    return [{ type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) }];
  }
  if (!Array.isArray(value)) return [];
  const blocks: ConversationContentBlock[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (item.type === "text" && typeof item.text === "string") {
      const text = truncateText(item.text, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
      blocks.push({ type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      const text = truncateText(item.thinking, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
      blocks.push({ type: "thinking", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
    } else if (item.type === "toolCall" && typeof item.id === "string" && typeof item.name === "string") {
      const args = sanitizeJson(item.arguments, 0);
      blocks.push({
        type: "toolCall",
        toolCallId: item.id.slice(0, CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS) || "tool-call",
        toolName: item.name.slice(0, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS) || "tool",
        ...(args === undefined ? {} : { arguments: args }),
      });
    }
  }
  return blocks;
}

function projectToolResult(message: Record<string, unknown>): Extract<ConversationContentBlock, { type: "toolResult" }> {
  const outputs: string[] = [];
  if (typeof message.content === "string") outputs.push(message.content);
  if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (isRecord(item) && item.type === "text" && typeof item.text === "string") outputs.push(item.text);
    }
  }
  const output = truncateText(outputs.join("\n"), CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES);
  const details = projectToolDetails(message.details);
  return {
    type: "toolResult",
    toolCallId: typeof message.toolCallId === "string" ? message.toolCallId.slice(0, CONVERSATION_LIMITS.ITEM_ID_MAX_CHARS) : "tool-call",
    ...(typeof message.toolName === "string" ? { toolName: message.toolName.slice(0, CONVERSATION_LIMITS.TOOL_NAME_MAX_CHARS) } : {}),
    ...(output.text.length === 0 ? {} : { output: output.text }),
    ...(details.value === undefined ? {} : { data: details.value }),
    isError: message.isError === true,
    ...(output.truncated || details.truncated ? { truncated: true } : {}),
  };
}

function projectToolDetails(value: unknown): { readonly value?: JsonValue; readonly truncated: boolean } {
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
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1) ?? null);
  if (!isRecord(value)) return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (CONVERSATION_REDACT_KEY_PATTERN.test(key)) result[key] = "[REDACTED]";
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

function sameWorkspace(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
