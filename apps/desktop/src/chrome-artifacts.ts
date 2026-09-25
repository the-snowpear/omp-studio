import { createReadStream } from "node:fs";
import { copyFile, lstat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { ARTIFACT_KINDS, validateArtifactIdInput } from "@omp-studio/studio-protocol";
import type { ArtifactLibrary } from "@omp-studio/studio-host";
import type { ChromeImageIpcMain, ChromeImageSender } from "./chrome-image.js";
import { CHROME_ARTIFACT_CHANNELS, type ArtifactFileResult, type ArtifactImportInput } from "./chrome-artifacts-shared.js";

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/opus", ".flac": "audio/flac", ".txt": "text/plain", ".json": "application/json", ".jsonl": "application/x-ndjson", ".ompcast": "application/x-ompcast", ".studiocast": "application/x-studio-terminalcast" };

export function registerArtifactIpc(options: {
  ipcMain: ChromeImageIpcMain;
  isTrustedSender(sender: ChromeImageSender): boolean;
  library(): ArtifactLibrary;
  chooseDirectory(sender: ChromeImageSender): Promise<string | undefined>;
  chooseFile(sender: ChromeImageSender, kind: ArtifactImportInput["kind"]): Promise<string | undefined>;
  chooseExport(sender: ChromeImageSender, name: string): Promise<string | undefined>;
}): { dispose(): void } {
  const register = (channel: string, action: (sender: ChromeImageSender, input: unknown) => Promise<ArtifactFileResult>) => {
    options.ipcMain.handle(channel, async (event, input) => {
      if (event.sender.isDestroyed() || !options.isTrustedSender(event.sender)) throw new Error("Untrusted artifact request");
      try { return await action(event.sender, input); }
      catch { return { ok: false, message: "Artifact operation failed. Check the selected file or storage location." } satisfies ArtifactFileResult; }
    });
  };
  register(CHROME_ARTIFACT_CHANNELS.chooseDirectory, async sender => {
    const directory = await options.chooseDirectory(sender);
    if (!directory) return { ok: true, cancelled: true };
    return { ok: true, cancelled: false, storage: await options.library().setDirectory(directory) };
  });
  register(CHROME_ARTIFACT_CHANNELS.import, async (sender, raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid artifact import");
    const input = raw as ArtifactImportInput;
    if (Object.keys(input).some(key => !["kind", "workspaceId", "sessionId"].includes(key)) || !ARTIFACT_KINDS.includes(input.kind)) throw new Error("Invalid artifact import");
    for (const id of [input.workspaceId, input.sessionId]) if (id !== undefined && (typeof id !== "string" || !id.trim() || id.length > 512 || /[\u0000-\u001f]/u.test(id))) throw new Error("Invalid artifact scope");
    const file = await options.chooseFile(sender, input.kind);
    if (!file) return { ok: true, cancelled: true };
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024 * 1024) throw new Error("Invalid artifact file");
    const mimeType = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
    if (["image", "audio", "video"].includes(input.kind) && !mimeType.startsWith(input.kind + "/")) throw new Error("File type does not match artifact type");
    const artifact = await options.library().register({ ...input, name: basename(file), mimeType }, createReadStream(file));
    return { ok: true, cancelled: false, artifact };
  });
  register(CHROME_ARTIFACT_CHANNELS.export, async (sender, raw) => {
    validateArtifactIdInput(raw);
    const artifact = await options.library().resolve(raw.artifactId);
    const destination = await options.chooseExport(sender, artifact.record.name);
    if (!destination) return { ok: true, cancelled: true };
    await copyFile(artifact.path, destination);
    return { ok: true, cancelled: false };
  });
  return { dispose: () => Object.values(CHROME_ARTIFACT_CHANNELS).forEach(channel => options.ipcMain.removeHandler(channel)) };
}

/** Streams only catalogued payloads; large media never becomes a Bridge JSON/base64 body. */
export async function artifactResponse(request: Request, library: ArtifactLibrary, allowedOrigin?: string): Promise<Response> {
  try {
    const origin = request.headers.get("origin");
    if (allowedOrigin && origin && origin !== allowedOrigin) return new Response(null, { status: 403 });
    const url = new URL(request.url);
    if (url.protocol !== "omp-artifact:" || url.hostname !== "library" || url.search || url.hash || url.username || url.password || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 400 });
    const artifactId = url.pathname.slice(1);
    validateArtifactIdInput({ artifactId });
    const artifact = await library.resolve(artifactId);
    const total = artifact.record.bytes;
    let start = 0;
    let end = total - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      if (!match[1]) start = Math.max(0, total - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= total || start < 0) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    const headers: Record<string, string> = {
      "Content-Type": artifact.record.mimeType,
      "Content-Length": String(Math.max(0, end - start + 1)),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, "Vary": "Origin" } : {}),
    };
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    const body = request.method === "HEAD" || total === 0 ? null : Readable.toWeb(createReadStream(artifact.path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status: range ? 206 : 200, headers });
  } catch { return new Response(null, { status: 404 }); }
}
