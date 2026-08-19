/**
 * Desktop-chrome 应用更新（GitHub Release 全量安装包）IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：用于应用桌面客户端自身从 GitHub Releases 检测新版本与下载全量安装包。
 */

export const CHROME_APP_UPDATE_CHANNELS = {
  check: "omp-studio:desktop:chrome-app-update-check",
  download: "omp-studio:desktop:chrome-app-update-download",
  install: "omp-studio:desktop:chrome-app-update-install",
} as const;

export interface AppUpdateInfo {
  readonly available: boolean;
  readonly currentVersion: string;
  readonly version?: string | undefined;
  readonly name?: string | undefined;
  readonly releaseNotes?: string | undefined;
  readonly publishedAt?: string | undefined;
  readonly htmlUrl?: string | undefined;
  readonly downloadUrl?: string | undefined;
  readonly assetName?: string | undefined;
  readonly assetSize?: number | undefined;
}

export interface ChromeAppUpdateDownloadInput {
  readonly url: string;
}

export interface ChromeAppUpdateInstallInput {
  readonly filePath: string;
}

export type ChromeAppUpdateDownloadResult =
  | { readonly ok: true; readonly filePath: string }
  | { readonly ok: false; readonly message: string };

export type ChromeAppUpdateInstallResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

const MAX_URL_LEN = 2048;
const MAX_PATH_LEN = 4096;

export function parseChromeAppUpdateDownloadInput(value: unknown): ChromeAppUpdateDownloadInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { url?: unknown };
  if (typeof record.url !== "string") return undefined;
  const raw = record.url.trim();
  if (raw.length === 0 || raw.length > MAX_URL_LEN) return undefined;
  if (/[\u0000-\u001F\u007F]/u.test(raw)) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:") return undefined;
    return { url: parsed.href };
  } catch {
    return undefined;
  }
}

export function parseChromeAppUpdateInstallInput(value: unknown): ChromeAppUpdateInstallInput | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as { filePath?: unknown };
  if (typeof record.filePath !== "string") return undefined;
  const raw = record.filePath.trim();
  if (raw.length === 0 || raw.length > MAX_PATH_LEN) return undefined;
  if (/[\u0000-\u001F\u007F]/u.test(raw)) return undefined;
  return { filePath: raw };
}
