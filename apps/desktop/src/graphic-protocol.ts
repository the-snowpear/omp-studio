import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".bin": "application/octet-stream",
};

// An opaque sandbox cannot import file: modules. Serve only the bundled viewer
// and static dependencies from a separate origin, never user artifacts or IPC.
export async function graphicAssetResponse(request: Request, rendererDist: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== "omp-graphics:" || url.hostname !== "viewer" || url.port || url.username || url.password || url.search || url.hash || !["GET", "HEAD"].includes(request.method)) {
    return new Response(null, { status: 400 });
  }
  try {
    const name = decodeURIComponent(url.pathname.slice(1));
    const mime = MIME[extname(name).toLowerCase()];
    if (!mime || !(name === "graphic-preview.html" || /^assets\/[\w.-]+\.(?:js|css)$/u.test(name) || /^graphics-xite\/(?:[\w.-]+\/)*[\w.-]+$/u.test(name))) {
      return new Response(null, { status: 404 });
    }
    const root = await realpath(rendererDist);
    const target = await realpath(resolve(root, name));
    const within = relative(root, target);
    if (within === ".." || within.startsWith("../") || within.startsWith("..\\") || isAbsolute(within)) return new Response(null, { status: 404 });
    const body = request.method === "HEAD" ? null : new Uint8Array(await readFile(target));
    return new Response(body, { headers: {
      "Content-Type": mime,
      "Access-Control-Allow-Origin": "null",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
