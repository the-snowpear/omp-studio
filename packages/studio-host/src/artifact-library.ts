import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, unlink, realpath, lstat } from "node:fs/promises";
import { basename, extname, isAbsolute, join } from "node:path";
import { ARTIFACT_KINDS, ARTIFACT_TEXT_MAX_BYTES, validateArtifactTextInput, type ArtifactTextInput, type ArtifactTextResult, type ArtifactKind, type ArtifactRecord, type ArtifactListInput, type ArtifactPage, type ArtifactStorageState } from "@omp-studio/studio-protocol";

interface StoredArtifact { record: ArtifactRecord; rootId: string; filename: string }
interface Catalog {
  version: 1;
  activeRoot: string;
  roots: Record<string, string>;
  artifacts: StoredArtifact[];
  sessionPolicies?: Record<string, "retain" | "delete">;
  removedRunIds?: string[];
}
export interface ArtifactRegistration {
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly mimeType: string;
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
}
export interface ArtifactLibraryOptions {
  readonly profileDirectory: string;
  readonly maxArtifactBytes?: number;
  readonly now?: () => Date;
}

const ID = /^[a-f0-9-]{36}$/u;
const CATALOG_MAX_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";

/** One desktop-owned instance, shared by every workspace and resident Runtime. */
export class ArtifactLibrary {
  readonly #directory: string;
  readonly #defaultPayloadRoot: string;
  readonly #maxArtifactBytes: number;
  readonly #now: () => Date;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ArtifactLibraryOptions) {
    if (!isAbsolute(options.profileDirectory)) throw new Error("Artifact profile must be absolute");
    this.#directory = join(options.profileDirectory, "artifact-library", "v1");
    this.#defaultPayloadRoot = join(this.#directory, "content");
    this.#maxArtifactBytes = options.maxArtifactBytes ?? 2 * 1024 * 1024 * 1024;
    if (!Number.isSafeInteger(this.#maxArtifactBytes) || this.#maxArtifactBytes < 1) throw new Error("Invalid artifact size limit");
    this.#now = options.now ?? (() => new Date());
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #load(): Promise<Catalog> {
    const file = join(this.#directory, "catalog.json");
    const metadata = await lstat(file).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (!metadata) return { version: 1, activeRoot: "default", roots: { default: this.#defaultPayloadRoot }, artifacts: [] };
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > CATALOG_MAX_BYTES) throw new Error("Artifact catalog is unavailable");
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object") throw new Error("Invalid artifact catalog");
    const catalog = value as Catalog;
    if (catalog.version !== 1 || !catalog.roots || !catalog.roots[catalog.activeRoot] || !Array.isArray(catalog.artifacts) || catalog.artifacts.length > MAX_RECORDS) throw new Error("Invalid artifact catalog");
    if (catalog.sessionPolicies && (Object.keys(catalog.sessionPolicies).length > MAX_RECORDS || Object.entries(catalog.sessionPolicies).some(([key, value]) => !key.startsWith("session:") || !["retain", "delete"].includes(value)))) throw new Error("Invalid artifact session policy");
    if (catalog.removedRunIds && (!Array.isArray(catalog.removedRunIds) || catalog.removedRunIds.length > MAX_RECORDS || catalog.removedRunIds.some(id => typeof id !== "string" || id.length > 512))) throw new Error("Invalid artifact deletion history");
    for (const directory of Object.values(catalog.roots)) if (typeof directory !== "string" || !isAbsolute(directory)) throw new Error("Invalid artifact storage root");
    for (const item of catalog.artifacts) {
      const record = item.record;
      if (!record || !ID.test(record.artifactId) || !catalog.roots[item.rootId] || item.filename !== basename(item.filename) || !item.filename.startsWith(record.artifactId + ".") || !ARTIFACT_KINDS.includes(record.kind) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || typeof record.createdAt !== "string") throw new Error("Invalid artifact record");
    }
    return catalog;
  }

  async #save(catalog: Catalog): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(catalog));
    if (bytes.length > CATALOG_MAX_BYTES || catalog.artifacts.length > MAX_RECORDS) throw new Error("Artifact library is full; export or remove unused artifacts");
    await mkdir(this.#directory, { recursive: true });
    const temporary = join(this.#directory, `.catalog-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, join(this.#directory, "catalog.json")); }
    finally { await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; }); }
  }

  /** Called only with a directory selected/validated by the desktop boundary. Existing entries keep their root. */
  setDirectory(directory: string): Promise<ArtifactStorageState> {
    return this.#serial(async () => {
      if (!isAbsolute(directory)) throw new Error("Artifact storage location must be absolute");
      await mkdir(directory, { recursive: true });
      const canonical = await realpath(directory);
      const probe = join(canonical, `.omp-write-probe-${randomUUID()}`);
      const handle = await open(probe, "wx", 0o600);
      await handle.close(); await unlink(probe);
      const catalog = await this.#load();
      const rootId = createHash("sha256").update(canonical).digest("hex");
      catalog.roots[rootId] = canonical;
      catalog.activeRoot = rootId;
      await this.#save(catalog);
      return this.#storageState(catalog, true);
    });
  }

  async state(): Promise<ArtifactStorageState> {
    await this.#tail;
    const catalog = await this.#load();
    let writable = false;
    try {
      const root = catalog.roots[catalog.activeRoot]!;
      await mkdir(root, { recursive: true });
      const probe = join(root, `.omp-write-probe-${randomUUID()}`);
      const handle = await open(probe, "wx", 0o600); await handle.close(); await unlink(probe); writable = true;
    } catch { /* State reports unavailable storage without changing its location. */ }
    return this.#storageState(catalog, writable);
  }

  #storageState(catalog: Catalog, writable: boolean): ArtifactStorageState {
    return { locationName: basename(catalog.roots[catalog.activeRoot]!), writable, total: catalog.artifacts.length, totalBytes: catalog.artifacts.reduce((sum, item) => sum + item.record.bytes, 0) };
  }

  async register(input: ArtifactRegistration, content: AsyncIterable<Uint8Array>): Promise<ArtifactRecord> {
      await this.#tail;
      if (!ARTIFACT_KINDS.includes(input.kind) || !input.name.trim() || input.name.length > 512 || /[\0\r\n]/u.test(input.name) || !/^[\w.+-]+\/[\w.+-]+$/u.test(input.mimeType)) throw new Error("Invalid artifact metadata");
      const catalog = await this.#load();
      const artifactId = randomUUID();
      const extension = extname(input.name).toLowerCase();
      const filename = artifactId + (/^\.[a-z0-9]{1,12}$/u.test(extension) ? extension : ".bin");
      const directory = catalog.roots[catalog.activeRoot]!;
      await mkdir(directory, { recursive: true });
      const target = join(directory, filename);
      const temporary = target + ".partial";
      let committed = false;
      let bytes = 0;
      const digest = createHash("sha256");
      try {
        const handle = await open(temporary, "wx", 0o600);
        try {
          for await (const chunk of content) {
            bytes += chunk.byteLength;
            if (bytes > this.#maxArtifactBytes) throw new Error("Artifact exceeds the configured size limit");
            digest.update(chunk);
            await handle.writeFile(chunk);
          }
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, target);
        let record: ArtifactRecord = {
          artifactId, kind: input.kind, name: basename(input.name), mimeType: input.mimeType, bytes,
          createdAt: this.#now().toISOString(), sha256: digest.digest("hex"),
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
          ...(input.runId === undefined ? {} : { runId: input.runId }),
        };
        await this.#serial(async () => {
          const latest = await this.#load();
          if (input.runId && latest.removedRunIds?.includes(input.runId)) throw new Error("This generated output was explicitly removed from the artifact library");
          const policy = record.sessionId ? latest.sessionPolicies?.["session:" + record.sessionId] : undefined;
          if (policy === "delete") throw new Error("The session and its managed artifacts were deleted");
          if (policy === "retain") { const { sessionId: _sessionId, ...retained } = record; record = retained; }
          latest.roots[catalog.activeRoot] = directory;
          latest.artifacts.push({ record, rootId: catalog.activeRoot, filename });
          await this.#save(latest);
        });
        committed = true;
        return structuredClone(record);
      } finally {
        await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
        if (!committed) await unlink(target).catch(error => { if (!isMissing(error)) throw error; });
      }
  }

  registerBytes(input: ArtifactRegistration, bytes: Uint8Array): Promise<ArtifactRecord> {
    return this.register(input, (async function* () { yield bytes; })());
  }

  saveText(input: ArtifactTextInput): Promise<ArtifactRecord> {
    validateArtifactTextInput(input);
    const { text, ...metadata } = input;
    const mimeType = input.name.endsWith(".json") ? "application/json" : input.name.endsWith(".jsonl") ? "application/x-ndjson" : "text/plain";
    return this.registerBytes({ ...metadata, mimeType }, Buffer.from(text, "utf8"));
  }

  async readText(artifactId: string): Promise<ArtifactTextResult> {
    const item = await this.resolve(artifactId);
    if (item.record.bytes > ARTIFACT_TEXT_MAX_BYTES || !/^(?:text\/|application\/(?:json|x-ndjson)$)/u.test(item.record.mimeType)) throw new Error("This artifact cannot be read as bounded text");
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of createReadStream(item.path)) {
      const bytes = Buffer.from(chunk); size += bytes.byteLength;
      if (size > ARTIFACT_TEXT_MAX_BYTES) throw new Error("Text artifact exceeds its limit");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== item.record.bytes || createHash("sha256").update(bytes).digest("hex") !== item.record.sha256) throw new Error("Artifact content changed");
    return { artifact: item.record, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }

  async list(input: ArtifactListInput = {}): Promise<ArtifactPage> {
    await this.#tail;
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid artifact page size");
    const catalog = await this.#load();
    const rows = catalog.artifacts.map(item => item.record).filter(row =>
      (input.workspaceId === undefined || row.workspaceId === input.workspaceId) &&
      (input.sessionId === undefined || row.sessionId === input.sessionId) &&
      (input.kind === undefined || row.kind === input.kind));
    const key = (record: ArtifactRecord) => record.createdAt + "/" + record.artifactId;
    rows.sort((a, b) => key(b).localeCompare(key(a)));
    const start = input.cursor === undefined ? 0 : rows.findIndex(row => key(row) === input.cursor) + 1;
    if (input.cursor !== undefined && start === 0) throw new Error("Artifact cursor is stale; refresh the list");
    const page = rows.slice(start, start + limit);
    return { artifacts: structuredClone(page), total: rows.length, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0), ...(start + limit < rows.length && page.length ? { nextCursor: key(page[page.length - 1]!) } : {}) };
  }

  /** Private file path, never return it from a public query or place it in an event. */
  async resolve(artifactId: string): Promise<{ record: ArtifactRecord; path: string }> {
    if (!ID.test(artifactId)) throw new Error("Invalid artifact ID");
    await this.#tail;
    const catalog = await this.#load();
    const item = catalog.artifacts.find(row => row.record.artifactId === artifactId);
    if (!item) throw new Error("Artifact does not exist");
    const path = join(catalog.roots[item.rootId]!, item.filename);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== item.record.bytes) throw new Error("Artifact file is missing or changed");
    return { record: structuredClone(item.record), path };
  }

  /** Main-only idempotent output promotion lookup. No payload reads or path disclosure. */
  async findByRunId(runId: string): Promise<ArtifactRecord | undefined> {
    await this.#tail;
    const catalog = await this.#load();
    if (catalog.removedRunIds?.includes(runId)) throw new Error("This generated output was explicitly removed from the artifact library");
    const record = catalog.artifacts.find(item => item.record.runId === runId)?.record;
    return record ? structuredClone(record) : undefined;
  }

  async read(artifactId: string): Promise<{ record: ArtifactRecord; stream: ReturnType<typeof createReadStream> }> {
    const item = await this.resolve(artifactId);
    return { record: item.record, stream: createReadStream(item.path) };
  }

  remove(artifactId: string): Promise<void> {
    return this.#serial(async () => {
      if (!ID.test(artifactId)) throw new Error("Invalid artifact ID");
      const catalog = await this.#load();
      const item = catalog.artifacts.find(row => row.record.artifactId === artifactId);
      if (!item) return;
      if (item.record.runId && !catalog.removedRunIds?.includes(item.record.runId)) {
        if ((catalog.removedRunIds?.length ?? 0) >= MAX_RECORDS) throw new Error("Artifact deletion history is full");
        catalog.removedRunIds = [...(catalog.removedRunIds ?? []), item.record.runId];
        // Persist the fence before removing bytes, so a delayed Runtime poll cannot resurrect them.
        await this.#save(catalog);
      }
      // Delete a single derived payload filename, never a directory or user export.
      await unlink(join(catalog.roots[item.rootId]!, item.filename)).catch(error => { if (!isMissing(error)) throw error; });
      catalog.artifacts = catalog.artifacts.filter(row => row !== item);
      await this.#save(catalog);
    });
  }

  /** Default session deletion retains generated files as independently managed artifacts. */
  detachSession(sessionId: string): Promise<void> {
    return this.finishSession(sessionId, false);
  }

  /** Persist a deletion policy so an in-flight stream cannot reattach deleted sessions. */
  finishSession(sessionId: string, deleteManagedArtifacts: boolean): Promise<void> {
    return this.#serial(async () => {
      const catalog = await this.#load();
      catalog.sessionPolicies ??= {};
      const key = "session:" + sessionId;
      if (!catalog.sessionPolicies[key] && Object.keys(catalog.sessionPolicies).length >= MAX_RECORDS) throw new Error("Artifact session policy limit reached");
      catalog.sessionPolicies[key] = deleteManagedArtifacts ? "delete" : "retain";
      await this.#save(catalog);
      for (const item of catalog.artifacts) {
        if (item.record.sessionId !== sessionId) continue;
        if (deleteManagedArtifacts) {
          await unlink(join(catalog.roots[item.rootId]!, item.filename)).catch(error => { if (!isMissing(error)) throw error; });
          continue;
        }
        const { sessionId: _sessionId, ...retained } = item.record;
        item.record = retained;
      }
      if (deleteManagedArtifacts) catalog.artifacts = catalog.artifacts.filter(item => item.record.sessionId !== sessionId);
      await this.#save(catalog);
    });
  }
}
