/**
 * Desktop-chrome 图片复制 / 另存为 IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：Renderer 只提交图片字节与建议文件名，
 * Main 写入系统剪贴板或用户在另存为对话框里选的路径，永不把路径回传。
 */

export const CHROME_IMAGE_CHANNELS = {
  copyImage: "omp-studio:desktop:image-copy",
  saveImage: "omp-studio:desktop:image-save",
} as const;

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type ChromeImageMime = (typeof IMAGE_MIME_TYPES)[number];

/** IPC safety cap for copy/save, not a composer ingest limit. */
export const IMAGE_FILE_MAX_BYTES = 64 * 1024 * 1024;
export const IMAGE_FILE_MIN_BYTES = 12;
const SUGGESTED_NAME_MAX = 80;

export interface ChromeImageInput {
  readonly mime: ChromeImageMime;
  readonly bytes: Uint8Array;
  readonly suggestedName: string;
}

export type ChromeImageResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly cancelled: true }
  | { readonly ok: false; readonly message: string };

const MIME: ReadonlySet<string> = new Set(IMAGE_MIME_TYPES);

export function isChromeImageMime(value: string): value is ChromeImageMime {
  return MIME.has(value);
}

export function extensionForImageMime(mime: ChromeImageMime): string {
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  return ".png";
}

export function sanitizeSuggestedName(value: string, mime: ChromeImageMime): string {
  const ext = extensionForImageMime(mime);
  const leaf = value.replaceAll("\\", "/").split("/").pop() ?? "";
  const stripped = leaf.replace(/[<>:"|?*\u0000-\u001f]/gu, "").trim();
  const withoutExt = stripped.replace(/\.[a-z0-9]+$/iu, "");
  const stem = (withoutExt.length > 0 ? withoutExt : "image").slice(0, SUGGESTED_NAME_MAX);
  return `${stem}${ext}`;
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

export function imageMagicOk(mime: ChromeImageMime, bytes: Uint8Array): boolean {
  if (bytes.byteLength < IMAGE_FILE_MIN_BYTES) return false;
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  if (mime === "image/gif") {
    return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
      && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61;
  }
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export function parseChromeImageInput(value: unknown): ChromeImageInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { mime?: unknown; bytes?: unknown; suggestedName?: unknown };
  if (typeof record.mime !== "string" || !isChromeImageMime(record.mime)) return undefined;
  const bytes = asBytes(record.bytes);
  if (bytes === undefined) return undefined;
  if (bytes.byteLength < IMAGE_FILE_MIN_BYTES || bytes.byteLength > IMAGE_FILE_MAX_BYTES) return undefined;
  if (!imageMagicOk(record.mime, bytes)) return undefined;
  const rawName = typeof record.suggestedName === "string" ? record.suggestedName : "image";
  return { mime: record.mime, bytes, suggestedName: sanitizeSuggestedName(rawName, record.mime) };
}
