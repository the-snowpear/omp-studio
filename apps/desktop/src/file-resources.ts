import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ClientTransport, WorkspaceFileInfo, WorkspaceId } from "@omp-studio/client-contract";
import type { FileResource, FileResourceTarget } from "./file-viewer-shared.js";

const CHUNK = 512 * 1024;
interface Lease { target: FileResourceTarget; file: WorkspaceFileInfo; controller: AbortController; owner: number; pdf?: string }
export class FileResources {
  private leases = new Map<string, Lease>();
  constructor(private transport: (targetId: string | null) => Pick<ClientTransport, "query">) {}
  async open(target: FileResourceTarget, owner: number): Promise<FileResource> {
    const response = await this.transport(target.targetId).query({ queryName: "workspace.file.inspect", input: { workspaceId: target.workspaceId as WorkspaceId, path: target.path } });
    if (!response.ok) throw new Error(response.error.message);
    const file = response.result as WorkspaceFileInfo, id = randomUUID();
    this.leases.set(id, { target: { ...target, path: file.path }, file, controller: new AbortController(), owner });
    return { id, file, url: `omp-file://viewer/${id}` };
  }
  get(id: string, owner?: number): Lease {
    const lease = this.leases.get(id);
    if (!lease || owner !== undefined && lease.owner !== owner) throw new Error("文件视图已关闭");
    return lease;
  }
  release(id: string, owner?: number): void {
    const lease = this.leases.get(id);
    if (lease && (owner === undefined || owner === lease.owner)) { lease.controller.abort(); this.leases.delete(id); }
  }
  releaseOwner(owner: number): void { for (const [id, lease] of this.leases) if (lease.owner === owner) this.release(id); }
  setPdf(id: string, path: string): void { this.get(id).pdf = path; }
  async *bytes(id: string, start = 0, end?: number, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const lease = this.get(id), limit = Math.min(end ?? lease.file.size - 1, lease.file.size - 1);
    for (let offset = start; offset <= limit;) {
      lease.controller.signal.throwIfAborted(); signal?.throwIfAborted();
      const response = await this.transport(lease.target.targetId).query({ queryName: "workspace.file.readChunk", input: {
        workspaceId: lease.target.workspaceId as WorkspaceId, path: lease.target.path, version: lease.file.version, offset, length: Math.min(CHUNK, limit - offset + 1),
      } });
      if (!response.ok) throw new Error(response.error.message);
      lease.controller.signal.throwIfAborted(); signal?.throwIfAborted();
      const chunk = response.result as { data: string; bytes: number };
      if (!chunk.bytes) throw new Error("文件读取未完成，请重新加载");
      offset += chunk.bytes;
      yield Buffer.from(chunk.data, "base64");
    }
  }
  async copy(id: string, destination: string, signal?: AbortSignal): Promise<void> {
    await pipeline(Readable.from(this.bytes(id, 0, undefined, signal)), createWriteStream(destination), { signal: signal ?? this.get(id).controller.signal });
  }
  async response(request: Request, origin: string): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== "viewer" || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 400 });
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin && requestOrigin !== origin) return new Response(null, { status: 403 });
    const [id, variant] = url.pathname.slice(1).split("/");
    let lease: Lease;
    try { lease = this.get(id!); } catch { return new Response(null, { status: 404 }); }
    const pdf = variant === "preview.pdf" ? lease.pdf : undefined;
    if (variant && !pdf) return new Response(null, { status: 404 });
    const size = pdf ? (await stat(pdf)).size : lease.file.size;
    const range = request.headers.get("range");
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    let start = 0, end = size - 1;
    if (range) {
      if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      if (!match[1]) start = Math.max(0, size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const headers: Record<string, string> = {
      "Content-Type": pdf ? "application/pdf" : lease.file.mime, "Content-Length": String(Math.max(0, end - start + 1)), "Accept-Ranges": "bytes",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
      "Access-Control-Allow-Origin": origin, "Access-Control-Expose-Headers": "Accept-Ranges,Content-Length,Content-Range", Vary: "Origin",
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    const stream = request.method === "HEAD" || size === 0 ? null : pdf ? createReadStream(pdf, { start, end, signal: request.signal }) : Readable.from(this.bytes(id!, start, end, request.signal), { objectMode: false });
    return new Response(stream ? Readable.toWeb(stream) as ReadableStream<Uint8Array> : null, { status: range ? 206 : 200, headers });
  }
  dispose(): void { for (const id of this.leases.keys()) this.release(id); }
}
