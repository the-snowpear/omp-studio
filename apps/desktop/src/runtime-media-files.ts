import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ArtifactLibrary } from "@omp-studio/studio-host";
import type { ArtifactRecord } from "@omp-studio/studio-protocol";

const id = (value: string) => { if (!/^[a-f0-9-]{36}$/u.test(value)) throw new Error("Invalid private media identifier"); return value; };
export interface RuntimeMediaAsset { artifactId: string; kind: "image" | "audio" | "video" | "transcript"; name: string; mimeType: string; bytes: number; sha256: string }
const instances = new WeakMap<ArtifactLibrary, RuntimeMediaFiles>();
export function runtimeMediaFilesForLibrary(library: ArtifactLibrary): RuntimeMediaFiles { let value = instances.get(library); if (!value) { value = new RuntimeMediaFiles(library); instances.set(library, value); } return value; }

/** The directory comes only from the authenticated, Main-owned Runtime bundle. */
export class RuntimeMediaFiles {
  readonly #promoting = new Map<string, Promise<ArtifactRecord>>();
  constructor(readonly library: ArtifactLibrary) {}
  async releaseInputs(directory: string, grants: readonly { transferId: string }[]): Promise<void> {
    await Promise.all(grants.flatMap(grant => [".bin", ".json"].map(extension => unlink(join(directory, "inputs", id(grant.transferId) + extension)).catch(() => {}))));
  }
  async stage(directory: string, artifactId: string, remainingBytes = 64 * 1024 * 1024, sessionId?: string): Promise<{ artifactId: string; transferId: string; bytes: number }> {
    id(artifactId); const source = await this.library.resolve(artifactId);
    const transferId = randomUUID();
    if (!["image", "audio", "video"].includes(source.record.kind) || source.record.bytes > Math.min(remainingBytes, 64 * 1024 * 1024)) throw new Error("Media inputs must total at most 64 MiB");
    const inputs = join(directory, "inputs"); await mkdir(inputs, { recursive: true, mode: 0o700 });
    const target = join(inputs, transferId + ".bin"); const temporary = target + ".partial";
    const digest = createHash("sha256"); let bytes = 0;
    const verify = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; if (bytes > source.record.bytes) { callback(new Error("Media input changed")); return; } digest.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(createReadStream(source.path), verify, createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (bytes !== source.record.bytes || digest.digest("hex") !== source.record.sha256) throw new Error("Media input integrity check failed");
      await rename(temporary, target);
      const metadata = join(inputs, transferId + ".json");
      const metaTemporary = metadata + "." + randomUUID() + ".partial";
      const meta = createWriteStream(metaTemporary, { flags: "wx", mode: 0o600 });
      try { await pipeline((async function* () { yield Buffer.from(JSON.stringify({ ...source.record, artifactId: transferId, sourceArtifactId: artifactId, sessionId })); })(), meta); await rename(metaTemporary, metadata); }
      finally { await unlink(metaTemporary).catch(() => {}); }
    } catch (cause) { await this.releaseInputs(directory, [{ transferId }]); throw cause; }
    finally { await unlink(temporary).catch(() => {}); }
    return { artifactId, transferId, bytes: source.record.bytes };
  }
  promote(directory: string, sessionId: string, workspaceId: string | undefined, jobId: string, asset: RuntimeMediaAsset): Promise<ArtifactRecord> {
    const key = `media:${id(jobId)}:${id(asset.artifactId)}`;
    const existing = this.#promoting.get(key); if (existing) return existing;
    const work = this.#promote(directory, sessionId, workspaceId, key, asset);
    this.#promoting.set(key, work); void work.finally(() => this.#promoting.delete(key)).catch(() => {}); return work;
  }
  async #promote(directory: string, sessionId: string, workspaceId: string | undefined, runId: string, asset: RuntimeMediaAsset): Promise<ArtifactRecord> {
    const previous = await this.library.findByRunId(runId); if (previous) return previous;
    if (!["image", "audio", "video", "transcript"].includes(asset.kind) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0 || asset.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/u.test(asset.sha256)) throw new Error("Invalid Runtime media output");
    const file = join(directory, "outputs", createHash("sha256").update(sessionId).digest("hex"), id(asset.artifactId) + ".bin"); const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== asset.bytes) throw new Error("Runtime media output is unavailable");
    const digest = createHash("sha256"); let bytes = 0;
    const content = async function* () {
      for await (const chunk of createReadStream(file)) { const data = chunk as Buffer; bytes += data.length; if (bytes > asset.bytes) throw new Error("Media output changed"); digest.update(data); yield data; }
      if (bytes !== asset.bytes || digest.digest("hex") !== asset.sha256) throw new Error("Media output integrity check failed");
    };
    const record = await this.library.register({ kind: asset.kind, name: asset.name, mimeType: asset.mimeType, sessionId, ...(workspaceId ? { workspaceId } : {}), runId }, content());
    await unlink(file).catch(() => {});
    return record;
  }
  /** Called after the owning Runtime stops; retain promotes unviewed outputs before cleanup. */
  async finishSession(directory: string, sessionId: string, cascade: boolean): Promise<void> {
    const key = createHash("sha256").update(sessionId).digest("hex");
    const fences = join(directory, "deleted-sessions"); await mkdir(fences, { recursive: true, mode: 0o700 });
    await writeFile(join(fences, key + ".json"), JSON.stringify({ sessionId, cascade }), { mode: 0o600 });
    const jobs = join(directory, "jobs", key);
    for (const name of await readdir(jobs).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const file = join(jobs, name); const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 800000) continue;
      const stored = JSON.parse(await readFile(file, "utf8")) as { job?: { id?: string; sessionId?: string }; outputs?: RuntimeMediaAsset[] };
      if (!cascade && stored.job?.sessionId === sessionId && stored.job.id && Array.isArray(stored.outputs)) {
        for (const output of stored.outputs) await this.promote(directory, sessionId, undefined, stored.job.id, output).catch(cause => { if (!(cause instanceof Error) || !cause.message.includes("explicitly removed")) throw cause; });
      }
      await unlink(file);
    }
    const outputs = join(directory, "outputs", key);
    for (const name of await readdir(outputs).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.bin(?:\.partial)?$/u.test(name)) continue;
      await unlink(join(outputs, name));
    }
    const inputs = join(directory, "inputs");
    for (const name of await readdir(inputs).catch(() => [])) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(name)) continue;
      const file = join(inputs, name); const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) continue;
      const meta = JSON.parse(await readFile(file, "utf8")) as { sessionId?: string };
      if (meta.sessionId === sessionId) await this.releaseInputs(directory, [{ transferId: name.slice(0, -5) }]);
    }
  }
  /** Private descriptor read for future authenticated realtime audio; never pass it to Renderer. */
  async descriptor(directory: string, audioId: string): Promise<unknown> {
    const file = join(directory, "audio", id(audioId) + ".json"); const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Audio descriptor unavailable");
    return JSON.parse(await readFile(file, "utf8"));
  }
}
