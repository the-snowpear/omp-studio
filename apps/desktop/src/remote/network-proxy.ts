import { Agent, createServer, request, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { connect, isIP, type Socket, type TcpNetConnectOpts } from "node:net";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";
import type { NetworkStreams, NetworkDestination } from "./network-stream.js";
import type { RemoteNetworkMode } from "./shared.js";

export function connectTcp(host: string, port: number, timeoutMs = 10_000, lookup?: TcpNetConnectOpts["lookup"]): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, ...(lookup ? { lookup } : {}) });
    const timeout = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("连接目标超时"), { code: "ETIMEDOUT" })); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timeout); socket.off("error", reject); resolve(socket); });
    socket.once("error", error => { clearTimeout(timeout); reject(error); });
  });
}
export function remotePrivateHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (name === "localhost" || name.endsWith(".local") || /^(?:0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(name)) return true;
  if (isIP(name) !== 6) return false;
  const address = new URL(`http://[${name}]`).hostname.slice(1, -1);
  if (address.startsWith("::ffff:")) {
    const [high, low] = address.slice(7).split(":").map(value => Number.parseInt(value, 16));
    return remotePrivateHost(`${high! >>> 8}.${high! & 255}.${low! >>> 8}.${low! & 255}`);
  }
  return address === "::" || address === "::1" || /^(?:fc|fd|fe[89ab])/u.test(address);
}
export class RemoteNetworkProxy {
  private channel: NetworkStreams | undefined;
  private mode: RemoteNetworkMode = "remote-first";
  private readonly localHosts = new Set<string>();
  private readonly sockets = new Set<Duplex>();
  private readonly server: Server;
  private readonly broker: Server;
  private readonly proxyPassword = randomBytes(32).toString("base64url");
  private readonly proxyAuthorization = `Basic ${Buffer.from(`omp-studio:${this.proxyPassword}`).toString("base64")}`;
  proxyUrl = "";
  brokerUrl = "";
  report: (route: "remote" | "local") => void = () => {};
  constructor(readonly dialRemote = connectTcp) {
    this.server = createServer((req, res) => {
      if (!this.authorized(req)) { res.writeHead(407, { "Proxy-Authenticate": "Basic realm=\"OMP Studio\"" }); res.end(); return; }
      void this.http(req, res);
    });
    this.server.on("connect", (req, socket, head) => {
      if (!this.authorized(req)) { socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"OMP Studio\"\r\nConnection: close\r\n\r\n"); return; }
      void (async () => {
        const url = new URL(`http://${req.url}`);
        const upstream = await this.open({ host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || 443) });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) upstream.write(head);
        this.pipe(socket, upstream);
      })().catch(() => { socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
    });
    this.broker = createServer((req, res) => { void this.http(req, res, true); });
  }
  async start(): Promise<void> {
    const listen = (server: Server) => new Promise<string>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(`http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`); }); });
    const proxy = new URL(await listen(this.server));
    proxy.username = "omp-studio"; proxy.password = this.proxyPassword;
    this.proxyUrl = proxy.href.replace(/\/$/u, ""); this.brokerUrl = await listen(this.broker);
  }
  private authorized(req: IncomingMessage): boolean { return req.headers["proxy-authorization"] === this.proxyAuthorization; }
  attach(channel: NetworkStreams): void { this.channel?.close(); this.channel = channel; }
  configure(mode: RemoteNetworkMode): void { this.mode = mode; this.localHosts.clear(); }
  reset(): void { this.localHosts.clear(); }
  async open(destination: NetworkDestination): Promise<Duplex> {
    if (destination.service === "broker") return this.local(destination);
    const privateHost = remotePrivateHost(destination.host);
    const key = `${destination.host}:${destination.port}`;
    if (!privateHost && (this.mode === "local-only" || this.localHosts.has(key))) return this.local(destination);
    try { const stream = await this.dialRemote(destination.host, destination.port); this.report("remote"); return stream; }
    catch (error) {
      if (privateHost || this.mode === "remote-only") throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET"].includes(code ?? "")) throw error;
      const stream = await this.local(destination); this.localHosts.add(key); return stream;
    }
  }
  private async local(destination: NetworkDestination): Promise<Duplex> {
    if (!this.channel) throw new Error("远端无法联网，本机联网通道尚未连接");
    const stream = await this.channel.open(destination); if (!destination.service) this.report("local"); return stream;
  }
  private pipe(a: Duplex, b: Duplex): void {
    this.sockets.add(a); this.sockets.add(b);
    a.on("error", () => b.destroy()); b.on("error", () => a.destroy());
    a.on("close", () => { this.sockets.delete(a); b.destroy(); }); b.on("close", () => { this.sockets.delete(b); a.destroy(); });
    a.pipe(b).pipe(a);
  }
  private async http(req: IncomingMessage, res: ServerResponse, broker = false): Promise<void> {
    let stream: Duplex | undefined;
    try {
      const url = new URL(req.url!, broker ? "http://broker" : undefined);
      stream = await this.open({ host: url.hostname, port: Number(url.port || 80), ...(broker ? { service: "broker" as const } : {}) });
      const headers = { ...req.headers }; delete headers["proxy-authorization"]; delete headers["proxy-connection"];
      // A dedicated Agent is required here: `agent: false` bypasses `createConnection`
      // and would let Node resolve/connect to the model host on the remote machine.
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = (_options, callback) => {
        const socket = stream as Socket & { setNoDelay(): Socket; setKeepAlive(): Socket; ref(): Socket; unref(): Socket };
        socket.setNoDelay ??= () => socket;
        socket.setKeepAlive ??= () => socket;
        socket.ref ??= () => socket;
        socket.unref ??= () => socket;
        process.nextTick(() => callback?.(null, socket));
        return socket;
      };
      const upstream = request({ host: url.hostname, port: Number(url.port || 80), method: req.method, path: url.pathname + url.search, headers, agent }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      upstream.once("close", () => agent.destroy());
      upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("联网请求失败；未自动重放"); });
      res.on("close", () => { upstream.destroy(); stream?.destroy(); }); req.pipe(upstream);
    } catch { stream?.destroy(); res.writeHead(502); res.end("远端及本机网络出口均不可用"); }
  }
  async close(): Promise<void> {
    this.channel?.close(); for (const socket of this.sockets) socket.destroy();
    await Promise.all([this.server, this.broker].map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  }
}
