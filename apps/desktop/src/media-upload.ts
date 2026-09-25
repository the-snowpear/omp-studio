import { randomUUID } from "node:crypto";
import type { ArtifactLibrary } from "@omp-studio/studio-host";
import type { ArtifactRecord } from "@omp-studio/studio-protocol";
import type { TerminalIpcMain, TerminalSender } from "./terminal-ipc.js";
import { MEDIA_UPLOAD_CHANNELS, type MediaUploadInput, type MediaUploadResult } from "./media-upload-shared.js";

const MAX_BYTES = 64 * 1024 * 1024;
class UploadStream implements AsyncIterable<Uint8Array> {
  #next: { data: Uint8Array; resolve(): void; reject(error: Error): void } | undefined;
  #wake: (() => void) | undefined; #ended = false; #error: Error | undefined;
  push(data: Uint8Array): Promise<void> {
    if (this.#ended || this.#next) return Promise.reject(new Error("Upload stream is busy or closed"));
    return new Promise((resolve, reject) => { this.#next = { data, resolve, reject }; this.#wake?.(); this.#wake = undefined; });
  }
  end(error?: Error): void { this.#ended = true; this.#error = error; this.#wake?.(); this.#wake = undefined; if (error) this.#next?.reject(error); }
  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    try {
      while (!this.#ended || this.#next) {
        if (this.#error) throw this.#error;
        const next = this.#next;
        if (!next) { await new Promise<void>(resolve => { this.#wake = resolve; }); continue; }
        try { yield next.data; next.resolve(); } catch (cause) { next.reject(cause instanceof Error ? cause : new Error("Upload failed")); throw cause; }
        finally { if (this.#next === next) this.#next = undefined; }
      }
      if (this.#error) throw this.#error;
    } finally { this.#next?.reject(new Error("Upload closed")); this.#next = undefined; this.#ended = true; }
  }
}
interface Upload { id: string; owner: number; stream: UploadStream; saved: Promise<ArtifactRecord>; sequence: number; bytes: number; busy: boolean; lastAt: number }
function object(value: unknown, fields: readonly string[]): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error("Invalid upload object"); return value as Record<string, unknown>; }
function short(value: unknown, max = 512): void { if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) throw new Error("Invalid upload text"); }
export class MediaUploadManager {
  readonly #uploads = new Map<string, Upload>(); readonly #timer: ReturnType<typeof setInterval>;
  constructor(readonly library: () => ArtifactLibrary) { this.#timer = setInterval(() => { for (const upload of this.#uploads.values()) if (Date.now() - upload.lastAt > 60000) this.abort(upload.owner, upload.id); }, 10000); this.#timer.unref?.(); }
  begin(owner: number, raw: unknown): { uploadId: string } {
    const input = object(raw, ["kind", "name", "mimeType", "workspaceId", "sessionId"]); short(input.name); short(input.mimeType, 128);
    if (!["image", "audio", "video"].includes(input.kind as string) || !(input.mimeType as string).startsWith(input.kind + "/") || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(input.mimeType as string) || /[\\/]/u.test(input.name as string)) throw new Error("Invalid upload media type or filename");
    for (const field of ["workspaceId", "sessionId"]) if (input[field] !== undefined) short(input[field]);
    if ([...this.#uploads.values()].filter(upload => upload.owner === owner).length >= 2) throw new Error("At most two uploads per window");
    const id = randomUUID(); const stream = new UploadStream();
    const saved = this.library().register(input as unknown as MediaUploadInput, stream);
    const upload: Upload = { id, owner, stream, saved, sequence: 0, bytes: 0, busy: false, lastAt: Date.now() };
    this.#uploads.set(id, upload); void saved.catch(() => { stream.end(new Error("Upload storage failed")); this.#uploads.delete(id); });
    return { uploadId: id };
  }
  #get(owner: number, id: unknown): Upload { if (typeof id !== "string") throw new Error("Missing upload identifier"); const upload = this.#uploads.get(id); if (!upload || upload.owner !== owner) throw new Error("Upload is unavailable in this window"); return upload; }
  async chunk(owner: number, raw: unknown): Promise<void> {
    const input = object(raw, ["uploadId", "sequence", "bytes"]); const upload = this.#get(owner, input.uploadId);
    if (upload.busy || input.sequence !== upload.sequence || !(input.bytes instanceof ArrayBuffer) || input.bytes.byteLength < 1 || input.bytes.byteLength > 262144 || upload.bytes + input.bytes.byteLength > MAX_BYTES) throw new Error("Invalid, oversized or out-of-order upload chunk");
    upload.busy = true; upload.lastAt = Date.now();
    try { await upload.stream.push(new Uint8Array(input.bytes)); upload.sequence++; upload.bytes += input.bytes.byteLength; }
    finally { upload.busy = false; }
  }
  async finish(owner: number, id: unknown): Promise<ArtifactRecord> {
    const upload = this.#get(owner, id); if (upload.busy) throw new Error("Wait for the current upload chunk");
    upload.stream.end(); try { return await upload.saved; } finally { this.#uploads.delete(upload.id); }
  }
  abort(owner: number, id: unknown): void { const upload = this.#get(owner, id); upload.stream.end(new Error("Upload cancelled")); this.#uploads.delete(upload.id); }
  disposeWindow(owner: number): void { for (const upload of this.#uploads.values()) if (upload.owner === owner) this.abort(owner, upload.id); }
  dispose(): void { clearInterval(this.#timer); for (const upload of this.#uploads.values()) this.abort(upload.owner, upload.id); }
}
export function registerMediaUploadIpc(options: { ipcMain: TerminalIpcMain; isTrustedSender(sender: TerminalSender): boolean; manager: MediaUploadManager }): { dispose(): void } {
  const tracked = new Set<number>();
  for (const [kind, channel] of Object.entries(MEDIA_UPLOAD_CHANNELS)) options.ipcMain.handle(channel, async ({ sender }, payload): Promise<MediaUploadResult> => {
    if (sender.isDestroyed() || !options.isTrustedSender(sender)) throw new Error("Untrusted media upload");
    if (!tracked.has(sender.id)) { tracked.add(sender.id); const dispose = () => { tracked.delete(sender.id); options.manager.disposeWindow(sender.id); }; sender.once("destroyed", dispose); sender.once("did-navigate", dispose); }
    try {
      if (kind === "begin") return { ok: true, ...options.manager.begin(sender.id, payload) };
      if (kind === "chunk") { await options.manager.chunk(sender.id, payload); return { ok: true }; }
      const input = object(payload, ["uploadId"]);
      if (kind === "finish") return { ok: true, artifact: await options.manager.finish(sender.id, input.uploadId) };
      options.manager.abort(sender.id, input.uploadId); return { ok: true };
    } catch { return { ok: false, message: "Media upload failed. Check the file size, upload order and artifact storage location." }; }
  });
  return { dispose: () => { for (const owner of tracked) options.manager.disposeWindow(owner); tracked.clear(); Object.values(MEDIA_UPLOAD_CHANNELS).forEach(channel => options.ipcMain.removeHandler(channel)); } };
}
