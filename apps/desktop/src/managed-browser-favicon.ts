/** Site icons for managed browser tabs. Icons travel to the renderer as small
 * `data:` URLs because its CSP only admits `data:` images, never remote ones. */
export const FAVICON_FETCH_LIMIT = 256 * 1024;
export const FAVICON_DATA_LIMIT = 32 * 1024;
export type FaviconShrink = (bytes: Uint8Array) => Uint8Array | undefined;
type FaviconFetch = (url: string, init: { signal: AbortSignal; credentials: "include" }) => Promise<Response>;

export function pickFaviconUrl(candidates: readonly string[]): string | undefined {
  return candidates.find(candidate => /^(?:https?:|data:image\/)/iu.test(candidate));
}

/** Image type from the leading bytes; servers often send icons with a wrong Content-Type. */
export function faviconType(bytes: Uint8Array): string | undefined {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (starts(0x00, 0x00, 0x01, 0x00)) return "image/x-icon";
  const head = new TextDecoder().decode(bytes.slice(0, 1024)).trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/iu.test(head)) return "image/svg+xml";
  return undefined;
}

/** PNG and JPEG are re-encoded as a 32px PNG; other formats pass through only when already small. */
export function faviconDataUrl(bytes: Uint8Array, shrink?: FaviconShrink): string | undefined {
  const type = faviconType(bytes);
  if (!type) return undefined;
  const raster = type === "image/png" || type === "image/jpeg";
  const output = raster && shrink ? shrink(bytes) : bytes;
  if (!output?.length) return undefined;
  const url = `data:${raster && shrink ? "image/png" : type};base64,${Buffer.from(output).toString("base64")}`;
  return url.length <= FAVICON_DATA_LIMIT ? url : undefined;
}

export async function loadFavicon(url: string, fetcher: FaviconFetch, signal: AbortSignal): Promise<Uint8Array | undefined> {
  if (/^data:/iu.test(url)) {
    const match = /^data:[^,]*?(;base64)?,(.*)$/isu.exec(url);
    if (!match) return undefined;
    const bytes = match[1] ? Buffer.from(match[2]!, "base64") : Buffer.from(decodeURIComponent(match[2]!), "utf8");
    return bytes.length <= FAVICON_FETCH_LIMIT ? new Uint8Array(bytes) : undefined;
  }
  const response = await fetcher(url, { signal, credentials: "include" });
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > FAVICON_FETCH_LIMIT) return undefined;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.length && bytes.length <= FAVICON_FETCH_LIMIT ? bytes : undefined;
}
