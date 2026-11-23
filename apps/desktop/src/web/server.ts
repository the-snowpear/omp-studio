import {
  LoopbackWebAdapter,
  type WebAdapterHost,
  type RememberedWebSession,
} from "@omp-studio/transport-web";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, writeFile, rename, mkdir, realpath } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { X509Certificate, randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { WebSocketServer } from "ws";
import QRCode from "qrcode";
import { getMobileCertificate } from "../mobile-certificate.js";
import { activeArtifactLibrary } from "../artifact-library.js";
import { artifactResponse } from "../chrome-artifacts.js";
import { HostControl, isViewCommand } from "./control.js";
import type { SharedTerminals } from "./terminals.js";
import { desktopText, setDesktopLanguage } from "../desktop-language-shared.js";
import { MediaUploadManager } from "../media-upload.js";
import { desktopConversationViews } from "../desktop-performance.js";
import { serveStatistics } from "./statistics.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bcmap": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".otf": "font/otf",
  ".mjs": "text/javascript",
  ".pfb": "application/octet-stream",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".wav": "audio/wav",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function lanAddresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces()).flatMap((rows) =>
        (rows ?? [])
          .filter((row) => row.family === "IPv4" && !row.internal)
          .map((row) => row.address),
      ),
    ),
  ].sort();
}

export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

export async function readJson(
  req: IncomingMessage,
  limit = 1024 * 1024,
): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface WebServerOptions {
  openView?: () => Promise<
    import("@omp-studio/client-contract").ClientTransport
  >;
  host: WebAdapterHost;
  control: HostControl;
  terminals: SharedTerminals;
  stateDirectory: string;
  rendererDirectory: string;
  port?: number;
  ip?: string;
}

export async function startWebServer(options: WebServerOptions) {
  const root = await realpath(options.rendererDirectory);
  await readFile(join(root, "web.html"));
  const ip = options.ip ?? "127.0.0.1";
  const secure = ip !== "127.0.0.1";
  if (secure && !lanAddresses().includes(ip))
    throw new Error(desktopText("请选择此主机上的网络地址", "Select an address belonging to this Host"));
  const storage = join(options.stateDirectory, "web");
  await mkdir(storage, { recursive: true, mode: 0o700 });
  const material = secure ? await getMobileCertificate(storage, ip) : undefined;
  const server: Server = material
    ? createHttpsServer({ key: material.key, cert: material.cert })
    : createServer();
  const sessionsFile = join(
    storage,
    secure ? "lan-devices.json" : "local-devices.json",
  );
  const remembered = await readFile(sessionsFile, "utf8")
    .then((text) => JSON.parse(text) as RememberedWebSession[])
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, ip, () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address() as { port: number };
  const origin = `${secure ? "https" : "http"}://${ip}:${address.port}`;
  let saving = Promise.resolve();
  const adapter = new LoopbackWebAdapter({
    ...(options.openView ? { openView: options.openView } : {}),
    host: options.host,
    origins: [origin],
    secure,
    cookieName: `studio_web_${createHash("sha256").update(options.stateDirectory).digest("hex").slice(0, 12)}`,
    sessionTtlMs: 400 * 24 * 60 * 60 * 1000,
    maxBodyBytes: 16 * 1024 * 1024,
    rememberedSessions: remembered,
    saveSessions: (sessions) => {
      const contents = JSON.stringify(sessions);
      const save = saving.then(async () => {
        const temporary = `${sessionsFile}.${randomUUID()}.tmp`;
        await writeFile(temporary, contents, { mode: 0o600 });
        await rename(temporary, sessionsFile);
      });
      saving = save.catch(() => {});
      return save;
    },
    beforeCommand: (req, command) => {
      if (!isViewCommand(command.commandName, command.input))
        options.control.assert(
          adapter.authorize(req)!.id,
          req.headers["x-studio-control"],
        );
    },
    onRevoked: (id) => {
      options.control.release(id);
      const owner = uploadOwners.get(id);
      if (owner !== undefined) uploads.disposeWindow(owner);
    },
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 1024,
    perMessageDeflate: false,
  });
  const uploads = new MediaUploadManager(activeArtifactLibrary);
  const uploadOwners = new Map<string, number>();
  const uploadOwner = (id: string) => {
    if (!uploadOwners.has(id)) uploadOwners.set(id, uploadOwners.size + 1);
    return uploadOwners.get(id)!;
  };
  const api = {
    origin,
    fingerprint: material
      ? new X509Certificate(material.authority).fingerprint256
      : undefined,
    certificate: material
      ? new X509Certificate(material.authority).raw
      : undefined,
    adapter,
    async pair() {
      adapter.rotatePairingCode();
      const url = `${origin}/#pair=${adapter.pairingCode}`;
      return {
        url,
        expiresAt: adapter.pairingExpiresAt,
        qr: await QRCode.toDataURL(url, { width: 256, margin: 2 }),
      };
    },
    async close() {
      uploads.dispose();
      await adapter.close();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
      await saving;
    },
  };

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.headers.host !== new URL(origin).host)
      return sendJson(res, 403, { error: "forbidden" });
    const path = new URL(req.url ?? "/", origin).pathname;
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (path.startsWith("/stats/")) {
      await serveStatistics(req, res, adapter, options.control);
      return;
    }
    if (path.startsWith("/api/web/") || path.startsWith("/api/artifacts/")) {
      const device = adapter.authorize(req, req.method !== "GET");
      if (!device) return sendJson(res, 401, { error: "unauthenticated" });
      if (path === "/api/web/control") {
        if (req.method === "POST") options.control.take(device.id, device.name);
        return sendJson(res, 200, {
          deviceId: device.id,
          ...options.control.state,
        });
      }
      if (
        path === "/api/web/terminals/recordingStatus" &&
        req.method === "POST"
      )
        return sendJson(
          res,
          200,
          options.terminals.record("status", await readJson(req)),
        );
      if (path === "/api/web/language" && req.method === "POST") {
        const { locale } = await readJson(req);
        if (locale !== "zh" && locale !== "en")
          throw new Error("invalid_language");
        setDesktopLanguage(locale);
        return sendJson(res, 200, { ok: true });
      }
      if (path === "/api/web/devices")
        return sendJson(res, 200, adapter.devices());
      if (path === "/api/web/view" && req.method === "POST") {
        const value = await readJson(req);
        const key = viewKeys.get(device.id);
        return sendJson(
          res,
          200,
          key ? desktopConversationViews.report(key, value) : false,
        );
      }
      if (path === "/api/web/terminals" && req.method === "GET")
        return sendJson(res, 200, options.terminals.list());
      if (path === "/api/web/file" && req.method === "GET") {
        const query = new URL(req.url!, origin).searchParams;
        const workspaceId = query.get("workspaceId")!;
        const filePath = query.get("path")!;
        const system = query.get("source") === "system";
        const inspected = system
          ? await options.host.query({ queryName: "fs.file.inspect", input: { path: filePath } })
          : await options.host.query({ queryName: "workspace.file.inspect", input: { workspaceId: workspaceId as any, path: filePath } });
        if (!inspected.ok) throw new Error(inspected.error.message);
        const file = inspected.result;
        res.writeHead(200, {
          "content-type": file.mime ?? "application/octet-stream",
          "cache-control": "no-store",
          "content-security-policy":
            "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          ...(query.has("download")
            ? {
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
              }
            : {}),
        });
        for (let offset = 0; offset < file.size; offset += 262144) {
          if (res.destroyed || !adapter.authorize(req)) break;
          const input = { path: filePath, version: file.version, offset, length: Math.min(262144, file.size - offset) };
          const chunk = system
            ? await options.host.query({ queryName: "fs.file.readChunk", input })
            : await options.host.query({ queryName: "workspace.file.readChunk", input: { ...input, workspaceId: workspaceId as any } });
          if (!chunk.ok) throw new Error(chunk.error.message);
          if (!res.write(Buffer.from(chunk.result.data, "base64")))
            await new Promise<void>((done) => {
              res.once("drain", done);
              res.once("close", done);
            });
        }
        res.end();
        return;
      }
      if (path.startsWith("/api/artifacts/") && req.method === "GET") {
        const request = new Request(
          `omp-artifact://library/${path.slice("/api/artifacts/".length)}`,
          { headers: req.headers.range ? { range: req.headers.range } : {} },
        );
        const response = await artifactResponse(
          request,
          activeArtifactLibrary(),
        );
        res.setHeader(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        );
        res.writeHead(
          response.status,
          Object.fromEntries(response.headers.entries()),
        );
        if (response.body)
          Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          ).pipe(res);
        else res.end();
        return;
      }
      options.control.assert(device.id, req.headers["x-studio-control"]);
      const input = await readJson(req, 32 * 1024 * 1024);
      // The request body can outlive a control transfer.
      options.control.assert(device.id, req.headers["x-studio-control"]);
      switch (path) {
        case "/api/web/upload/begin":
          return sendJson(res, 200, {
            ok: true,
            ...uploads.begin(uploadOwner(device.id), input),
          });
        case "/api/web/upload/chunk": {
          const bytes = Buffer.from(input.data, "base64");
          await uploads.chunk(uploadOwner(device.id), {
            uploadId: input.uploadId,
            sequence: input.sequence,
            bytes: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          });
          return sendJson(res, 200, { ok: true });
        }
        case "/api/web/upload/finish":
          return sendJson(res, 200, {
            ok: true,
            artifact: await uploads.finish(
              uploadOwner(device.id),
              input.uploadId,
            ),
          });
        case "/api/web/upload/abort":
          uploads.abort(uploadOwner(device.id), input.uploadId);
          return sendJson(res, 200, { ok: true });
        case "/api/web/devices/revoke":
          await adapter.revokeDevice(input.id);
          break;
        case "/api/web/devices/rename":
          await adapter.renameDevice(input.id, input.name);
          break;
        case "/api/web/terminals/create":
          return sendJson(
            res,
            200,
            await options.terminals.create(input, () =>
              options.control.assert(
                device.id,
                req.headers["x-studio-control"],
              ),
            ),
          );
        case "/api/web/terminals/write":
          options.terminals.write(input);
          break;
        case "/api/web/terminals/resize":
          options.terminals.resize(input);
          break;
        case "/api/web/terminals/dispose":
          options.terminals.remove(input);
          break;
        case "/api/web/terminals/recordingStart":
          return sendJson(res, 200, options.terminals.record("start", input));
        case "/api/web/terminals/recordingStop":
          return sendJson(
            res,
            200,
            await options.terminals.record("stop", input),
          );
        case "/api/web/terminals/recordingStatus":
          return sendJson(res, 200, options.terminals.record("status", input));
        default:
          return sendJson(res, 404, { error: "not_found" });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (path.startsWith("/api/v1/")) {
      await adapter.handle(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const file = await realpath(
      resolve(
        root,
        `.${path === "/" || path === "/index.html" ? "/web.html" : decodeURIComponent(path)}`,
      ),
    );
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end();
      return;
    }
    const type = MIME[extname(file)];
    if (!type) {
      res.writeHead(404).end();
      return;
    }
    const bytes = await readFile(file);
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' blob:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    );
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": path.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : bytes);
  }
  server.on("request", (req, res) => {
    void handle(req, res).catch((error) => {
      if (!res.headersSent)
        sendJson(
          res,
          error.code === "control_required"
            ? 409
            : error.code === "ENOENT"
              ? 404
              : 400,
          { error: error.code ?? "operation_failed", message: error.message },
        );
      else res.destroy();
    });
  });
  const viewKeys = new Map<string, object>();
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", origin).pathname;
    if (
      req.headers.host !== new URL(origin).host ||
      !["/api/v1/events", "/api/web/events"].includes(path) ||
      !adapter.authenticateWebSocket(req)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, (websocket) => {
      const device = adapter.authorize(req)!;
      if (path === "/api/web/events") {
        viewKeys.set(device.id, websocket);
        desktopConversationViews.registerWindow(websocket, true);
      }
      const connection = adapter.trackEvents(req, () => websocket.terminate());
      if (!connection) {
        websocket.terminate();
        return;
      }
      const send = (value: unknown) => {
        if (websocket.readyState !== 1) return;
        if (websocket.bufferedAmount > 4 * 1024 * 1024) websocket.terminate();
        else websocket.send(JSON.stringify(value));
      };
      const off =
        path === "/api/v1/events"
          ? connection.host.subscribe({ scope: "all" }, send)
          : options.control.subscribe((control) =>
              send({ kind: "control.changed", control }),
            );
      const offTerminals =
        path === "/api/web/events"
          ? options.terminals.subscribe((event) => {
              send(
                event.kind === "terminal.changed"
                  ? {
                      kind: "terminal.snapshot",
                      rows: options.terminals.list(),
                    }
                  : event,
              );
            })
          : () => {};
      send({ kind: "mobile.ready" });
      if (path === "/api/web/events")
        send({ kind: "terminal.snapshot", rows: options.terminals.list() });
      let alive = true;
      websocket.on("pong", () => {
        alive = true;
      });
      const heartbeat = setInterval(() => {
        if (!alive || !adapter.authorize(req)) websocket.terminate();
        else {
          alive = false;
          websocket.ping();
        }
      }, 15_000);
      heartbeat.unref();
      websocket.on("error", () => websocket.terminate());
      websocket.once("close", () => {
        clearInterval(heartbeat);
        off();
        offTerminals();
        connection.unsubscribe();
        desktopConversationViews.remove(websocket);
        if (viewKeys.get(device.id) === websocket) viewKeys.delete(device.id);
      });
    });
  });
  return api;
}
