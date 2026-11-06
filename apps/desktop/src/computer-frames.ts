import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import type { ArtifactLibrary } from "@omp-studio/studio-host";
import type { ComputerFrame } from "@omp-studio/studio-protocol";
import { runtimeMediaFilesForLibrary, type RuntimeMediaAsset } from "./runtime-media-files.js";
import { COMPUTER_FRAME_CHANNELS, type ComputerFrameRequest, type ComputerFrameReadResult, type ComputerFrameSaveResult } from "./computer-frames-shared.js";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const FRAME_BYTES = 32 * 1024 * 1024;
const READ_BUDGET = 64 * 1024 * 1024;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RETENTION_BYTES = 1024 * 1024 * 1024;
const unavailable = "电脑画面不可用或已过期，请刷新观察画面。 / Computer frame is unavailable or expired.";

/** Written only by the owning Runtime into its managed media root. Never returned to Renderer. */
interface FrameDescriptor {
  version: 1;
  scopeSessionId: string;
  frame: ComputerFrame;
  bytes: number;
  sha256: string;
  leaseId?: string;
  runFinished?: boolean;
}
interface FrameRetention {
  frameId: string;
  scopeSessionId: string;
  artifactId?: string;
  kept: boolean;
  expired?: boolean;
}
interface FrameFiles {
  directory: string;
  descriptor: string;
  retention: string;
  payload: string;
}
interface ManagedFrame {
  library: ArtifactLibrary;
  descriptor: FrameDescriptor;
  files: FrameFiles;
  retention?: FrameRetention;
}

function sessionKey(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function request(value: unknown): ComputerFrameRequest {
  if (!value || typeof value !== "object") throw new Error(unavailable);
  const input = value as ComputerFrameRequest;
  if (input.origin !== "local" || typeof input.scopeSessionId !== "string" || !input.scopeSessionId.trim() || input.scopeSessionId.length > 512 || typeof input.frameId !== "string" || !UUID.test(input.frameId)) throw new Error(unavailable);
  return input;
}
async function assertInside(root: string, target: string): Promise<void> {
  const [base, path] = await Promise.all([realpath(root), realpath(target)]);
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  if (!normalize(path).startsWith(normalize(base + sep))) throw new Error(unavailable);
}
async function readSmallJson<T>(file: string): Promise<T> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024) throw new Error(unavailable);
  const text = await readFile(file, "utf8");
  if (Buffer.byteLength(text) > 32 * 1024) throw new Error(unavailable);
  return JSON.parse(text) as T;
}
async function optionalRetention(file: string): Promise<FrameRetention | undefined> {
  try { return await readSmallJson<FrameRetention>(file); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw cause; }
}
function validPng(bytes: Buffer, frame: ComputerFrame): boolean {
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR"
    && bytes.readUInt32BE(16) === frame.width && bytes.readUInt32BE(20) === frame.height;
}

/** Private, reusable frame delivery. Additional observation frames are never automatically promoted. */
export class ComputerFrameStore {
  readonly #locks = new Map<string, Promise<unknown>>();
  #readingBytes = 0;
  #timer: NodeJS.Timeout | undefined;
  #disposed = false;
  #sweeping = false;
  readonly #now: () => number;
  constructor(readonly options: {
    directory(): string;
    library(): ArtifactLibrary;
    now?: () => number;
    maxAgeMs?: number;
    maxStoredBytes?: number;
    onError?: (error: unknown) => void;
  }) { this.#now = options.now ?? Date.now; }

  start(): void {
    if (this.#timer || this.#disposed) return;
    const tick = async () => {
      try { await this.sweep(); } catch (error) { this.options.onError?.(error); }
      if (!this.#disposed) { this.#timer = setTimeout(() => void tick(), 60_000); this.#timer.unref(); }
    };
    this.#timer = setTimeout(() => void tick(), 5_000);
    this.#timer.unref();
  }
  dispose(): void { this.#disposed = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }

  #serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    this.#locks.set(key, result);
    void result.finally(() => { if (this.#locks.get(key) === result) this.#locks.delete(key); }).catch(() => {});
    return result;
  }

  async #load(input: ComputerFrameRequest): Promise<ManagedFrame> {
    if (this.#disposed) throw new Error(unavailable);
    const directory = this.options.directory();
    const scopeDirectory = join(directory, "computer-workspace", sessionKey(input.scopeSessionId));
    const parent = await lstat(scopeDirectory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error(unavailable);
    await assertInside(directory, scopeDirectory);
    const descriptorFile = join(scopeDirectory, input.frameId + ".json");
    const descriptor = await readSmallJson<FrameDescriptor>(descriptorFile);
    const frame = descriptor.frame;
    if (descriptor.version !== 1 || descriptor.scopeSessionId !== input.scopeSessionId || !frame || frame.frameId !== input.frameId
      || typeof frame.sessionId !== "string" || !frame.sessionId || frame.sessionId.length > 512
      || !["execution", "observation"].includes(frame.source)
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 33 || descriptor.bytes > FRAME_BYTES
      || !HASH.test(descriptor.sha256) || !Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
      || frame.width < 1 || frame.height < 1 || frame.width * frame.height > 32_000_000
      || !Number.isFinite(frame.capturedAt)) throw new Error(unavailable);
    const retentionFile = join(scopeDirectory, input.frameId + ".artifact.json");
    const retention = await optionalRetention(retentionFile);
    if (retention && (retention.scopeSessionId !== input.scopeSessionId || retention.frameId !== input.frameId || (retention.artifactId !== undefined && !UUID.test(retention.artifactId)))) throw new Error(unavailable);
    return { library: this.options.library(), descriptor, files: { directory, descriptor: descriptorFile, retention: retentionFile, payload: join(directory, "outputs", sessionKey(frame.sessionId), frame.frameId + ".bin") }, ...(retention ? { retention } : {}) };
  }

  #expired(row: ManagedFrame): boolean {
    if (row.retention?.expired) return true;
    if (row.retention?.kept) return false;
    const { frame } = row.descriptor;
    if (frame.source === "observation") return !Number.isFinite(frame.expiresAt) || frame.expiresAt! <= this.#now();
    return frame.capturedAt + (this.options.maxAgeMs ?? RETENTION_MS) <= this.#now();
  }

  async #saveRetention(row: ManagedFrame, value: FrameRetention): Promise<void> {
    const temporary = row.files.retention + "." + randomUUID() + ".partial";
    try { await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 }); await rename(temporary, row.files.retention); }
    finally { await unlink(temporary).catch(() => {}); }
    row.retention = value;
  }

  async #lookupArtifact(row: ManagedFrame): Promise<string | undefined> {
    if (row.retention?.artifactId) {
      const artifact = await row.library.resolve(row.retention.artifactId);
      if (artifact.record.sessionId === undefined && !row.retention.kept && !row.retention.expired) await this.#saveRetention(row, { ...row.retention, kept: true });
      return row.retention.artifactId;
    }
    if (row.descriptor.frame.source !== "execution") return undefined;
    const frame = row.descriptor.frame;
    const existing = await row.library.findByRunId(`media:${frame.frameId}:${frame.frameId}`);
    if (!existing) return undefined;
    await this.#saveRetention(row, { scopeSessionId: row.descriptor.scopeSessionId, frameId: frame.frameId, artifactId: existing.artifactId, kept: existing.sessionId === undefined });
    return existing.artifactId;
  }

  async #promote(row: ManagedFrame): Promise<string> {
    const previous = await this.#lookupArtifact(row);
    if (previous) { await row.library.resolve(previous); return previous; }
    const { frame, bytes, sha256 } = row.descriptor;
    const asset: RuntimeMediaAsset = { artifactId: frame.frameId, kind: "image", name: `computer-${frame.frameId}.png`, mimeType: "image/png", bytes, sha256 };
    const artifact = await runtimeMediaFilesForLibrary(row.library).promote(row.files.directory, frame.sessionId, undefined, frame.frameId, asset);
    await this.#saveRetention(row, { scopeSessionId: row.descriptor.scopeSessionId, frameId: frame.frameId, artifactId: artifact.artifactId, kept: artifact.sessionId === undefined });
    return artifact.artifactId;
  }

  async read(raw: unknown): Promise<ComputerFrameReadResult> {
    const input = request(raw);
    return this.#serial(input.frameId, async () => {
      const row = await this.#load(input);
      let artifactId = await this.#lookupArtifact(row);
      if (this.#expired(row)) throw new Error(unavailable);
      if (!artifactId && row.descriptor.frame.source === "execution" && row.descriptor.runFinished) artifactId = await this.#promote(row);
      const bytes = await this.#bytes(row, artifactId);
      return { ok: true, data: Uint8Array.from(bytes).buffer, width: row.descriptor.frame.width, height: row.descriptor.frame.height, mimeType: "image/png", ...(artifactId ? { artifactId } : {}) };
    });
  }

  async #bytes(row: ManagedFrame, artifactId?: string): Promise<Buffer> {
    if (this.#readingBytes + row.descriptor.bytes > READ_BUDGET) throw new Error(unavailable);
    this.#readingBytes += row.descriptor.bytes;
    try {
      const path = artifactId ? (await row.library.resolve(artifactId)).path : row.files.payload;
      if (!artifactId) await assertInside(row.files.directory, path);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== row.descriptor.bytes) throw new Error(unavailable);
      const bytes = await readFile(path);
      if (bytes.length !== row.descriptor.bytes || !validPng(bytes, row.descriptor.frame) || createHash("sha256").update(bytes).digest("hex") !== row.descriptor.sha256) throw new Error(unavailable);
      if (this.#disposed) throw new Error(unavailable);
      return bytes;
    } finally { this.#readingBytes -= row.descriptor.bytes; }
  }

  async save(raw: unknown): Promise<ComputerFrameSaveResult> {
    const input = request(raw);
    return this.#serial(input.frameId, async () => {
      const row = await this.#load(input);
      const previous = await this.#lookupArtifact(row);
      if (this.#expired(row)) throw new Error(unavailable);
      await this.#bytes(row, previous);
      const artifactId = await this.#promote(row);
      await row.library.retain(artifactId);
      await this.#saveRetention(row, { scopeSessionId: input.scopeSessionId, frameId: input.frameId, artifactId, kept: true });
      return { ok: true, artifactId };
    });
  }

  /** Only this feature's registered copies are considered; user exports and native originals are untouched. */
  async sweep(): Promise<void> {
    if (this.#disposed || this.#sweeping) return;
    this.#sweeping = true;
    try {
      const directory = this.options.directory();
      const root = join(directory, "computer-workspace");
      const scopes = await readdir(root, { withFileTypes: true }).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
      const rows: ManagedFrame[] = [];
      for (const scope of scopes) {
        if (!scope.isDirectory() || !HASH.test(scope.name)) continue;
        const folder = join(root, scope.name);
        for (const name of await readdir(folder)) {
          if (!name.endsWith(".json") || !UUID.test(name.slice(0, -5))) continue;
          try {
            const descriptor = await readSmallJson<FrameDescriptor>(join(folder, name));
            if (sessionKey(descriptor.scopeSessionId) !== scope.name) continue;
            const row = await this.#load({ scopeSessionId: descriptor.scopeSessionId, frameId: name.slice(0, -5), origin: "local" });
            await this.#lookupArtifact(row);
            rows.push(row);
          } catch (error) { this.options.onError?.(error); }
        }
      }
      // A shared execution frame can have more than one scope descriptor. Keep any explicitly saved reference.
      const groups = new Map<string, ManagedFrame[]>();
      for (const row of rows) { const key = row.descriptor.frame.frameId; const refs = groups.get(key) ?? []; refs.push(row); groups.set(key, refs); }
      const ordered = [...groups.values()].sort((a, b) => a[0]!.descriptor.frame.capturedAt - b[0]!.descriptor.frame.capturedAt);
      let total = ordered.reduce((sum, refs) => sum + (refs.some(row => row.retention?.kept || row.retention?.expired) ? 0 : refs[0]!.descriptor.frame.source === "execution" ? refs[0]!.descriptor.bytes : 0), 0);
      const promotions: ManagedFrame[] = [];
      for (const refs of ordered) {
        const row = refs[0]!;
        if (refs.some(value => value.retention?.kept) || refs.every(value => value.retention?.expired)) continue;
        const overBudget = row.descriptor.frame.source === "execution" && total > (this.options.maxStoredBytes ?? RETENTION_BYTES);
        if (!this.#expired(row) && !overBudget) {
          if (row.descriptor.frame.source === "execution" && row.descriptor.runFinished && !row.retention?.artifactId) promotions.push(row);
          continue;
        }
        await this.#serial(row.descriptor.frame.frameId, async () => {
          // Re-read after waiting: explicit save may have won the race.
          const current = await Promise.all(refs.map(value => this.#load({ scopeSessionId: value.descriptor.scopeSessionId, frameId: value.descriptor.frame.frameId, origin: "local" })));
          if (current.some(value => value.retention?.kept)) return;
          if (row.descriptor.frame.source === "execution") await row.library.discardRun("media:" + row.descriptor.frame.frameId + ":" + row.descriptor.frame.frameId);
          const removed = new Set<string>();
          for (const value of current) {
            if (value.retention?.artifactId && !removed.has(value.retention.artifactId)) { await value.library.remove(value.retention.artifactId); removed.add(value.retention.artifactId); }
            await unlink(value.files.payload).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
            if (value.descriptor.frame.source === "execution") await unlink(join(value.files.directory, "jobs", sessionKey(value.descriptor.frame.sessionId), value.descriptor.frame.frameId + ".json")).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
            await this.#saveRetention(value, { scopeSessionId: value.descriptor.scopeSessionId, frameId: value.descriptor.frame.frameId, ...(value.retention?.artifactId ? { artifactId: value.retention.artifactId } : {}), kept: false, expired: true });
          }
          if (row.descriptor.frame.source === "execution" && !row.retention?.expired) total -= row.descriptor.bytes;
        }).catch(error => this.options.onError?.(error));
      }
      for (let start = 0; start < promotions.length; start += 8) {
        await Promise.all(promotions.slice(start, start + 8).map(row => this.#serial(row.descriptor.frame.frameId, async () => {
          const current = await this.#load({ scopeSessionId: row.descriptor.scopeSessionId, frameId: row.descriptor.frame.frameId, origin: "local" });
          if (!this.#expired(current)) await this.#promote(current);
        }).catch(error => this.options.onError?.(error))));
      }
    } finally { this.#sweeping = false; }
  }
}

export function registerComputerFrameIpc(options: {
  ipcMain: TerminalIpcMain;
  store: ComputerFrameStore;
  isTrustedSender(sender: TerminalSender): boolean;
  isVisible(sender: TerminalSender): boolean;
}): { dispose(): void } {
  let disposed = false;
  const allowed = (sender: TerminalSender) => !disposed && !sender.isDestroyed() && options.isTrustedSender(sender) && options.isVisible(sender);
  options.ipcMain.handle(COMPUTER_FRAME_CHANNELS.read, async ({ sender }, raw): Promise<ComputerFrameReadResult> => {
    if (!allowed(sender)) return { ok: false, message: unavailable };
    try { const result = await options.store.read(raw); return allowed(sender) ? result : { ok: false, message: unavailable }; }
    catch { return { ok: false, message: unavailable }; }
  });
  options.ipcMain.handle(COMPUTER_FRAME_CHANNELS.save, async ({ sender }, raw): Promise<ComputerFrameSaveResult> => {
    if (!allowed(sender)) return { ok: false, message: unavailable };
    try { return await options.store.save(raw); }
    catch { return { ok: false, message: unavailable }; }
  });
  options.store.start();
  return { dispose() { disposed = true; options.store.dispose(); options.ipcMain.removeHandler(COMPUTER_FRAME_CHANNELS.read); options.ipcMain.removeHandler(COMPUTER_FRAME_CHANNELS.save); } };
}
