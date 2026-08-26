import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseSessionTelemetrySnapshot, type SessionTelemetrySnapshot } from "@omp-studio/studio-protocol";

/** On-disk record under `<profileDirectory>/session-telemetry/v1/`. */
export interface PersistedSessionTelemetryRecord {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly transcriptRevision: string;
  readonly recordedAt: string;
  readonly telemetry: SessionTelemetrySnapshot;
}

export interface SessionTelemetryStoreOptions {
  /** Versioned store directory (`<profileDirectory>/session-telemetry/v1`). */
  readonly rootDirectory: string;
  /** Hard cap per record file; oversized records are treated as cache misses. */
  readonly maxRecordBytes?: number;
  /** Per-session trailing debounce before a record is flushed to disk. */
  readonly writeDebounceMs?: number;
  /** Resolves the archive revision to stamp at flush time. */
  readonly resolveRevision?: (sessionId: string) => Promise<string | undefined>;
  readonly now?: () => Date;
}

const DEFAULT_MAX_RECORD_BYTES = 64 * 1024;
const DEFAULT_WRITE_DEBOUNCE_MS = 2_000;

interface PendingRecord {
  readonly sessionId: string;
  telemetry: SessionTelemetrySnapshot;
  timer: ReturnType<typeof setTimeout> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Host-internal persistence for "last observed" session telemetry.
 *
 * Listens to live telemetry pushes via {@link record}, debounces per session
 * (latest wins), stamps the current archive revision at flush time, and
 * writes atomically (tmp + rename) to `<sha256(sessionId)>.json`. Records are
 * only ever returned when their revision still matches the archive, so a
 * mutated transcript is a cache miss by construction. Messages, prompts,
 * paths, provider payloads, and credentials are never stored.
 */
export class SessionTelemetryStore {
  readonly #rootDirectory: string;
  readonly #maxRecordBytes: number;
  readonly #writeDebounceMs: number;
  readonly #resolveRevision: ((sessionId: string) => Promise<string | undefined>) | undefined;
  readonly #now: () => Date;
  readonly #pending = new Map<string, PendingRecord>();
  #disposed = false;
  /** Serializes atomic writes so tmp-file names never race a concurrent rename. */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: SessionTelemetryStoreOptions) {
    if (options.rootDirectory.length === 0) throw new TypeError("rootDirectory is required");
    this.#rootDirectory = options.rootDirectory;
    this.#maxRecordBytes = options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
    this.#writeDebounceMs = options.writeDebounceMs ?? DEFAULT_WRITE_DEBOUNCE_MS;
    this.#resolveRevision = options.resolveRevision;
    this.#now = options.now ?? (() => new Date());
  }

  /** Latest-wins telemetry push from the live event stream. */
  record(sessionId: string, telemetry: SessionTelemetrySnapshot): void {
    if (this.#disposed || sessionId.length === 0) return;
    let pending = this.#pending.get(sessionId);
    if (pending === undefined) {
      pending = { sessionId, telemetry, timer: undefined };
      this.#pending.set(sessionId, pending);
    } else {
      pending.telemetry = telemetry;
    }
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    // Trailing debounce: streaming deltas keep arriving without extra writes.
    pending.timer = setTimeout(() => {
      if (pending === undefined) return;
      pending.timer = undefined;
      void this.#flushSession(pending.sessionId);
    }, this.#writeDebounceMs);
    if (pending.timer.unref !== undefined) pending.timer.unref();
  }

  /**
   * Returns the persisted record only when it matches the requested archive
   * revision exactly; anything else is a cache miss.
   */
  async read(sessionId: string, expectedRevision: string): Promise<PersistedSessionTelemetryRecord | undefined> {
    if (sessionId.length === 0 || expectedRevision.length === 0) return undefined;
    const file = this.#recordPath(sessionId);
    let bytes: Buffer;
    try {
      const metadata = await stat(file);
      if (!metadata.isFile() || metadata.size > this.#maxRecordBytes) return undefined;
      bytes = await readFile(file);
    } catch {
      return undefined;
    }
    if (bytes.byteLength > this.#maxRecordBytes) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return undefined;
    }
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.sessionId !== sessionId ||
      value.transcriptRevision !== expectedRevision ||
      typeof value.recordedAt !== "string" ||
      value.recordedAt.length === 0 ||
      !Object.keys(value).every(
        (key) =>
          key === "schemaVersion" || key === "sessionId" || key === "transcriptRevision" || key === "recordedAt" || key === "telemetry",
      )
    ) {
      return undefined;
    }
    try {
      const telemetry = parseSessionTelemetrySnapshot(value.telemetry);
      if (telemetry.sessionId !== sessionId) return undefined;
      return { schemaVersion: 1, sessionId, transcriptRevision: expectedRevision, recordedAt: value.recordedAt, telemetry };
    } catch {
      return undefined;
    }
  }

  /** Flushes every pending record; used on detach and Host shutdown. */
  async flush(): Promise<void> {
    if (this.#disposed) return;
    for (const sessionId of [...this.#pending.keys()]) {
      await this.#flushSession(sessionId);
    }
    await this.#writeChain;
  }

  /**
   * Drop every trace of one session: clears the pending in-memory record and
   * deletes the persisted `<sha256(sessionId)>.json` (missing file tolerated).
   * Used when a session is permanently deleted so no telemetry residue stays.
   */
  async remove(sessionId: string): Promise<void> {
    if (this.#disposed || sessionId.length === 0) return;
    const pending = this.#pending.get(sessionId);
    if (pending !== undefined) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.timer = undefined;
      this.#pending.delete(sessionId);
    }
    await rm(this.#recordPath(sessionId), { force: true }).catch(() => {});
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  async #flushSession(sessionId: string): Promise<void> {
    const pending = this.#pending.get(sessionId);
    if (pending === undefined || this.#disposed) return;
    const revision =
      this.#resolveRevision === undefined ? undefined : await this.#resolveRevision(sessionId).catch(() => undefined);
    if (this.#disposed || revision === undefined || revision.length === 0) {
      // No reliable revision to stamp: drop instead of persisting a stale one.
      if (this.#pending.get(sessionId)?.timer === undefined) this.#pending.delete(sessionId);
      return;
    }
    const current = this.#pending.get(sessionId);
    if (current === undefined || current.telemetry !== pending.telemetry) return;
    const telemetryRef = current.telemetry;
    const record: PersistedSessionTelemetryRecord = {
      schemaVersion: 1,
      sessionId,
      transcriptRevision: revision,
      recordedAt: this.#now().toISOString(),
      telemetry: telemetryRef,
    };
    let serialized: string;
    try {
      serialized = JSON.stringify(record);
    } catch {
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > this.#maxRecordBytes) return;
    const write = this.#enqueueWrite(async () => {
      await this.#writeAtomic(sessionId, serialized);
      const latest = this.#pending.get(sessionId);
      if (latest !== undefined && latest.telemetry === telemetryRef && latest.timer === undefined) {
        this.#pending.delete(sessionId);
      }
    }).catch(() => {
      // A failed write only loses one "last observed" record.
    });
    await write;
  }

  #enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const next = this.#writeChain.then(operation, operation);
    this.#writeChain = next.catch(() => {});
    return next;
  }

  async #writeAtomic(sessionId: string, serialized: string): Promise<void> {
    const target = this.#recordPath(sessionId);
    await mkdir(this.#rootDirectory, { recursive: true });
    const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${serialized}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  #recordPath(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId, "utf8").digest("hex");
    return join(this.#rootDirectory, `${digest}.json`);
  }
}
