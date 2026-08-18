/**
 * Desktop-chrome 操作者头像 IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：Renderer 只提交处理后的图片字节，
 * Main 写入 `%APPDATA%\omp-studio\profile`，永不把文件系统路径回传给 Renderer。
 */

export const CHROME_PROFILE_CHANNELS = {
  saveAvatar: "omp-studio:desktop:profile-avatar-save",
  loadAvatar: "omp-studio:desktop:profile-avatar-load",
  clearAvatar: "omp-studio:desktop:profile-avatar-clear",
} as const;

export type AvatarMime = "image/jpeg" | "image/webp" | "image/png";

export interface ChromeAvatarBytes {
  readonly mime: AvatarMime;
  readonly bytes: Uint8Array;
}

export interface ChromeAvatarSaveResult {
  readonly ok: true;
}

export const AVATAR_FILE_MAX_BYTES = 200_000;
export const AVATAR_FILE_MIN_BYTES = 24;

const MIME: ReadonlySet<string> = new Set(["image/jpeg", "image/webp", "image/png"]);

export function isAvatarMime(value: string): value is AvatarMime {
  return MIME.has(value);
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

export function avatarMagicOk(mime: AvatarMime, bytes: Uint8Array): boolean {
  if (bytes.byteLength < AVATAR_FILE_MIN_BYTES) return false;
  if (mime === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === "image/png") {
    return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  }
  return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
}

export function parseAvatarSaveInput(value: unknown): ChromeAvatarBytes | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { mime?: unknown; bytes?: unknown };
  if (typeof record.mime !== "string" || !isAvatarMime(record.mime)) return undefined;
  const bytes = asBytes(record.bytes);
  if (bytes === undefined) return undefined;
  if (bytes.byteLength < AVATAR_FILE_MIN_BYTES || bytes.byteLength > AVATAR_FILE_MAX_BYTES) return undefined;
  if (!avatarMagicOk(record.mime, bytes)) return undefined;
  return { mime: record.mime, bytes };
}
