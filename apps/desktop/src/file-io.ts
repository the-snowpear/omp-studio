import { constants } from "node:fs";
import { access, lstat, open, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { FileEncoding, SystemFileChunkInput, SystemFileInfo, SystemFileText, SystemFileWrite } from "@omp-studio/client-contract";
import { desktopText } from "./desktop-language-shared.js";

export const FILE_CHUNK_BYTES = 512 * 1024;
export const EDITABLE_FILE_BYTES = 8 * 1024 * 1024;
const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", ogv: "video/ogg", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docm: "application/vnd.ms-word.document.macroEnabled.12", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12", odp: "application/vnd.oasis.opendocument.presentation",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12", xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12", ods: "application/vnd.oasis.opendocument.spreadsheet", csv: "text/csv", md: "text/markdown", html: "text/html", htm: "text/html",
};
export const fileMime = (path: string) => MIME[extname(path).slice(1).toLowerCase()] ?? "text/plain";
const versionOf = (info: { size: number; mtimeMs: number; ctimeMs: number; ino: number }) => `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`;

/** Callers own path resolution and containment; both file services share formats and conflicts. */
export async function inspectFile(target: string): Promise<SystemFileInfo> {
  const info = await lstat(target);
  if (!info.isFile()) throw new Error(desktopText("此路径不是文件", "Path is not a file"));
  const writable = await access(target, constants.W_OK).then(() => true, () => false);
  const identity = process.platform === "win32" ? target.toLowerCase() : target;
  return { path: target, id: createHash("sha256").update(identity).digest("hex"), name: basename(target), mime: fileMime(target), size: info.size, version: versionOf(info), writable };
}

export async function readFileText<F extends SystemFileInfo>(target: string, inspect: () => Promise<F>): Promise<Omit<SystemFileText, "file"> & { file: F }> {
  const handle = await open(target, "r");
  try {
    const before = await handle.stat();
    if (before.size > EDITABLE_FILE_BYTES) throw new Error(desktopText("文件超过内置编辑器的 8 MiB 编辑范围，请下载或使用外部编辑器", "File exceeds the 8 MiB built-in editor limit; download it or use an external editor"));
    const bytes = await handle.readFile();
    const encoding: FileEncoding = bytes[0] === 255 && bytes[1] === 254 ? "utf16le" : bytes[0] === 254 && bytes[1] === 255 ? "utf16be" : "utf8";
    const bom = encoding !== "utf8" || bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
    const body = bytes.subarray(bom ? encoding === "utf8" ? 3 : 2 : 0);
    if (encoding === "utf8" && body.includes(0)) throw new Error(desktopText("此文件为二进制，无法作为文本编辑", "This file appears to be binary and cannot be edited as text"));
    let text: string;
    try { text = new TextDecoder(encoding === "utf8" ? "utf-8" : encoding === "utf16le" ? "utf-16le" : "utf-16be", { fatal: true }).decode(body); }
    catch { throw new Error(desktopText("当前支持 UTF-8 和带 BOM 的 UTF-16 文本；请使用外部编辑器转换编码", "Only UTF-8 and UTF-16 with BOM text are supported; use an external editor to convert the encoding")); }
    const file = await inspect();
    if (file.version !== versionOf(before)) throw new Error(desktopText("文件在读取时发生变化，请重新加载", "File changed while reading; reload and try again"));
    return { file, text: text.replace(/\r\n/g, "\n"), encoding, bom, lineEnding: text.includes("\r\n") ? "crlf" : "lf" };
  } finally { await handle.close(); }
}

export async function readFileChunk(target: string, input: SystemFileChunkInput) {
  if (!Number.isSafeInteger(input.offset) || input.offset < 0 || !Number.isSafeInteger(input.length) || input.length < 1 || input.length > FILE_CHUNK_BYTES) throw new Error("Invalid file range");
  const handle = await open(target, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(desktopText("此路径不是文件", "Path is not a file"));
    if (versionOf(info) !== input.version) throw new Error(desktopText("文件已经变化，请重新加载", "File has changed; reload and try again"));
    const buffer = Buffer.alloc(Math.min(input.length, Math.max(0, info.size - input.offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
    return { data: buffer.subarray(0, bytesRead).toString("base64"), bytes: bytesRead };
  } finally { await handle.close(); }
}

// One queue per canonical file, including writes through different services/workspaces.
const writes = new Map<string, Promise<unknown>>();
export async function writeFileText<F extends SystemFileInfo>(target: string, input: SystemFileWrite, inspect: () => Promise<F>): Promise<{ saved: true; file: F } | { saved: false; conflict: true; file: F }> {
  const key = process.platform === "win32" ? target.toLowerCase() : target;
  const previous = writes.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const file = await inspect();
    if (file.version !== input.expectedVersion) return { saved: false as const, conflict: true as const, file };
    if (file.size > EDITABLE_FILE_BYTES) throw new Error(desktopText("文件超过内置编辑器的 8 MiB 编辑范围，请使用外部编辑器", "File exceeds the 8 MiB built-in editor limit; open it in an external editor"));
    const text = input.text.replace(/\r\n/g, "\n").replace(/\n/g, input.lineEnding === "crlf" ? "\r\n" : "\n");
    let bytes = Buffer.from(text, input.encoding === "utf8" ? "utf8" : "utf16le");
    if (input.encoding === "utf16be") bytes.swap16();
    if (input.bom) bytes = Buffer.concat([Buffer.from(input.encoding === "utf8" ? [239, 187, 191] : input.encoding === "utf16le" ? [255, 254] : [254, 255]), bytes]);
    if (bytes.length > EDITABLE_FILE_BYTES) throw new Error(desktopText("保存内容超过 8 MiB，请使用外部编辑器", "Saved content exceeds 8 MiB; use an external editor"));
    const temporary = resolve(dirname(target), `.omp-save-${randomUUID()}`);
    try {
      const mode = (await lstat(target)).mode;
      await writeFile(temporary, bytes, { flag: "wx", mode });
      const current = await inspect();
      if (current.version !== input.expectedVersion) return { saved: false as const, conflict: true as const, file: current };
      await rename(temporary, target);
      return { saved: true as const, file: await inspect() };
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  });
  writes.set(key, operation);
  try { return await operation; } finally { if (writes.get(key) === operation) writes.delete(key); }
}
