import { randomUUID } from "node:crypto";
import { Duplex, type TransformCallback } from "node:stream";
import type { RemotePeer } from "./wire.js";

export interface NetworkDestination { host: string; port: number; service?: "broker"; }
interface Packet { channel: "network"; id: string; kind: "data" | "credit" | "end" | "close"; data?: string; bytes?: number; }
const WINDOW = 256 * 1024, CHUNK = 48 * 1024;

/** Credit follows consumption, bounding memory even when a streamed response stalls. */
class ByteStream extends Duplex {
  credit = WINDOW;
  private withheld = 0;
  private pending: { data: Buffer; offset: number; callback: TransformCallback } | undefined;
  remoteClosed = false;
  private flushing = false;
  private ended = false;
  constructor(readonly owner: NetworkStreams, readonly id: string) { super({ highWaterMark: 64 * 1024, allowHalfOpen: true }); this.on("error", () => {}); }
  override _read(): void { if (this.withheld) { const bytes = this.withheld; this.withheld = 0; this.owner.send({ channel: "network", id: this.id, kind: "credit", bytes }); } }
  override _write(data: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void { this.pending = { data, offset: 0, callback }; this.flush(); }
  flush(): void {
    const pending = this.pending; if (!pending || this.destroyed || this.flushing) return;
    this.flushing = true;
    while (this.credit > 0 && pending.offset < pending.data.length) {
      const length = Math.min(CHUNK, this.credit, pending.data.length - pending.offset);
      const data = pending.data.subarray(pending.offset, pending.offset + length).toString("base64");
      pending.offset += length; this.credit -= length;
      this.owner.send({ channel: "network", id: this.id, kind: "data", data });
    }
    this.flushing = false;
    if (pending.offset === pending.data.length) { this.pending = undefined; pending.callback(); }
  }
  receive(packet: Packet): void {
    if (packet.kind === "credit") { this.credit += packet.bytes!; this.flush(); }
    else if (packet.kind === "data") {
      const bytes = Buffer.from(packet.data!, "base64");
      if (this.push(bytes)) this.owner.send({ channel: "network", id: this.id, kind: "credit", bytes: bytes.length });
      else this.withheld += bytes.length;
    } else if (packet.kind === "end") this.push(null);
    else { this.remoteClosed = true; this.destroy(); }
  }
  override _final(callback: TransformCallback): void { this.ended = true; this.owner.send({ channel: "network", id: this.id, kind: "end" }); callback(); }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.owner.streams.delete(this.id);
    if (!this.remoteClosed && (!this.ended || error)) this.owner.send({ channel: "network", id: this.id, kind: "close" });
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending.callback(error ?? new Error("网络通道已关闭")); }
    callback(error);
  }
}

export class NetworkStreams {
  readonly streams = new Map<string, ByteStream>();
  private closed = false;
  constructor(readonly peer: RemotePeer, dial?: (destination: NetworkDestination) => Promise<Duplex>) {
    peer.onEvent(event => {
      const packet = event as Packet;
      if (packet?.channel !== "network") return;
      this.streams.get(packet.id)?.receive(packet);
    });
    if (dial) peer.handle(async (method, input) => {
      if (method !== "network.open") throw new Error("Unsupported network channel operation");
      const request = input as NetworkDestination & { id: string };
      if (!request.id || !request.host || !Number.isInteger(request.port) || request.port < 1 || request.port > 65535) throw new Error("Invalid network destination");
      const socket = await dial(request);
      if (this.closed) { socket.destroy(); throw new Error("网络通道已断开"); }
      const stream = new ByteStream(this, request.id); this.streams.set(request.id, stream);
      socket.on("error", error => stream.destroy(error)); stream.on("error", () => socket.destroy());
      stream.on("close", () => socket.destroy()); socket.on("close", (failed: boolean) => { if (failed) stream.destroy(); else stream.push(null); });
      socket.pipe(stream).pipe(socket);
      return { connected: true };
    });
    peer.onClose(() => this.close());
  }
  send(packet: Packet): void { if (!this.closed) { try { this.peer.publish(packet); } catch { this.close(); } } }
  async open(destination: NetworkDestination): Promise<Duplex> {
    if (this.closed) throw new Error("本机联网通道尚未连接");
    const id = randomUUID(), stream = new ByteStream(this, id); this.streams.set(id, stream);
    try { await this.peer.request("network.open", { ...destination, id }, 20_000); return stream; }
    catch (error) { stream.destroy(); throw error; }
  }
  close(): void { if (this.closed) return; this.closed = true; for (const stream of this.streams.values()) { stream.remoteClosed = true; stream.destroy(new Error("本机联网通道已断开；请求未重放")); } this.streams.clear(); }
}
