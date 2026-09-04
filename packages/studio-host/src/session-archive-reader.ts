import { createHash, createHmac, randomBytes, timingSafeEqual, type Hash } from "node:crypto";
import { open, readdir, lstat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  CONVERSATION_LIMITS,
  conversationRedactKey,
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
/** Raw transcript bytes represented by cached parsed snapshots. Parsed objects
 * are larger than this number, so keep the raw-byte budget deliberately small. */
const DEFAULT_SNAPSHOT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const AGENT_TOMBSTONE_SUFFIX = ".tombstone";
const MAX_AGENT_ID_LENGTH = 512;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;
const MAX_CHILD_WALK_FILES = 2_000;
/** 解析 / 投影时的让出节奏：每 8ms 让一次，主进程不被整档解析堵住。 */
const PARSE_YIELD_MS = 8;
/** 只在每 256 条记录检查一次时钟，`Date.now()` 本身不该成为热点。 */
const PARSE_YIELD_MASK = 0xff;
/** 追加续读时比对的前缀尾部字节数。 */
const TAIL_SAMPLE_BYTES = 256;
const EMPTY_BUFFER = Buffer.alloc(0);

export interface SessionArchiveReadInput {
  readonly sessionId: string;
  /** When set, read that persisted child transcript next to the parent session file. */
  readonly agentId?: string;
  readonly cursor?: OpaqueCursor;
  readonly limit?: number;
}

/** Disk-backed child agent row. Paths never leave the Host. */
export interface SessionPersistedAgentRecord {
  readonly agentId: string;
  readonly displayName: string;
  readonly status: "parked" | "aborted";
  readonly parentAgentId?: string;
  readonly assignment?: string;
  readonly startedAt?: string;
  readonly updatedAt: string;
  readonly hasTranscript: boolean;
  readonly usage?: {
    readonly tokens: number;
    readonly requests: number;
    readonly tools: number;
    readonly cost: number;
    readonly durationMs: number;
    readonly durationKind: "span";
  };
  readonly modelRole?: string;
  readonly resolvedModel?: string;
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
  | "AGENT_NOT_FOUND"
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
  readonly snapshotCacheMaxBytes?: number;
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
  /**
   * id → entry。分支解析每次都要按 id 找父节点，重建这张表就是一次 O(全部记录) 的
   * 扫描；跟着快照一起活着，追加续读只需要补上新记录。
   */
  byId: Map<string, ArchiveEntry>;
};

type FileVersion = string;

type IndexedHeader = {
  readonly id: string;
  readonly version: FileVersion;
  readonly cwd?: string;
};

/**
 * 已经解析进快照的完整前缀。会话日志是追加式 JSONL：下一次读取只需要读走新增的字节，
 * 把新行折进同一个 entries 数组，再用同一个内容哈希算出新的 revision。
 */
type ConsumedPrefix = {
  /** 已消费的完整字节数（总是落在换行边界上）。 */
  readonly bytes: number;
  /** namespace + sessionId + 已消费字节的滚动哈希；`copy()` 后补上身份/长度才是 revision。 */
  readonly hash: Hash;
  /** 已消费前缀的末尾若干字节：续读时比对一次，确认文件是被追加而不是被重写。 */
  readonly tail: Buffer;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
};

type CachedSnapshot = {
  readonly version: FileVersion;
  readonly snapshot: ArchiveSnapshot;
  readonly weight: number;
  /** 仅明文 `.jsonl` 有：压缩档没有可续读的字节边界。 */
  readonly consumed?: ConsumedPrefix;
};

/** 投影的可续算状态：`projectBranch` 是一次前向折叠，state 就是它的中间结果。 */
type ProjectionState = {
  readonly items: ConversationItem[];
  readonly toolOwners: Map<string, number>;
};

type CachedProjection = {
  readonly leafId: string | null;
  /** 折叠过的分支（按引用），用来判断新分支是否只是它的追加。 */
  readonly branch: readonly ArchiveEntry[];
  readonly state: ProjectionState;
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
  readonly #snapshotCacheMaxBytes: number;
  readonly #cursorSecret: Buffer;
  /** Directory enumeration is cheap; header reads are not. Keep the index while paths are stable. */
  #indexedPaths: readonly string[] | undefined;
  #sessionIndex = new Map<string, string[]>();
  #indexedVersions = new Map<string, FileVersion>();
  #indexBuildInFlight: Promise<void> | undefined;
  /** Parsed snapshots are shared by paging and repeated session switches. */
  #snapshotCache = new Map<string, CachedSnapshot>();
  #snapshotCacheBytes = 0;
  #snapshotInFlight = new Map<string, { version: FileVersion | undefined; promise: Promise<{ snapshot: ArchiveSnapshot; version: FileVersion }> }>();
  /**
   * 投影（entries → ConversationItem）结果。一次切换里 `readPage` / `readRevision` /
   * `listPersistedAgents` 会读同一份快照，翻页还会再读一次：投影是这条路径上最贵的一步
   * （每个字符串都要 sanitize、每个工具参数都要 JSON 序列化），不能每次重算。
   */
  #projectionCache = new Map<string, CachedProjection>();

  constructor(options: SessionArchiveReaderOptions) {
    if (options.allowedCwd.length === 0) throw new TypeError("allowedCwd is required");
    this.#sessionsRoot = resolve(options.sessionsRoot ?? defaultOmpSessionsRoot());
    this.#archiveRoot = resolve(options.archiveRoot ?? defaultOmpArchiveRoot(this.#sessionsRoot));
    this.#allowedCwd = resolve(options.allowedCwd);
    this.#maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
    this.#maxScanFiles = options.maxScanFiles ?? DEFAULT_MAX_SCAN_FILES;
    this.#snapshotCacheMaxBytes = options.snapshotCacheMaxBytes ?? DEFAULT_SNAPSHOT_CACHE_MAX_BYTES;
    this.#cursorSecret = options.cursorSecret ?? randomBytes(32);
    if (!Number.isSafeInteger(this.#maxSessionBytes) || this.#maxSessionBytes <= 0) {
      throw new TypeError("maxSessionBytes must be positive");
    }
    if (!Number.isSafeInteger(this.#maxScanFiles) || this.#maxScanFiles <= 0) {
      throw new TypeError("maxScanFiles must be positive");
    }
    if (!Number.isSafeInteger(this.#snapshotCacheMaxBytes) || this.#snapshotCacheMaxBytes <= 0) {
      throw new TypeError("snapshotCacheMaxBytes must be positive");
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
    if (input.agentId !== undefined) this.#assertAgentId(input.agentId);
    const parentFile = await this.#locate(input.sessionId);
    await this.#assertParentWorkspace(parentFile, input.sessionId);
    const located =
      input.agentId === undefined
        ? { path: parentFile, sessionId: input.sessionId }
        : await this.#locatePersistedAgent(parentFile, input.agentId);
    const snapshot = await this.#readSnapshot(located.path, located.sessionId, {
      requireCwd: input.agentId === undefined,
    });
    const items = await this.#projectedItems(located.path, snapshot);
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
    // The transport rejects pages above PAGE_MAX_BYTES. Compact oversized
    // payloads across the selected window before dropping a leading item: an
    // assistant/tool shell is more useful than a page that starts midway
    // through the tool chain. Mirrors the online transcript service.
    let page = pageOf();
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > CONVERSATION_LIMITS.PAGE_MAX_BYTES) {
      for (const maxPayloadBytes of PAGE_PAYLOAD_BYTE_STEPS) {
        pageItems = pageItems.map((item) => shrinkItem(item, maxPayloadBytes));
        page = pageOf();
        if (Buffer.byteLength(JSON.stringify(page), "utf8") <= CONVERSATION_LIMITS.PAGE_MAX_BYTES) break;
      }
    }
    while (Buffer.byteLength(JSON.stringify(page), "utf8") > CONVERSATION_LIMITS.PAGE_MAX_BYTES && pageItems.length > 1) {
      pageItems = pageItems.slice(1);
      hasMoreBefore = true;
      page = pageOf();
    }
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > CONVERSATION_LIMITS.PAGE_MAX_BYTES && pageItems.length === 1) {
      pageItems = [shrinkItem(pageItems[0]!, PAGE_PAYLOAD_BYTE_STEPS.at(-1)!)];
      page = pageOf();
    }
    return page;
  }

  /**
   * Parked/aborted child agents stored next to a parent session file.
   * Mirrors the TUI `registerPersistedSubagents` scan; never returns paths.
   */
  async listPersistedAgents(sessionId: string): Promise<readonly SessionPersistedAgentRecord[]> {
    if (sessionId.length === 0) throw new SessionArchiveError("SESSION_NOT_FOUND", "Session id is required");
    const parentFile = await this.#locate(sessionId);
    await this.#assertParentWorkspace(parentFile, sessionId);
    const children = await this.#collectPersistedAgentFiles(parentStem(parentFile), "Main", 0);
    const records: SessionPersistedAgentRecord[] = [];
    for (const child of children) {
      try {
        records.push(await this.#persistedAgentRecord(child));
      } catch {
        // A single unreadable child must not hide the rest of the roster.
      }
    }
    records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId));
    return records;
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

  #assertAgentId(agentId: string): void {
    if (agentId.length === 0 || agentId.length > MAX_AGENT_ID_LENGTH || /^main$/iu.test(agentId) || !AGENT_ID_PATTERN.test(agentId)) {
      throw new SessionArchiveError("CURSOR_INVALID", "Agent id is invalid");
    }
  }

  async #assertParentWorkspace(parentFile: string, sessionId: string): Promise<void> {
    const header = await readHeader(parentFile, Math.min(this.#maxSessionBytes, 64 * 1024), this.#maxSessionBytes);
    if (header === undefined || header.id !== sessionId) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session header is missing or invalid");
    }
    if (typeof header.cwd !== "string") {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session header is missing or invalid");
    }
    if (!sameWorkspace(header.cwd, this.#allowedCwd)) {
      throw new SessionArchiveError("WORKSPACE_MISMATCH", "Session does not belong to the selected workspace");
    }
  }

  async #locatePersistedAgent(
    parentFile: string,
    agentId: string,
  ): Promise<{ path: string; sessionId: string }> {
    const found = await this.#findPersistedAgentFile(parentStem(parentFile), agentId, 0);
    if (found === undefined) {
      throw new SessionArchiveError("AGENT_NOT_FOUND", `Agent "${agentId}" was not found`);
    }
    return found;
  }

  async #findPersistedAgentFile(
    dir: string,
    agentId: string,
    walked: number,
  ): Promise<{ path: string; sessionId: string } | undefined> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const plain = `${agentId}.jsonl`;
    const compressed = `${agentId}.jsonl.gz`;
    for (const entry of entries) {
      if (walked >= MAX_CHILD_WALK_FILES) break;
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      if (entry.name !== plain && entry.name !== compressed) continue;
      const path = join(dir, entry.name);
      const header = await readHeader(path, Math.min(this.#maxSessionBytes, 64 * 1024), this.#maxSessionBytes);
      if (header === undefined) continue;
      return { path, sessionId: header.id };
    }
    for (const entry of entries) {
      if (walked >= MAX_CHILD_WALK_FILES) break;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (entry.name.endsWith(".bak") || entry.name.startsWith(".")) continue;
      walked += 1;
      const nested = await this.#findPersistedAgentFile(join(dir, entry.name), agentId, walked);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  async #collectPersistedAgentFiles(
    dir: string,
    parentAgentId: string,
    walked: number,
  ): Promise<Array<{ path: string; agentId: string; parentAgentId: string }>> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const found: Array<{ path: string; agentId: string; parentAgentId: string }> = [];
    for (const entry of entries) {
      if (walked >= MAX_CHILD_WALK_FILES) break;
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && isPersistedAgentTranscriptName(entry.name)) {
        walked += 1;
        found.push({
          path: join(dir, entry.name),
          agentId: agentIdFromTranscriptName(entry.name),
          parentAgentId,
        });
        continue;
      }
      if (!entry.isDirectory() || entry.name.endsWith(".bak") || entry.name.startsWith(".")) continue;
      walked += 1;
      const childId = AGENT_ID_PATTERN.test(entry.name) ? entry.name : parentAgentId;
      found.push(...(await this.#collectPersistedAgentFiles(join(dir, entry.name), childId, walked)));
    }
    return found;
  }

  async #persistedAgentRecord(child: {
    path: string;
    agentId: string;
    parentAgentId: string;
  }): Promise<SessionPersistedAgentRecord> {
    const snapshot = await this.#readSnapshot(child.path, (await this.#headerId(child.path)) ?? child.agentId, {
      requireCwd: false,
    });
    const tombstoned = await fileExists(`${child.path}${AGENT_TOMBSTONE_SUFFIX}`);
    const usage = usageFromEntries(snapshot.entries);
    const assignment = assignmentFromEntries(snapshot.entries);
    const startedAt = timestampFromEntries(snapshot.entries, "first");
    const updatedAt = timestampFromEntries(snapshot.entries, "last") ?? new Date(0).toISOString();
    const model = modelFromEntries(snapshot.entries);
    return {
      agentId: child.agentId,
      displayName: child.agentId,
      status: tombstoned ? "aborted" : "parked",
      ...(child.parentAgentId.length > 0 ? { parentAgentId: child.parentAgentId } : {}),
      ...(assignment === undefined ? {} : { assignment }),
      ...(startedAt === undefined ? {} : { startedAt }),
      updatedAt,
      hasTranscript: snapshot.entries.some((entry) => entry.type === "message" || entry.type === "custom_message"),
      ...(usage === undefined ? {} : { usage }),
      ...(model.modelRole === undefined ? {} : { modelRole: model.modelRole }),
      ...(model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel }),
    };
  }

  async #headerId(path: string): Promise<string | undefined> {
    const header = await readHeader(path, Math.min(this.#maxSessionBytes, 64 * 1024), this.#maxSessionBytes);
    return header?.id;
  }

  async #locate(sessionId: string): Promise<string> {
    // Hot reads should use the already-built identity index. Directory walking is
    // reserved for a cache miss (new session) or an in-place replacement.
    let matches = this.#sessionIndex.get(sessionId) ?? [];
    let candidates: string[] | undefined;
    if (matches.length === 0 || this.#indexedPaths === undefined) {
      candidates = await listSessionFiles({ sessions: this.#sessionsRoot, archive: this.#archiveRoot }, this.#maxScanFiles);
      await this.#ensureIndex(candidates);
      matches = this.#sessionIndex.get(sessionId) ?? [];
    }
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
      candidates ??= await listSessionFiles({ sessions: this.#sessionsRoot, archive: this.#archiveRoot }, this.#maxScanFiles);
      await this.#ensureIndex(candidates, true);
      matches = this.#sessionIndex.get(sessionId) ?? [];
    }
    if (matches.length === 0) throw new SessionArchiveError("SESSION_NOT_FOUND", "Session is not available");
    if (matches.length > 1) {
      throw new SessionArchiveError("SESSION_DUPLICATE", "Session identity is duplicated; refusing an ambiguous read");
    }
    return matches[0]!;
  }

  async #readSnapshot(
    path: string,
    expectedSessionId: string,
    options: { requireCwd?: boolean } = {},
  ): Promise<ArchiveSnapshot> {
    const { snapshot } = await this.#readSnapshotVersioned(path, expectedSessionId, options);
    return snapshot;
  }

  async #readSnapshotVersioned(
    path: string,
    expectedSessionId: string,
    options: { requireCwd?: boolean } = {},
  ): Promise<{ snapshot: ArchiveSnapshot; version: FileVersion }> {
    const cached = this.#snapshotCache.get(path);
    const indexedVersion = this.#indexedVersions.get(path);
    if (cached !== undefined && indexedVersion === cached.version) {
      // 命中也要刷新 LRU 顺序：否则热会话会被读过一遍的冷会话挤出缓存。
      this.#snapshotCache.delete(path);
      this.#snapshotCache.set(path, cached);
      return { snapshot: cached.snapshot, version: cached.version };
    }
    const pending = this.#snapshotInFlight.get(path);
    if (pending !== undefined && pending.version === indexedVersion) return pending.promise;
    /* 文件变过：优先按追加续读（只解析新增字节），失败再整档重读。 */
    const load = cached?.consumed === undefined
      ? this.#readSnapshotUncached(path, expectedSessionId, options)
      : this.#appendSnapshot(path, expectedSessionId, cached).then(
          (appended) => appended ?? this.#readSnapshotUncached(path, expectedSessionId, options),
        );
    const read = load
      .then(({ snapshot, version, consumed, weight }) => {
        this.#dropCachedSnapshot(path);
        if (weight <= this.#snapshotCacheMaxBytes) {
          this.#snapshotCache.set(path, { snapshot, version, weight, ...(consumed === undefined ? {} : { consumed }) });
          this.#snapshotCacheBytes += weight;
        }
        while (
          this.#snapshotCache.size > DEFAULT_SNAPSHOT_CACHE_SIZE
          || this.#snapshotCacheBytes > this.#snapshotCacheMaxBytes
        ) {
          const oldest = this.#snapshotCache.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.#dropCachedSnapshot(oldest);
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

  #dropCachedSnapshot(path: string): void {
    const cached = this.#snapshotCache.get(path);
    if (cached !== undefined) this.#snapshotCacheBytes = Math.max(0, this.#snapshotCacheBytes - cached.weight);
    this.#snapshotCache.delete(path);
    this.#projectionCache.delete(path);
  }

  /**
   * 追加式续读：只读走 `consumed.bytes` 之后的字节。文件被换掉、被截断或前缀改写时返回
   * undefined，由调用方回落到整档读取。
   */
  async #appendSnapshot(
    path: string,
    expectedSessionId: string,
    cached: CachedSnapshot,
  ): Promise<{ snapshot: ArchiveSnapshot; version: FileVersion; consumed: ConsumedPrefix; weight: number } | undefined> {
    const consumed = cached.consumed;
    if (consumed === undefined || isCompressedSessionPath(path)) return undefined;
    if (cached.snapshot.sessionId !== expectedSessionId) return undefined;
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) return undefined;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return undefined;
      if (before.dev !== BigInt(consumed.dev) || before.ino !== BigInt(consumed.ino)) return undefined;
      if (before.size > BigInt(this.#maxSessionBytes)) {
        throw new SessionArchiveError("SESSION_TOO_LARGE", "Session exceeds the configured read limit");
      }
      const size = Number(before.size);
      if (size < consumed.bytes) return undefined;
      const overlap = Math.min(consumed.tail.length, consumed.bytes);
      const start = consumed.bytes - overlap;
      const buffer = Buffer.alloc(size - start);
      let offset = 0;
      while (offset < buffer.length) {
        const chunk = await handle.read(buffer, offset, buffer.length - offset, start + offset);
        if (chunk.bytesRead === 0) break;
        offset += chunk.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size < before.size) return undefined;
      const seen = buffer.subarray(0, Math.min(overlap, offset));
      if (!seen.equals(consumed.tail.subarray(consumed.tail.length - seen.length))) return undefined;
      const appended = completeJsonlPrefix(buffer.subarray(overlap, offset));
      const entries = cached.snapshot.entries;
      const byId = cached.snapshot.byId;
      if (appended.byteLength > 0) {
        const values = await parseCompleteJsonlYielding(appended.bytes);
        for (const value of values) {
          const entry = parseEntry(value);
          if (entry === undefined) continue;
          entries.push(entry);
          byId.set(entry.id, entry);
        }
      }
      const hash = consumed.hash;
      if (appended.byteLength > 0) await updateHashYielding(hash, appended.bytes);
      const nextConsumed: ConsumedPrefix = {
        bytes: consumed.bytes + appended.byteLength,
        hash,
        tail: tailSample(consumed.tail, appended.bytes),
        dev: consumed.dev,
        ino: consumed.ino,
      };
      return {
        snapshot: {
          sessionId: cached.snapshot.sessionId,
          transcriptRevision: revisionOf(hash, consumed.dev, consumed.ino, nextConsumed.bytes),
          branchLeafId: resolveBranchLeaf(entries),
          entries,
          byId,
        },
        version: fileVersion(after),
        consumed: nextConsumed,
        weight: nextConsumed.bytes,
      };
    } finally {
      await handle.close();
    }
  }

  /**
   * 分支投影，带可续算缓存。新分支只是旧分支的追加时接着折叠，其余情况整条重折。
   */
  async #projectedItems(path: string, snapshot: ArchiveSnapshot): Promise<readonly ConversationItem[]> {
    const branch = activeBranch(snapshot.byId, snapshot.branchLeafId);
    const cached = this.#projectionCache.get(path);
    const reusable =
      cached !== undefined && cached.leafId === snapshot.branchLeafId && isBranchPrefix(cached.branch, branch);
    const state = reusable ? cached.state : createProjectionState();
    const from = reusable ? cached.branch.length : 0;
    if (!reusable || from < branch.length) await foldBranch(state, branch, from);
    this.#projectionCache.delete(path);
    // A projection retains the parsed branch. Do not let it smuggle an
    // oversized, deliberately uncached snapshot back into long-lived memory.
    if (this.#snapshotCache.get(path)?.snapshot === snapshot) {
      this.#projectionCache.set(path, { leafId: snapshot.branchLeafId, branch, state });
    }
    while (this.#projectionCache.size > DEFAULT_SNAPSHOT_CACHE_SIZE) {
      const oldest = this.#projectionCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#projectionCache.delete(oldest);
    }
    return state.items;
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

  async #readSnapshotUncached(
    path: string,
    expectedSessionId: string,
    options: { requireCwd?: boolean } = {},
  ): Promise<{ snapshot: ArchiveSnapshot; version: FileVersion; consumed?: ConsumedPrefix; weight: number }> {
    const { bytes, identity, version } = await this.#readWholeFile(path);
    const complete = completeJsonlPrefix(bytes);
    const values = await parseCompleteJsonlYielding(complete.bytes);
    const header = values.find((value) => isRecord(value) && value.type === "session");
    const requireCwd = options.requireCwd !== false;
    if (!isRecord(header) || typeof header.id !== "string" || (requireCwd && typeof header.cwd !== "string")) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session header is missing or invalid");
    }
    if (header.id !== expectedSessionId) {
      throw new SessionArchiveError("SESSION_CORRUPT", "Session identity changed while it was being read");
    }
    if (typeof header.cwd === "string" && !sameWorkspace(header.cwd, this.#allowedCwd)) {
      throw new SessionArchiveError("WORKSPACE_MISMATCH", "Session does not belong to the selected workspace");
    }
    const entries: ArchiveEntry[] = [];
    const byId = new Map<string, ArchiveEntry>();
    for (const value of values) {
      const entry = parseEntry(value);
      if (entry === undefined) continue;
      entries.push(entry);
      byId.set(entry.id, entry);
    }
    /* 滚动哈希：内容先入，身份与长度在算 revision 时补上，追加续读才能接着更新。 */
    const hash = createHash("sha256")
      .update(CURSOR_NAMESPACE)
      .update("\0")
      .update(header.id)
      .update("\0");
    await updateHashYielding(hash, complete.bytes);
    return {
      snapshot: {
        sessionId: header.id,
        transcriptRevision: revisionOf(hash, identity.dev, identity.ino, complete.byteLength),
        branchLeafId: resolveBranchLeaf(entries),
        entries,
        byId,
      },
      version,
      weight: complete.byteLength,
      /* 压缩档没有可续读的字节边界：不给 consumed，下次仍然整档解压。 */
      ...(isCompressedSessionPath(path)
        ? {}
        : {
            consumed: {
              bytes: complete.byteLength,
              hash,
              tail: tailSample(EMPTY_BUFFER, complete.bytes),
              dev: identity.dev,
              ino: identity.ino,
            },
          }),
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

function parentStem(sessionFile: string): string {
  if (sessionFile.endsWith(".jsonl.gz")) return sessionFile.slice(0, -".jsonl.gz".length);
  if (sessionFile.endsWith(".jsonl")) return sessionFile.slice(0, -".jsonl".length);
  return sessionFile;
}

function isPersistedAgentTranscriptName(name: string): boolean {
  if (name.includes(".bak") || name.startsWith("__advisor")) return false;
  return (name.endsWith(".jsonl") && !name.endsWith(".jsonl.gz")) || name.endsWith(".jsonl.gz");
}

function agentIdFromTranscriptName(name: string): string {
  return name.endsWith(".jsonl.gz") ? name.slice(0, -".jsonl.gz".length) : name.slice(0, -".jsonl".length);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

function timestampFromEntries(entries: readonly ArchiveEntry[], which: "first" | "last"): string | undefined {
  for (const entry of which === "first" ? entries : [...entries].reverse()) {
    if (typeof entry.timestamp === "string" && Number.isFinite(Date.parse(entry.timestamp))) return entry.timestamp;
  }
  return undefined;
}

function assignmentFromEntries(entries: readonly ArchiveEntry[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "session_init") continue;
    const task = typeof entry.task === "string" ? entry.task.replace(/\s+/gu, " ").trim() : "";
    if (task.length > 0) return task.slice(0, 1_000);
  }
  return undefined;
}

function modelFromEntries(entries: readonly ArchiveEntry[]): { modelRole?: string; resolvedModel?: string } {
  let modelRole: string | undefined;
  let resolvedModel: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_init") {
      if (typeof entry.modelRole === "string") modelRole = entry.modelRole;
      if (typeof entry.resolvedModel === "string") resolvedModel = entry.resolvedModel;
    }
    if (entry.type === "model_change" && typeof entry.model === "string") resolvedModel = entry.model;
  }
  return {
    ...(modelRole === undefined ? {} : { modelRole }),
    ...(resolvedModel === undefined ? {} : { resolvedModel }),
  };
}

function usageFromEntries(entries: readonly ArchiveEntry[]): SessionPersistedAgentRecord["usage"] | undefined {
  const first = timestampFromEntries(entries, "first");
  const last = timestampFromEntries(entries, "last");
  let tokens = 0;
  let requests = 0;
  let tools = 0;
  let cost = 0;
  for (const entry of entries) {
    if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") continue;
    const usage = isRecord(entry.message.usage) ? entry.message.usage : {};
    const usageCost = isRecord(usage.cost) ? usage.cost : {};
    const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
    const output = typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
    const cacheWrite = typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
    const totalTokens = typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0;
    tokens += input + output + cacheWrite > 0 ? input + output + cacheWrite : totalTokens;
    cost += typeof usageCost.total === "number" && Number.isFinite(usageCost.total) ? usageCost.total : 0;
    requests += 1;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    tools += content.filter((part) => isRecord(part) && part.type === "toolCall").length;
  }
  if (requests === 0) return undefined;
  return {
    tokens,
    requests,
    tools,
    cost,
    durationMs: Math.max(0, (last === undefined || first === undefined ? 0 : Date.parse(last) - Date.parse(first))),
    durationKind: "span",
  };
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
        return {
          id: value.id,
          version: fileVersion(metadata),
          ...(typeof value.cwd === "string" && value.cwd.length > 0 ? { cwd: value.cwd } : {}),
        };
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

/**
 * 完整前缀：最后一个换行为止的字节。不再一次性 `toString`——十几 MB 的整档解码本身就是
 * 几十毫秒的同步停顿，解析时按行解码更划算。
 */
function completeJsonlPrefix(bytes: Buffer): { bytes: Buffer; byteLength: number } {
  if (bytes.length === 0) return { bytes, byteLength: 0 };
  const newline = bytes.lastIndexOf(0x0a);
  if (newline < 0) return { bytes: EMPTY_BUFFER, byteLength: 0 };
  const complete = bytes.subarray(0, newline + 1);
  return { bytes: complete, byteLength: complete.length };
}

/**
 * 逐行 JSON 解析，按时间片让出事件循环。
 *
 * 这一步在 Electron 主进程上跑：一个十几 MB 的会话整档解析要几百毫秒，同步做会把 Bridge
 * 事件、command 回执和别的 IPC 一起堵住。每 8ms 让一次，总 CPU 不变，但主进程不再假死。
 */
async function parseCompleteJsonlYielding(bytes: Buffer): Promise<unknown[]> {
  const values: unknown[] = [];
  let checkpoint = Date.now();
  let start = 0;
  let line = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline < 0 ? bytes.length : newline;
    line += 1;
    const raw = bytes.toString("utf8", start, end).trim();
    start = end + 1;
    if (raw.length > 0) {
      try {
        values.push(JSON.parse(raw));
      } catch (error) {
        throw new SessionArchiveError("SESSION_CORRUPT", `Session contains malformed JSON at complete line ${line}: ${(error as Error).message}`);
      }
    }
    if ((line & PARSE_YIELD_MASK) === 0 && Date.now() - checkpoint >= PARSE_YIELD_MS) {
      await yieldToEventLoop();
      checkpoint = Date.now();
    }
  }
  return values;
}

/** 分片喂哈希：sha256 十几 MB 是一次几十毫秒的同步调用，切开让出。 */
async function updateHashYielding(hash: Hash, bytes: Buffer): Promise<void> {
  const chunk = 1 << 20;
  let checkpoint = Date.now();
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    hash.update(bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
    if (Date.now() - checkpoint >= PARSE_YIELD_MS) {
      await yieldToEventLoop();
      checkpoint = Date.now();
    }
  }
}


function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** 已消费前缀的末尾采样：续读时用它确认文件是被追加，而不是被改写。 */
function tailSample(previous: Buffer, appended: Buffer): Buffer {
  if (appended.length >= TAIL_SAMPLE_BYTES) {
    return Buffer.from(appended.subarray(appended.length - TAIL_SAMPLE_BYTES));
  }
  const combined = Buffer.concat([previous, appended]);
  return combined.length <= TAIL_SAMPLE_BYTES
    ? combined
    : Buffer.from(combined.subarray(combined.length - TAIL_SAMPLE_BYTES));
}

/**
 * `transcriptRevision`：内容滚动哈希 + 文件身份 + 已消费长度。
 * 哈希对象只 `copy()` 后再补尾料，原对象继续给下一次追加用。
 */
function revisionOf(content: Hash, dev: number | bigint, ino: number | bigint, byteLength: number): string {
  const digest = content
    .copy()
    .update("\0")
    .update(`${String(dev)}:${String(ino)}:${String(byteLength)}`)
    .digest("base64url");
  return `sha256:${digest}`;
}

function parseEntry(value: unknown): ArchiveEntry | undefined {
  if (!isRecord(value) || value.type === "session" || typeof value.id !== "string" || value.id.length === 0) return undefined;
  if (value.parentId !== null && typeof value.parentId !== "string") return undefined;
  if (typeof value.type !== "string") return undefined;
  return value as ArchiveEntry;
}

function activeBranch(byId: ReadonlyMap<string, ArchiveEntry>, leafId: string | null): ArchiveEntry[] {
  if (leafId === null) return [];
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

/** 新分支是否只是旧分支的追加（逐个引用比对，指针级开销）。 */
function isBranchPrefix(previous: readonly ArchiveEntry[], next: readonly ArchiveEntry[]): boolean {
  if (previous.length > next.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function createProjectionState(): ProjectionState {
  return { items: [], toolOwners: new Map<string, number>() };
}

/**
 * 把 `branch[from..]` 折进投影状态。这是一次纯前向折叠：中间结果只有 items 与
 * toolOwners，所以追加的分支可以接着上次的状态往下折，结果和整条重折一致。
 */
async function foldBranch(state: ProjectionState, branch: readonly ArchiveEntry[], from: number): Promise<void> {
  const { items, toolOwners } = state;
  let checkpoint = Date.now();
  for (let cursor = from; cursor < branch.length; cursor += 1) {
    const entry = branch[cursor]!;
    if ((cursor & PARSE_YIELD_MASK) === 0 && Date.now() - checkpoint >= PARSE_YIELD_MS) {
      await yieldToEventLoop();
      checkpoint = Date.now();
    }
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
    if (conversationRedactKey(key)) result[key] = "[redacted]";
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

const PAGE_PAYLOAD_BYTE_STEPS = [64 * 1024, 16 * 1024, 4 * 1024, 1024, 256] as const;

function compactJson(value: JsonValue, maxBytes: number): JsonValue {
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes) return value;
  } catch {
    // Projected JSON should already be serializable; fail closed if it is not.
  }
  return { truncated: true };
}

/** Reduce large payloads while preserving item and tool association shells. */
function shrinkItem(item: ConversationItem, maxPayloadBytes: number): ConversationItem {
  if (item.kind === "message") {
    let changed = false;
    const content = item.content.map((block) => {
      if (block.type === "text" || block.type === "thinking") {
        const text = truncateText(block.text, Math.min(maxPayloadBytes, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES));
        if (!text.truncated) return block;
        changed = true;
        return { ...block, text: text.text, truncated: true };
      }
      if (block.type === "toolCall") {
        if (block.arguments === undefined) return block;
        const args = compactJson(block.arguments, maxPayloadBytes);
        if (args === block.arguments) return block;
        changed = true;
        return { ...block, arguments: args, truncated: true };
      }
      const output = block.output === undefined
        ? undefined
        : truncateText(block.output, Math.min(maxPayloadBytes, CONVERSATION_LIMITS.TEXT_BLOCK_MAX_BYTES));
      const data = block.data === undefined ? undefined : compactJson(block.data, maxPayloadBytes);
      if (output?.truncated !== true && data === block.data) return block;
      changed = true;
      return {
        ...block,
        ...(output === undefined ? {} : { output: output.text }),
        ...(data === undefined ? {} : { data }),
        truncated: true,
      };
    });
    if (!changed) return item;
    return {
      ...item,
      content,
    };
  }
  if (item.kind === "compaction") {
    const summary = truncateText(item.summary, maxPayloadBytes);
    const shortSummary = item.shortSummary === undefined ? undefined : truncateText(item.shortSummary, maxPayloadBytes);
    const warning = item.warning === undefined ? undefined : truncateText(item.warning, maxPayloadBytes);
    if (!summary.truncated && shortSummary?.truncated !== true && warning?.truncated !== true) return item;
    return {
      ...item,
      summary: summary.text.length > 0 ? summary.text : " ",
      ...(shortSummary === undefined ? {} : { shortSummary: shortSummary.text }),
      ...(warning === undefined ? {} : { warning: warning.text }),
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

/** Matches overlay `conversation-visibility.ts`: drop developer/custom, synthetic,
 * and agent-attributed steering user rows. A user-attributed steer is the
 * operator's own 插入纠偏 input and must render at its chronological position. */
function isHarnessInjectedUserMessage(message: Record<string, unknown>): boolean {
  if (message.role !== "user") return false;
  if (message.synthetic === true) return true;
  return message.steering === true && message.attribution !== "user";
}
