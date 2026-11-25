import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { LoopbackWebAdapter } from "@omp-studio/transport-web";
import type { HostControl } from "./control.js";
import { sendJson } from "./server.js";

/** Fixed-target authenticated proxy for the native dashboard's relative assets and API. */
export async function serveStatistics(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: LoopbackWebAdapter,
  control: HostControl,
): Promise<void> {
  const mutate = req.method !== "GET" && req.method !== "HEAD";
  const device = adapter.authorize(req, mutate);
  if (!device) return sendJson(res, 401, { error: "unauthenticated" });
  if (mutate) control.assert(device.id, req.headers["x-studio-control"]);
  const path = (req.url ?? "/").replace(/^\/stats(?=\/)/u, "");
  const abort = new AbortController();
  res.once("close", () => abort.abort());
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "x-omp-stats-action", "if-none-match"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const body: Buffer[] = [];
  let size = 0;
  if (mutate)
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("request_too_large");
      body.push(Buffer.from(chunk));
    }
  if (mutate) control.assert(device.id, req.headers["x-studio-control"]);
  const response = await fetch(`http://127.0.0.1:3847${path}`, {
    method: req.method ?? "GET",
    headers,
    redirect: "error",
    signal: abort.signal,
    ...(mutate ? { body: Buffer.concat(body) } : {}),
  });
  const type =
    response.headers.get("content-type") ?? "application/octet-stream";
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", type);
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'",
  );
  if (type.includes("text/html")) {
    const html = await response.text();
    res.writeHead(response.status);
    res.end(
      html
        .replace(/(src|href)="\/(?!\/)/gu, '$1="/stats/')
        .replace(
          "<head>",
          '<head><base href="/stats/"><script src="/stats-bridge.js"></script>',
        ),
    );
    return;
  }
  res.writeHead(response.status);
  if (response.body)
    Readable.fromWeb(
      response.body as import("node:stream/web").ReadableStream,
    ).pipe(res);
  else res.end();
}
