import type { GraphicResult } from "./graphic-types";

type Entry = { name: string; source: string; result: GraphicResult; bytes: number; readers: number };
export type GraphicResultLease = { result: GraphicResult; release: () => void };

function retainedBytes(result: GraphicResult): number {
  const buffers = new Set<ArrayBufferLike>();
  if (result.kind === "document") {
    buffers.add(result.bundle.bytes.buffer);
    for (const bytes of Object.values(result.bundle.resources)) buffers.add(bytes.buffer);
  } else for (const mesh of result.meshes) {
    for (const bytes of [mesh.position, mesh.normal, mesh.uv, mesh.color, mesh.index]) if (bytes) buffers.add(bytes.buffer);
  }
  return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0)
    + (result.kind === "scene" ? result.images.reduce((total, image) => total + image.width * image.height * 4, 0) : 0);
}

/** Keep warm geometry without keeping WebGL contexts. Active viewers remain owned by their leases. */
class GraphicResultCache {
  readonly entries = new Set<Entry>();
  readonly sources = new Map<string, Map<string, Entry>>();
  readonly maximumBytes = 32 * 1024 * 1024;

  read(name: string, source: string): GraphicResultLease | undefined {
    const entry = this.sources.get(name)?.get(source);
    return entry && this.lease(entry);
  }
  store(name: string, source: string, result: GraphicResult): GraphicResultLease {
    const existing = this.read(name, source);
    if (existing) {
      if (result.kind === "scene") for (const image of result.images) image.close();
      return existing;
    }
    const entry = { name, source, result, bytes: retainedBytes(result), readers: 0 };
    let sources = this.sources.get(name);
    if (!sources) this.sources.set(name, sources = new Map());
    sources.set(source, entry);
    this.entries.add(entry);
    return this.lease(entry);
  }
  private lease(entry: Entry): GraphicResultLease {
    entry.readers++;
    this.entries.delete(entry); this.entries.add(entry);
    this.trim();
    return { result: entry.result, release: () => { entry.readers--; this.trim(); } };
  }
  private trim() {
    let bytes = [...this.entries].reduce((total, entry) => total + entry.bytes, 0);
    for (const entry of this.entries) {
      if (bytes <= this.maximumBytes && this.entries.size <= 12) break;
      if (entry.readers) continue;
      this.entries.delete(entry);
      const sources = this.sources.get(entry.name)!;
      if (sources.get(entry.source) === entry) sources.delete(entry.source);
      if (!sources.size) this.sources.delete(entry.name);
      if (entry.result.kind === "scene") for (const image of entry.result.images) image.close();
      bytes -= entry.bytes;
    }
  }
}

export const graphicResultCache = new GraphicResultCache();
