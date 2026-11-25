import type { WorkspaceId } from "@omp-studio/client-contract";
import { LoopbackWebAdapter, type WebAdapterHost } from "@omp-studio/transport-web";
import { X509Certificate } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import { getMobileCertificate } from "./mobile-certificate.js";
import { createMobileScope } from "./mobile-scope.js";

const assetTypes = new Map([
  [".css", "text/css"], [".js", "text/javascript"], [".woff2", "font/woff2"],
]);

export function mobileAddresses(): string[] {
  return [...new Set(Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === "IPv4" && !entry.internal).map(entry => entry.address)))].sort();
}

export async function startMobileAccess(options: {
  host: WebAdapterHost;
  ip: string;
  workspaceId: WorkspaceId;
  workspaceName: string;
  profileDirectory: string;
  rendererDirectory: string;
  onPaired?: () => Promise<void>;
  onRevoked?: () => void;
}) {
  const entry = await readFile(join(options.rendererDirectory, "mobile.html"));
  const material = await getMobileCertificate(options.profileDirectory, options.ip);
  const authority = new X509Certificate(material.authority);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  const server = createServer({ key: material.key, cert: material.cert });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, options.ip, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = `${options.ip}:${(server.address() as AddressInfo).port}`;
  const origin = `https://${address}`;
  const csp = `default-src 'self'; connect-src 'self' wss://${address}; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
  const adapter = new LoopbackWebAdapter({
    origins: [origin],
    host: createMobileScope(options.host, options.workspaceId),
    pairingTtlMs: 60_000,
    sessionTtlMs: 8 * 60 * 60 * 1000,
    mobile: { workspaceName: options.workspaceName, workspaceId: options.workspaceId },
    ...(options.onPaired ? { onPaired: options.onPaired } : {}),
    ...(options.onRevoked ? { onRevoked: options.onRevoked } : {}),
  });
  await adapter.revokeAll();
  server.on("request", (request, response) => {
    if (request.headers.host !== address) { response.writeHead(403).end(); return; }
    const path = (request.url ?? "/").split("?")[0]!;
    if (path.startsWith("/api/v1/")) { void adapter.handle(request, response); return; }
    if (request.method !== "GET") { response.writeHead(405).end(); return; }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (path === "/" || path === "/mobile.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=UTF-8", "Content-Security-Policy": csp, "Cache-Control": "no-store" }).end(entry);
      return;
    }
    const asset = /^\/assets\/([a-zA-Z0-9_.-]+\.(?:css|js|woff2))$/.exec(path)?.[1];
    if (!asset) { response.writeHead(404).end(); return; }
    const contentType = assetTypes.get(asset.slice(asset.lastIndexOf(".")))!;
    void readFile(join(options.rendererDirectory, "assets", asset)).then(
      data => response.writeHead(200, { "Content-Type": contentType }).end(data),
      () => response.writeHead(404).end(),
    );
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.host !== address || request.url?.split("?")[0] !== "/api/v1/events" || !adapter.authenticateWebSocket(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, websocket => {
      const connection = adapter.trackMobileEvents(request, () => websocket.terminate());
      if (!connection) { websocket.terminate(); return; }
      const stop = connection.host.subscribe({ scope: "all" }, event => {
        if (websocket.bufferedAmount > 2 * 1024 * 1024) websocket.terminate();
        else websocket.send(JSON.stringify(event));
      });
      websocket.once("close", () => { stop(); connection.unsubscribe(); });
      websocket.on("error", () => websocket.terminate());
      websocket.send(JSON.stringify({ kind: "mobile.ready" }));
      let alive = true;
      websocket.on("pong", () => { alive = true; });
      const heartbeat = setInterval(() => {
        if (!alive) websocket.terminate();
        else { alive = false; websocket.ping(); }
      }, 15_000);
      heartbeat.unref();
      websocket.once("close", () => clearInterval(heartbeat));
    });
  });
  return {
    origin,
    fingerprint: authority.fingerprint256,
    certificate: authority.raw,
    workspaceName: options.workspaceName,
    paired: () => adapter.paired,
    async pair() {
      adapter.rotatePairingCode();
      const url = `${origin}/#pair=${adapter.pairingCode}`;
      return { url, expiresAt: adapter.pairingExpiresAt, qr: await QRCode.toDataURL(url, { width: 256, margin: 2 }) };
    },
    revoke: () => adapter.revokeAll(),
    async close() {
      const revoked = adapter.revokeAll();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([revoked, closed]);
    },
  };
}
