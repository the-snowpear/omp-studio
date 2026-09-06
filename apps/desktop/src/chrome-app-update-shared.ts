/**
 * Desktop-chrome 应用更新（GitHub Release 只读兼容检查）IPC 契约。
 *
 * Shared by Main and the sandboxed preload（无 Electron Main API）。
 * 这不是 Host / Studio Bridge 面：用于应用桌面客户端自身从 GitHub Releases 只读检测新版本。
 */

export const CHROME_APP_UPDATE_CHANNELS = {
  check: "omp-studio:desktop:chrome-app-update-check",
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

// Retired executable-download channels must never be registered again.
export const RETIRED_APP_UPDATE_CHANNELS = [
  "omp-studio:desktop:chrome-app-update-download",
  "omp-studio:desktop:chrome-app-update-install",
] as const;
